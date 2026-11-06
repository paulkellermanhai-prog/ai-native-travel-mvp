# E03–E04 joint boundary preparation

This is an isolated test integration, not an E03 stage acceptance or an E04 runtime. The E03 input is PR #18 head `9b92c1c0c9b5ffcfca468ddf9cc6c7baec69f911`; the E04 input is PR #22 head `25dbfcf82db748268890c28a34495febf4e53f6d` (which contains #16/#17/#19/#20/#21). Both remain unmerged. #18's C12 applicability difference is explicitly adjudicated; the preceding 3479854 code and evidence received limited review, while the 9b92c1c documentation-only successor still needs final CI and the stage gate. Recheck both heads and reviews before using this candidate for a subsequent integration.

`tests/next-action-policy/e03-real-context.integration.test.ts` uses actual Better Auth sessions, membership records, the TS service, and E03's `openSessionContextService` against a disposable PostgreSQL database. It creates only synthetic accounts and a trip. It checks that (1) a consumed real Context cannot be passed as a NAP DecisionRequest Packet; (2) another session cannot consume the ticket; (3) after another authorized member advances the TS revision, consumption of the old ticket is refused; and (4) a newly assembled Context observes the new revision. This is a safety boundary test: it does not construct a Packet, execute policy, access a provider, check receipt replay, or claim to be a user-facing flow.

Run in an environment provisioned by `scripts/prepare-storage-tests.mjs`, with `E02_STORAGE_ENV_FILE` holding the distinct migration, runtime, and auth connections, followed by:

```sh
npm test -- tests/next-action-policy/e03-real-context.integration.test.ts
```

The test skips if the database environment is missing outside CI and fails setup in CI if the auth connection is absent. A skip is not a pass. The existing #18 tests provide additional expiry, revoked membership, separate session and between-check mutation coverage; those are E03 Context tests, not Packet or E04 execution acceptance.

## Interface needed for actual execution

- The accepted E03 turn/task service must authenticate the session and trip, own the task and deliver an R6 Packet bound to the same runtime, turn, task and state, with canonical deadline and snapshot digest. #18's in-process Context ticket lacks these verified Packet fields; relabeling a Context as a Packet is forbidden.
- A trusted E04 host must bind the accepted Packet to its own live principal and action, verify decision/plan consistency, recheck origin, authorization, expiry and the authoritative TS snapshot before any action, and atomically claim a persisted execution. The pure validator's success or caller-supplied boolean is not proof of any guard. If session, membership and business state live in different transactional domains, document and test the actual consistency boundary; the final E03 read cannot promise atomicity against later revocation or write.
- Tool dispatch and return require persisted invocation, authenticated provider, canonical plan/query identifiers, deadline and state revalidation; store completion identity and disposition in an atomic idempotency boundary, reject same-ID conflicting content, and look up authoritative receipts on uncertain execution. External side effects and a local database transaction are not generally atomic; use the approved provider's idempotency and recovery protocol. Do not turn test booleans into claimed receipts.
- A change request must pass the real TS actor, authorization, revision and confirmation paths. User-required confirmation stays pending until an authorized user confirms; a result or synthetic actor cannot commit it.

## Joint acceptance tests once those interfaces exist

Exercise a real authenticated turn → Packet → accepted plan → authorized action → real/stub-provider invocation → persisted receipt → permitted TS write or pending confirmation, on the same integration head. Include foreign session/trip/task and fabricated Packet, revision advance before dispatch and during return, unchanged revision with expiry, membership/session revocation at each delivery boundary, simultaneous duplicate and same-ID different-content receipts, timeouts followed by receipt lookup, crash between external side effect and persistence, restart, and cross-user confirmation. Record which provider and storage implementations ran; a deterministic synthetic provider can test host orchestration but does not prove a live provider or model. Include exact E03 and NAP release-owner decisions and C3 acceptance before claiming the stage or MVP works.
