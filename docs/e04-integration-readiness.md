# E04 integration readiness — reference bridge, 2026-11-06

## What is executable

PR #21's head contains #16 → #17 → #19 → #20 → #21: message and embedded DC/TS contract decoding; plan graph and basis consistency; consistency against supplied Packet fields; pure action transitions; and supplied tool-completion binding. The reviewed head is `41587583dd974100889dec7547a8e946ce432278`. These pieces do not implement a policy decision, a trusted execution host or production Packet authority.

`tests/next-action-policy/reference-bridge.test.ts` exercises a bridge from **actual TypeScript TS `planCommand` snapshots**, to **a pinned R6 Python reference** that generates a Packet from each snapshot, to the existing E04 checks and pure phase transitions. The plan, principal, trigger, guard booleans, invocation and completion are synthetic test inputs. The Python reference is not E03 production, and its TS `Store` only reads each snapshot: the two TS writes come from the application TypeScript planner. The test shows the current supplied Packet rejects an old plan basis, and demonstrates that a self-consistent old Packet/plan and completion still pass the pure checks when the authoritative revision has advanced. A synthetic `basisCurrent: false` produces the stale candidate phase, and unknown execution requires receipt lookup; neither proves that a production host actually detects those conditions.

From repository root (Node 24, Python dependencies in `scripts/requirements-oracle.txt`):

```sh
TRIP_STATE_PYTHON=/path/to/python npm test -- tests/next-action-policy/reference-bridge.test.ts
```

The Python helper verifies every pinned source hash in `specs/e03-01-oracle-lock.json`, uses an in-memory store, disables bytecode, and does not write the source packages. NAP R3 selection is `specs/nap-r3-2026-11-06/selection.json` (SHA-256 `c24a942588cb54fab20a3b66cd104d9d273f25aba259794605572ab9f7c5e952`); structural schema continuity alone is not policy-semantic acceptance or the release-owner signoff.

## Required real interfaces and minimum unblock conditions

1. **Trusted current Packet.** Integrate an accepted E03 session-bound turn/task and Packet service that returns the complete R6 Packet for the authenticated owner, task, trip and current revision/digest, with expiration and access checks. E03-02 #18 is a draft context-assembly/read slice, not a Packet service; the technical lead has accepted a limited C12 applicability difference from frozen R6 (`E03-02-C12-APPLICABILITY-2026-11-06-01`), while implementation head `b6fef7a196b2161ba9f46d4d78c941cfe64b40a5` still requires CI and review; this decision does not accept the E03-02 stage. Do not synthesize a real Packet by relabelling its context output. E03-03 task/focus and ownership integration must also be accepted.
2. **Policy and C3.** An accepted implementation must consume the trusted Packet and apply the approved NAP R3 policy and actual capability registry. The current modules validate supplied structures and consistency; they do not produce decisions or prove policy eligibility. C3 and production/release-owner acceptance remain unrecorded.
3. **Authoritative action host.** Before start/resume/commit, verify live session, task scope, Packet expiry and revision/digest against authoritative storage; evaluate dependencies and permissions; atomically persist the action and acquire a claim. Only then derive the guard values given to `nextActionPhase`. E03 context's ticket and TS state validation are useful building blocks but are not a substitute for the full authority boundary.
4. **Tool receipt and replay control.** Persist invocation identity and one authoritative receipt per completion, handle same-ID conflicting content, authenticate provider and check plan/query/version/time again when the result returns. Atomically reject duplicate/replayed or obsolete results; unknown execution must query an authoritative receipt. `validateCompletionBinding` alone reads no authority or prior receipt.
5. **TS write and user confirmation.** Submit any planned change through the accepted TS service under its real actor and authorization; maintain event/Packet provenance and expected revision. Model-originated changes requiring confirmation must remain pending until actual authorized user confirmation; never promote a synthetic actor or a proposed result to a committed state.
6. **Joint integration and acceptance.** Integrate the final accepted E03/TS/auth and stacked E04 branches under one owner (including the existing workflow/package conflicts), rerun source/semantic comparison against the approved NAP R3 package, and exercise live PostgreSQL, real authentication, concurrent changes, expiry, replay and crash/retry. Then run the required original scenarios, real UI/model/tool flows and owner gate. The reference bridge does not replace any of these checks.

## Next executable integration tests once interfaces exist

- Real session A opens a turn, receives a Packet, produces a plan, claims an authorized step and returns a bound receipt; session B, a different trip and an invented Packet are denied.
- Change TS after assembly and before execution, and independently during a tool call: neither the stale Packet nor its late completion can write or succeed; expiry without revision change also invalidates.
- Concurrent identical receipt deliveries apply at most once; same completion ID with different content is rejected; simulate crash after an external side effect and recover via receipt lookup.
- Model-originated TS change requiring confirmation remains pending; wrong user and forged confirmation cannot commit it, authorized confirmation can; concurrent revision change forces revalidation.
- C12 annotations and all contract semantics follow the final adjudicated R6/R3 artifacts, including multiple task/Packet same-snapshot behavior and independent unselected Packet checks.
