"""UX-02 executable boundary tests; synthetic state, not UI/provider acceptance."""
import unittest
from copy import deepcopy
from datetime import timedelta
from tripstate.engine import Store, Actor
from tripstate.fixtures import initial_state, NOW, request, adopt, create_command, entity, candidate
from tripstate.rules import index, RuleError
from tripstate.restoration import restoration_request

USER = Actor('user', 'user-demo')
MODEL = Actor('model', 'model-demo')

class UX02Tests(unittest.TestCase):
    def setUp(self):
        self.store = Store(initial_state(), clock=lambda: NOW)
        self.assertEqual(self.store.submit(request(self.store, adopt()), USER)['outcome'], 'applied')
        current = deepcopy(index(self.store.get_state())['skeleton-a'])
        current.update(id='current-plan', parent_id='skeleton-a')
        current['stops'][0]['nights'] = 1
        self.assertEqual(self.store.submit(request(self.store, create_command(current), adopt('current-plan'), key='current'), USER)['outcome'], 'applied')

    def body(self, **kw):
        args = dict(source_id='skeleton-a', source_version=index(self.store.get_state())['skeleton-a']['version'], new_id='restored-plan', expected_revision=self.store.get_state()['revision'],
                    idempotency_key='restore', input=dict(kind='dialogue', reference='new-request', text='恢复已展示的旧方案', target_ids=[]),
                    reason='用户本轮明确恢复', acknowledge_unknowns=True)
        args.update(kw)
        if 'source_id' in kw and 'source_version' not in kw: args['source_version'] = index(self.store.get_state())[kw['source_id']]['version']
        return restoration_request(self.store.get_state(), history=self.store.get_history(), **args)

    def test_older_version_of_same_candidate_is_resolved_from_applied_history(self):
        source = deepcopy(index(self.store.get_state())['skeleton-a']); source.update(id='versioned-candidate', status='active')
        self.assertEqual(self.store.submit(request(self.store, create_command(source), key='candidate-v1'), USER)['outcome'], 'applied')
        v1 = deepcopy(index(self.store.get_state())['versioned-candidate']); stops = deepcopy(v1['stops']); stops[1]['nights'] = 1
        self.assertEqual(self.store.submit(request(self.store, dict(op='revise', object_type='Skeleton', id='versioned-candidate', changes=dict(stops=stops)), key='candidate-v2'), USER)['outcome'], 'applied')
        body = self.body(source_id='versioned-candidate', source_version=v1['version'])
        self.assertEqual(body['commands'][0]['data']['stops'][1]['nights'], v1['stops'][1]['nights'])
        self.assertIn('version=' + str(v1['version']), body['reason'])
        self.assertEqual(self.store.submit(body, USER)['outcome'], 'applied')

    def test_restoration_preview_adapter_is_read_only_and_rejects_actor_fields(self):
        from tripstate.api import dispatch
        body = dict(source_id='skeleton-a', source_version=index(self.store.get_state())['skeleton-a']['version'], new_id='restored-plan', expected_revision=self.store.get_state()['revision'],
                    idempotency_key='preview-adapter', input=dict(kind='dialogue', reference='fresh-input', text='恢复', target_ids=[]),
                    reason='本轮明确恢复', acknowledge_unknowns=True)
        before, history = self.store.get_state(), self.store.get_history()
        path = '/trips/' + before['trip_id'] + '/restorations/preview'
        status, result = dispatch(self.store, 'POST', path, body, USER)
        self.assertEqual(status, 200); self.assertEqual(result['preview']['outcome'], 'preview')
        self.assertEqual(self.store.get_state(), before); self.assertEqual(self.store.get_history(), history)
        self.assertEqual(dispatch(self.store, 'POST', path, dict(body, actor_id='forged'), USER)[0], 422)

    def test_whole_preview_is_read_only_then_new_version_with_current_parent_and_idempotency(self):
        body = self.body(); before = self.store.get_state(); history = self.store.get_history()
        preview = self.store.preview(body, USER)
        self.assertEqual(preview['outcome'], 'preview'); self.assertEqual(self.store.get_state(), before)
        self.assertEqual(self.store.get_history(), history)
        response = self.store.submit(body, USER)
        self.assertEqual(response['outcome'], 'applied'); self.assertEqual(self.store.submit(body, USER), response)
        after = self.store.get_state(); restored = index(after)['restored-plan']
        self.assertEqual(restored['parent_id'], 'current-plan'); self.assertEqual(restored['stops'][0]['nights'], 2)
        self.assertEqual(index(after)['skeleton-a'], index(before)['skeleton-a'])
        self.assertEqual(len(self.store.get_history()['changes']), len(history['changes']) + 1)
        self.assertEqual(index(after)['constraint-dates'], index(before)['constraint-dates'])

    def test_saved_important_candidate_need_not_have_been_adopted(self):
        source = deepcopy(index(self.store.get_state())['skeleton-a'])
        source.update(id='saved-candidate', status='active')
        self.assertEqual(self.store.submit(request(self.store, create_command(source), key='save-candidate'), USER)['outcome'], 'applied')
        self.assertFalse(any(o['type'] == 'Decision' and o['subject_id'] == 'saved-candidate' for o in self.store.get_state()['objects']))
        self.assertEqual(self.store.submit(self.body(source_id='saved-candidate'), USER)['outcome'], 'applied')

    def test_city_restore_changes_selected_stay_and_preserves_other_city(self):
        before = self.store.get_state(); body = self.body(city_id='luxor')
        created = body['commands'][0]['data']
        self.assertEqual(created['stops'][0]['nights'], 1); self.assertEqual(created['stops'][1]['nights'], 2)
        self.assertEqual(self.store.submit(body, USER)['outcome'], 'applied')
        for oid in ['constraint-dates', 'pref-culture', 'candidate-aswan']:
            self.assertEqual(index(self.store.get_state())[oid], index(before)[oid])

    def test_current_hard_constraint_blocks_restoration_without_writing(self):
        self.store.submit(request(self.store, dict(op='revise', object_type='Constraint', id='constraint-nights', changes=dict(value=dict(kind='duration', maximum_nights=3))), key='hard'), USER)
        before = self.store.get_state(); history = self.store.get_history()
        response = self.store.submit(self.body(), USER)
        self.assertEqual(response['errors'][0]['code'], 'HARD_CONFLICT')
        self.assertEqual(self.store.get_state(), before); self.assertEqual(self.store.get_history(), history)

    def test_expired_historical_evidence_is_recomputed_and_unknown_requires_ack(self):
        self.store.clock = lambda: NOW + timedelta(days=40)
        denied = self.store.submit(self.body(acknowledge_unknowns=False), USER)
        self.assertEqual(denied['errors'][0]['code'], 'UNKNOWN_ACK')
        response = self.store.submit(self.body(), USER)
        self.assertEqual(response['outcome'], 'applied')
        self.assertNotEqual(index(self.store.get_state())['restored-plan']['assessment']['status'], 'verified')

    def test_stale_base_and_model_submission_do_not_apply_without_current_authorization(self):
        body = self.body(); self.store.submit(request(self.store, dict(op='revise', object_type='Preference', id='pref-culture', changes=dict(expression='新表达')), key='intervening'), USER)
        self.assertEqual(self.store.submit(body, USER)['outcome'], 'conflict')
        before = self.store.get_state(); response = self.store.submit(self.body(idempotency_key='model'), MODEL)
        self.assertEqual(response['outcome'], 'pending_confirmation'); self.assertEqual(self.store.get_state(), before)

    def test_failure_preserves_current_plan_and_draft_request_is_reusable(self):
        body = self.body(); before = self.store.get_state(); history = self.store.get_history()
        self.store.before_commit = lambda: (_ for _ in ()).throw(RuntimeError('injected'))
        self.assertEqual(self.store.submit(body, USER)['errors'][0]['code'], 'INTERNAL_FAILURE')
        self.assertEqual(self.store.get_state(), before); self.assertEqual(self.store.get_history(), history)
        self.store.before_commit = None
        self.assertEqual(self.store.submit(body, USER)['outcome'], 'applied')

    def test_city_absent_in_current_requires_explicit_position(self):
        state = self.store.get_state(); old = deepcopy(index(state)['current-plan'])
        old.update(id='without-luxor', parent_id='current-plan', stops=[dict(entity_id='cairo', nights=1)], connections=[], cost_fact_ids=[])
        self.assertEqual(self.store.submit(request(self.store, create_command(old), adopt('without-luxor'), key='remove'), USER)['outcome'], 'applied')
        with self.assertRaises(RuleError) as caught: self.body(city_id='luxor')
        self.assertEqual(caught.exception.code, 'RESTORE_POSITION_REQUIRED')
        self.assertEqual(self.body(city_id='luxor', insert_at=1)['commands'][0]['data']['stops'][1]['entity_id'], 'luxor')

    def test_confirmed_experience_city_cannot_be_removed_implicitly(self):
        e = entity('temple', '合成神庙', 'experience', 'luxor')
        c = candidate('candidate-temple', 'temple'); c['candidate_kind'] = 'experience'
        self.assertEqual(self.store.submit(request(self.store, create_command(e), key='catalog'), Actor('system','catalog'))['outcome'], 'applied')
        self.store.submit(request(self.store, create_command(c), dict(op='decide_candidate', id=c['id'], value='accept'), key='experience'), USER)
        old = deepcopy(index(self.store.get_state())['current-plan'])
        old.update(id='drop-experience', parent_id='current-plan', stops=[dict(entity_id='cairo', nights=1)], connections=[], cost_fact_ids=[])
        before = self.store.get_state()
        response = self.store.submit(request(self.store, create_command(old), adopt(old['id']), key='drop'), USER)
        self.assertEqual(response['errors'][0]['code'], 'CONFIRMED_CANDIDATE'); self.assertEqual(self.store.get_state(), before)
