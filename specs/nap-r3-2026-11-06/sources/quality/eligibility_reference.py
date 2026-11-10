"""Synthetic prerequisite oracle only; NOT authentication, runtime or a safety boundary.

The caller supplies a complete observation: all control flags below must be explicit
literal booleans. Required proof fields depend on purpose/actions; optional proofs, if
supplied, must also be booleans. Missing/unknown is not an observed false. Proofs must
be independently verified by the trusted host, TS and DC; this code verifies neither.
"""

PURPOSES = frozenset(('current_decision', 'historical_view', 'hypothesis_view',
                      'restore_preview', 'restore_commit'))
READ_ONLY = frozenset(('historical_view', 'hypothesis_view', 'restore_preview'))
CONTROL_FLAGS = frozenset(('write_requested', 'contested_fact_used_for_precise_adoption',
                           'old_grant_used', 'retained_evidence_read',
                           'business_receipt_unknown', 'repeat_business_submit',
                           'claim_saved', 'checkpoint_ack'))
BASE_PROOFS = frozenset(('principal_authorized', 'packet_trusted', 'same_trip_runtime_revision',
                         'complete_required_context', 'current_time_and_fact_scope'))
RESTORE_PROOFS = frozenset(('source_version_authorized', 'current_impact_and_unknowns_shown',
                            'exact_current_scope_grant', 'current_constraints_pass',
                            'confirmed_experience_protected'))
WRITE_PROOFS = frozenset(('trusted_current_actor', 'ts_guard_accepted'))
EVIDENCE_PROOFS = frozenset(('evidence_authorized', 'evidence_not_deleted_or_expired'))
PROOFS = BASE_PROOFS | RESTORE_PROOFS | WRITE_PROOFS | EVIDENCE_PROOFS
KNOWN_FIELDS = CONTROL_FLAGS | PROOFS | {'purpose'}


def assess(e):
    if not isinstance(e, dict):
        return {'eligible_for_requested_path': False, 'reasons': ['invalid_input']}
    reasons = []
    for key in sorted(set(e) - KNOWN_FIELDS, key=str):
        reasons.append('unknown_field:' + str(key))
    for key in sorted(CONTROL_FLAGS):
        if key not in e:
            reasons.append('missing_control:' + key)
        elif type(e[key]) is not bool:
            reasons.append('invalid_control:' + key)
    for key in sorted(PROOFS & e.keys()):
        if type(e[key]) is not bool:
            reasons.append('invalid_proof:' + key)
    def require(key):
        if e.get(key) is not True:
            reasons.append(key)
    purpose = e.get('purpose')
    known_purpose = isinstance(purpose, str) and purpose in PURPOSES
    if not known_purpose:
        reasons.append('unknown_purpose')
    write = e.get('write_requested')
    if known_purpose and purpose in READ_ONLY and write is True:
        reasons.append('read_only_purpose')
    if purpose == 'restore_commit' and write is not True:
        reasons.append('restore_commit_requires_write')
    for key in sorted(BASE_PROOFS):
        require(key)
    if purpose == 'restore_commit':
        for key in sorted(RESTORE_PROOFS):
            require(key)
    if write is True or purpose == 'restore_commit':
        for key in sorted(WRITE_PROOFS):
            require(key)
    if e.get('contested_fact_used_for_precise_adoption') is True:
        reasons.append('contested_fact')
    if e.get('old_grant_used') is True:
        reasons.append('old_grant')
    if e.get('retained_evidence_read') is True:
        for key in sorted(EVIDENCE_PROOFS):
            require(key)
    if e.get('business_receipt_unknown') is True and e.get('repeat_business_submit') is True:
        reasons.append('query_authoritative_receipt_first')
    if e.get('claim_saved') is True and e.get('checkpoint_ack') is not True:
        reasons.append('missing_checkpoint_ack')
    return {'eligible_for_requested_path': not reasons, 'reasons': reasons}


CLARIFICATION_FIELDS = frozenset(('reasonable_candidates', 'free_input_available',
    'none_of_these_available', 'open_question', 'invented_options',
    'user_rejected_all', 'continue_compatible_help'))


def clarification_fixture_errors(e):
    """Check explicit interaction fixture expectations, not language quality or actual UI."""
    if not isinstance(e, dict):
        return ['invalid_input']
    errors = ['unknown_field:' + str(k) for k in sorted(set(e) - CLARIFICATION_FIELDS, key=str)]
    for key in sorted(CLARIFICATION_FIELDS & e.keys()):
        if type(e[key]) is not bool:
            errors.append('invalid_control:' + key)
    for key in ('reasonable_candidates', 'free_input_available', 'user_rejected_all'):
        if key not in e:
            errors.append('missing_control:' + key)
    if e.get('free_input_available') is not True:
        errors.append('free_input_required')
    if e.get('reasonable_candidates') is True:
        if e.get('none_of_these_available') is not True:
            errors.append('none_of_these_required')
    elif e.get('reasonable_candidates') is False:
        if e.get('open_question') is not True or e.get('invented_options') is not False:
            errors.append('open_question_without_invented_options')
    else:
        errors.append('candidate_evidence_required')
    if e.get('user_rejected_all') is True and e.get('continue_compatible_help') is not True:
        errors.append('continue_after_rejection')
    return errors
