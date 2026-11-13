import unittest
from eligibility_reference import assess, clarification_fixture_errors, CONTROL_FLAGS

BASE = dict(purpose='current_decision', write_requested=False, principal_authorized=True,
            packet_trusted=True, same_trip_runtime_revision=True,
            complete_required_context=True, current_time_and_fact_scope=True,
            contested_fact_used_for_precise_adoption=False, old_grant_used=False,
            retained_evidence_read=False, business_receipt_unknown=False,
            repeat_business_submit=False, claim_saved=False, checkpoint_ack=False)
RESTORE = dict(BASE, purpose='restore_commit', write_requested=True, source_version_authorized=True,
               current_impact_and_unknowns_shown=True, exact_current_scope_grant=True,
               current_constraints_pass=True, confirmed_experience_protected=True,
               trusted_current_actor=True, ts_guard_accepted=True)

class EligibilityTests(unittest.TestCase):
    def test_eligible_restore_requires_every_proof(self):
        self.assertTrue(assess(RESTORE)['eligible_for_requested_path'])
        for key in ('source_version_authorized','current_impact_and_unknowns_shown',
                    'exact_current_scope_grant','current_constraints_pass',
                    'confirmed_experience_protected','trusted_current_actor','ts_guard_accepted'):
            for value in (False, None):
                with self.subTest(key=key, value=value):
                    self.assertFalse(assess(dict(RESTORE, **{key:value}))['eligible_for_requested_path'])
    def test_missing_write_actor_and_guard_fails_closed(self):
        for key in ('write_requested','trusted_current_actor','ts_guard_accepted'):
            e=RESTORE.copy();del e[key]
            with self.subTest(key=key): self.assertFalse(assess(e)['eligible_for_requested_path'])
        e=RESTORE.copy()
        for key in ('write_requested','trusted_current_actor','ts_guard_accepted'): del e[key]
        self.assertFalse(assess(e)['eligible_for_requested_path'])
    def test_invalid_purpose_and_write_flag(self):
        for purpose in (None, '', 'anything', 1, [], {}):
            self.assertIn('unknown_purpose',assess(dict(BASE,purpose=purpose))['reasons'])
        for value in (None, 'true', 1):
            self.assertIn('invalid_control:write_requested',assess(dict(BASE,write_requested=value))['reasons'])
        self.assertIn('restore_commit_requires_write',assess(dict(RESTORE,write_requested=False))['reasons'])
    def test_untrusted_or_stale_packets(self):
        for key in ('principal_authorized','packet_trusted','same_trip_runtime_revision','complete_required_context','current_time_and_fact_scope'):
            for value in (False, None, 'true'):
                with self.subTest(key=key,value=value): self.assertIn(key, assess(dict(BASE, **{key:value}))['reasons'])
    def test_read_only_paths_cannot_write(self):
        for purpose in ('historical_view','hypothesis_view','restore_preview'):
            self.assertIn('read_only_purpose', assess(dict(BASE,purpose=purpose,write_requested=True))['reasons'])
            self.assertTrue(assess(dict(BASE,purpose=purpose,write_requested=False))['eligible_for_requested_path'])
    def test_contested_facts_and_old_grant(self):
        for flag,reason in [('contested_fact_used_for_precise_adoption','contested_fact'),('old_grant_used','old_grant')]:
            self.assertIn(reason,assess(dict(RESTORE, **{flag:True}))['reasons'])
    def test_deleted_or_unauthorized_evidence(self):
        for key in ('evidence_authorized','evidence_not_deleted_or_expired'):
            self.assertIn(key,assess(dict(BASE,retained_evidence_read=True,**{key:False}))['reasons'])
    def test_unknown_receipt_and_checkpoint_ack(self):
        self.assertIn('query_authoritative_receipt_first',assess(dict(BASE,business_receipt_unknown=True,repeat_business_submit=True))['reasons'])
        self.assertIn('missing_checkpoint_ack',assess(dict(BASE,claim_saved=True))['reasons'])
        self.assertTrue(assess(dict(BASE,claim_saved=True,checkpoint_ack=True))['eligible_for_requested_path'])
    def test_clarification_choices_must_allow_other_and_free_input(self):
        valid=dict(reasonable_candidates=True,none_of_these_available=True,free_input_available=True,user_rejected_all=False)
        self.assertEqual([],clarification_fixture_errors(valid))
        for key in ('none_of_these_available','free_input_available'):
            self.assertTrue(clarification_fixture_errors(dict(valid,**{key:False})))
    def test_open_question_when_no_reasonable_choices(self):
        valid=dict(reasonable_candidates=False,open_question=True,invented_options=False,free_input_available=True,user_rejected_all=False)
        self.assertEqual([],clarification_fixture_errors(valid))
        self.assertIn('open_question_without_invented_options',clarification_fixture_errors(dict(valid,invented_options=True)))
        self.assertIn('open_question_without_invented_options',clarification_fixture_errors(dict(valid,open_question=False)))
    def test_all_choices_rejected_keeps_compatible_help(self):
        e=dict(reasonable_candidates=True,none_of_these_available=True,free_input_available=True,user_rejected_all=True,continue_compatible_help=True)
        self.assertEqual([],clarification_fixture_errors(e))
        self.assertIn('continue_after_rejection',clarification_fixture_errors(dict(e,continue_compatible_help=False)))

    def test_all_controls_required_and_strict_boolean(self):
        for key in sorted(CONTROL_FLAGS):
            e=BASE.copy();del e[key]
            with self.subTest(key=key, case='missing'):
                self.assertIn('missing_control:'+key, assess(e)['reasons'])
            for value in (None, 'true', 'false', 0, 1, [], {}):
                with self.subTest(key=key,value=value):
                    self.assertIn('invalid_control:'+key,assess(dict(BASE,**{key:value}))['reasons'])
    def test_unknown_fields_and_invalid_conditional_proofs(self):
        self.assertIn('invalid_input',assess(None)['reasons'])
        self.assertIn('unknown_field:old_grant_use',assess(dict(BASE,old_grant_use=True))['reasons'])
        self.assertFalse(assess({**BASE, 7: True, 'bogus': False})['eligible_for_requested_path'])
        for key in ('trusted_current_actor','ts_guard_accepted','evidence_authorized',
                    'evidence_not_deleted_or_expired','source_version_authorized'):
            with self.subTest(key=key):
                self.assertIn('invalid_proof:'+key,assess(dict(BASE,**{key:'true'}))['reasons'])
        for key in ('evidence_authorized','evidence_not_deleted_or_expired'):
            self.assertIn(key, assess(dict(BASE,retained_evidence_read=True))['reasons'])
    def test_clarification_rejects_unknown_and_invalid_controls(self):
        e=dict(reasonable_candidates=True,free_input_available=True,none_of_these_available=True,user_rejected_all=False)
        self.assertIn('invalid_input',clarification_fixture_errors(None))
        self.assertIn('unknown_field:typo',clarification_fixture_errors(dict(e,typo=True)))
        self.assertTrue(clarification_fixture_errors({**e, 7: True, 'bogus': False}))
        for key in ('reasonable_candidates','free_input_available','user_rejected_all'):
            missing=e.copy();del missing[key]
            self.assertIn('missing_control:'+key,clarification_fixture_errors(missing))
        for key in ('reasonable_candidates','free_input_available','user_rejected_all','none_of_these_available'):
            self.assertIn('invalid_control:'+key,clarification_fixture_errors(dict(e,**{key:'true'})))
        self.assertIn('continue_after_rejection',clarification_fixture_errors(dict(e,user_rejected_all=True)))

if __name__ == '__main__': unittest.main()
