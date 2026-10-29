import { describe, expect, it } from "vitest";
import { planCommand, planConfirmation, type CommandRequest, type PendingProposal } from "../../src/server/trip-state/commands";
import type { State, TripStateContracts } from "../../src/server/trip-state/contracts.generated";
import { base, change, createFrom, object } from "../support/bcg-fixtures";
import { clock, uuids, oracle, type Audit } from "../support/command-fixtures";
import { factActors as actors } from "../support/fact-fixtures";

type Result = { response: TripStateContracts["response"]; state_after: State; audit: Audit };
const adopt = (id = "skeleton-a", acknowledge_unknowns = true): TripStateContracts["command"] => ({ op: "adopt_skeleton", id, acknowledge_unknowns, confirmation_scope: ["cities", "order", "stays", "connections"] });
function compare(state: State, commands: CommandRequest["commands"], actor = actors.user, expectedError?: string, at = clock) {
  const request = change(state, commands), uuidStart = 1000 + state.revision * 20;
  const expected = oracle<Result[]>({ initial: state, operations: [{ request, actor }], clock: at().toISOString(), uuidStart })[0], before = structuredClone(state);
  if (expectedError) {
    expect(expected.response.errors[0]?.code).toBe(expectedError);
    expect(() => planCommand(state, request, actor, at, uuids(uuidStart))).toThrowError(expect.objectContaining({ code: expectedError }));
    expect(expected.state_after).toEqual(state); expect(expected.audit).toEqual({ intents: [], changes: [] }); expect(state).toEqual(before); return null;
  }
  const b = planCommand(state, request, actor, at, uuids(uuidStart));
  expect({ response: b.response, state_after: b.snapshot, audit: { intents: [b.intent], changes: [b.change] } }).toEqual(expected); expect(state).toEqual(before); return b;
}
function issueState(affected: string, state = structuredClone(base)) {
  const issue = object(state, "issue-cost", "OpenIssue"); issue.affected_ids = [affected]; issue.question = "合成问题：验证正式对象条件"; return state;
}
const resolve = (evidence_ids: string[], id = "issue-cost"): TripStateContracts["command"] => ({ op: "resolve_issue", id, evidence_ids, reason: "合成证据验证" });

describe("E02-04D adoption, recalculation and Issue command protection", () => {
  it.each(["user", "system", "model", "tool"] as const)("recalculate role=%s", (role) => { compare(base, [{ op: "recalculate", id: "skeleton-a" }], actors[role], ["model", "tool"].includes(role) ? "PERMISSION" : undefined); });
  it.each(["superseded", "archived"] as const)("cannot overwrite %s skeleton history through recalculate", (status) => {
    const state = structuredClone(base); object(state, "skeleton-a", "Skeleton").status = status;
    compare(state, [{ op: "recalculate", id: "skeleton-a" }], actors.system, "IMMUTABLE_HISTORY");
  });
  it.each(["adopt_skeleton", "recalculate", "resolve_issue", "dismiss_issue"] as const)("%s rejects wrong object type", (op) => {
    const cmd = op === "adopt_skeleton" ? adopt("cairo") : op === "resolve_issue" ? resolve(["constraint-nights"], "cairo") : op === "dismiss_issue" ? { op, id: "cairo", reason: "合成" } as const : { op, id: "cairo" } as const;
    compare(base, [cmd], actors.user, "REF_TYPE");
  });
  it.each([false, true])("unknown stays: acknowledge=%s never upgrades facts", (acknowledge) => {
    const state = structuredClone(base); object(state, "skeleton-a", "Skeleton").stops[0].nights = null;
    const b = compare(state, [adopt("skeleton-a", acknowledge)], actors.user, acknowledge ? undefined : "UNKNOWN_ACK");
    if (b) { expect(object(b.snapshot, "skeleton-a", "Skeleton").assessment.status).toBe("pending");
      expect(b.snapshot.objects.find((o) => o.type === "Decision")).toMatchObject({ acknowledged_unknowns: expect.arrayContaining(["stay_nights_missing"]), status: "confirmed" });
      for (const f of state.objects.filter((o) => o.type === "ExternalFact")) expect(b.snapshot.objects.find((o) => o.id === f.id)).toEqual(f);
    }
  });
  it.each([false, true])("hard conflicts reject adoption even acknowledge=%s", (acknowledge) => {
    const state = structuredClone(base); object(state, "skeleton-a", "Skeleton").stops[0].nights = 5;
    compare(state, [adopt("skeleton-a", acknowledge)], actors.user, "HARD_CONFLICT");
  });
  it.each(["scenario", "archived", "superseded"])("cannot adopt a %s skeleton", (kind) => {
    const state = structuredClone(base), sk = object(state, "skeleton-a", "Skeleton");
    if (kind === "scenario") sk.purpose = "scenario"; else sk.status = kind as "archived" | "superseded";
    compare(state, [adopt()], actors.user, "SCENARIO_ADOPTION");
  });
  it("rejects a second adoption and two adoptions in one batch atomically", () => {
    const state = compare(base, [adopt()])!.snapshot; compare(state, [adopt()], actors.user, "ALREADY_ADOPTED");
    compare(base, [adopt(), adopt()], actors.user, "MULTIPLE_ADOPTIONS");
  });
  it("requires a complete confirmation scope without leaving an orphan root or decision", () => {
    const cmd = adopt(); if (cmd.op !== "adopt_skeleton") throw new Error("Fixture"); Object.assign(cmd, { confirmation_scope: ["cities"] });
    compare(base, [cmd], actors.user, "SCHEMA");
  });
  it("explicit rejected city cannot be silently reintroduced by adoption; same-batch revocation is required", () => {
    const rejected = compare(base, [{ op: "decide_candidate", id: "candidate-luxor", value: "reject" }])!.snapshot;
    compare(rejected, [adopt()], actors.user, "CONFIRMED_CANDIDATE");
    const d = rejected.objects.find((o) => o.type === "Decision")!;
    const b = compare(rejected, [{ op: "withdraw_decision", id: d.id }, adopt()])!;
    expect(b.snapshot.effective_skeleton_id).toBe("skeleton-a"); expect(b.snapshot.objects.find((o) => o.id === d.id)?.status).toBe("revoked");
  });
  it("accepted city cannot disappear from adopted cities", () => {
    const accepted = compare(base, [{ op: "decide_candidate", id: "candidate-luxor", value: "accept" }])!.snapshot;
    const c = createFrom(object(accepted, "skeleton-a", "Skeleton"), "skeleton-cairo");
    if (c.op !== "create" || c.object_type !== "Skeleton") throw new Error("Fixture"); c.data.stops = [{ entity_id: "cairo", nights: 4 }]; c.data.connections = [];
    const draft = compare(accepted, [c], actors.model)!.snapshot; compare(draft, [adopt("skeleton-cairo")], actors.user, "CONFIRMED_CANDIDATE");
  });
  it("adopts a real new tentative version, preserves predecessor history and pins resulting versions", () => {
    const first = compare(base, [adopt()])!.snapshot;
    const draft = compare(first, [createFrom(object(first, "skeleton-a", "Skeleton"), "skeleton-next")], actors.model)!.snapshot;
    const b = compare(draft, [adopt("skeleton-next")])!, s = b.snapshot;
    expect(s.effective_skeleton_id).toBe("skeleton-next"); expect(object(s, "skeleton-a", "Skeleton").status).toBe("superseded");
    const prior = first.objects.find((o) => o.type === "Decision")!, next = s.objects.find((o) => o.type === "Decision" && o.status === "confirmed")!;
    expect(s.objects.find((o) => o.id === prior.id)?.status).toBe("revised");
    expect(next).toMatchObject({ supersedes: prior.id, subject_version: object(s, "skeleton-next", "Skeleton").version });
    for (const d of object(s, "skeleton-next", "Skeleton").dependencies) expect(d.version).toBe(s.objects.find((o) => o.id === d.object_id)!.version);
  });
  it("recalculation due only to clock advance propagates stale to the confirmed decision without invalidating new assessment", () => {
    const adopted = compare(base, [adopt()])!.snapshot;
    const b = compare(adopted, [{ op: "recalculate", id: "skeleton-a" }], actors.system, undefined, () => new Date("2030-01-03T00:00:00Z"))!;
    expect(object(b.snapshot, "skeleton-a", "Skeleton").assessment.status).toBe("pending");
    expect(b.snapshot.objects.find((o) => o.type === "Decision")).toMatchObject({ status: "confirmed", review_state: "stale" });
    expect(b.snapshot.effective_skeleton_id).toBe("skeleton-a");
    for (const f of adopted.objects.filter((o) => o.type === "ExternalFact")) expect(b.snapshot.objects.find((o) => o.id === f.id)).toEqual(f);
  });
  it("same-batch changed inputs pin dependencies to resulting object versions and recompute rather than stay stale", () => {
    const b = compare(base, [{ op: "revise", object_type: "Constraint", id: "constraint-nights", changes: { value: { kind: "duration", maximum_nights: 3 } } }, { op: "recalculate", id: "skeleton-a" }])!;
    const sk = object(b.snapshot, "skeleton-a", "Skeleton"); expect(sk.assessment.status).toBe("blocked");
    expect(sk.dependencies.find((d) => d.object_id === "constraint-nights")!.version).toBe(2);
  });
  it.each(["user", "system", "model", "tool"] as const)("Issue resolution Actor=%s", (role) => {
    compare(issueState("fact-cairo-luxor"), [resolve(["fact-cairo-luxor"])], actors[role], ["model", "tool"].includes(role) ? "PERMISSION" : undefined);
  });
  it.each(["open", "waiting", "actionable"] as const)("resolves a %s Issue with related verified evidence", (status) => {
    const s = issueState("fact-cairo-luxor"); object(s, "issue-cost", "OpenIssue").status = status;
    const b = compare(s, [resolve(["fact-cairo-luxor"])])!;
    expect(object(b.snapshot, "issue-cost", "OpenIssue")).toMatchObject({ status: "resolved", resolution: "合成证据验证", evidence_ids: ["fact-cairo-luxor"], source: object(s, "issue-cost", "OpenIssue").source });
  });
  it.each(["wrong-type", "unrelated", "expired", "unknown", "superseded"])("rejects %s resolution evidence without any partial state", (kind) => {
    const s = issueState("fact-cairo-luxor"); let proof = "fact-cairo-luxor", at = clock;
    if (kind === "wrong-type") proof = "pref-culture";
    if (kind === "unrelated") proof = "constraint-nights";
    if (kind === "expired") at = () => new Date("2030-01-03T00:00:00Z");
    if (kind === "unknown") object(s, "fact-cairo-luxor", "ExternalFact").verification = "estimated";
    if (kind === "superseded") object(s, "fact-cairo-luxor", "ExternalFact").status = "superseded";
    compare(s, [resolve([proof])], actors.user, "RESOLUTION_EVIDENCE", at);
  });
  it.each(["fact", "constraint", "candidate", "decision", "skeleton"])("evidence alone cannot close still-blocked %s", (kind) => {
    let s = structuredClone(base), affected = "constraint-nights", proof = affected;
    if (kind === "fact") { affected = "fact-cairo-luxor"; proof = "constraint-nights"; const f = object(s, affected, "ExternalFact"); f.freshness = "stale"; f.dependencies = [{ object_id: proof, version: 1, paths: ["/status"], relation: "evidence" }]; }
    if (kind === "constraint") object(s, affected, "Constraint").status = "proposed";
    if (kind === "candidate") { affected = "candidate-luxor"; const c = object(s, affected, "Candidate"); c.review_state = "stale"; c.dependencies = [{ object_id: proof, version: 1, paths: ["/status"], relation: "input" }]; }
    if (kind === "decision") { s = compare(s, [{ op: "decide_candidate", id: "candidate-luxor", value: "accept" }])!.snapshot; affected = proof = s.objects.find((o) => o.type === "Decision")!.id; object(s, affected, "Decision").review_state = "stale"; }
    if (kind === "skeleton") { affected = "skeleton-a"; proof = "cost-transport"; object(s, affected, "Skeleton").stops[0].nights = null; }
    s = issueState(affected, s); compare(s, [resolve([proof])], actors.user, "ISSUE_STILL_BLOCKED");
  });
  it.each(["constraint", "candidate", "decision", "skeleton"])("resolves an actually ready %s using related evidence", (kind) => {
    let s = structuredClone(base), affected = "constraint-nights", proof = affected;
    if (kind === "candidate") { affected = "candidate-luxor"; object(s, affected, "Candidate").dependencies = [{ object_id: proof, version: 1, paths: ["/status"], relation: "input" }]; }
    if (kind === "decision") { s = compare(s, [{ op: "decide_candidate", id: "candidate-luxor", value: "accept" }])!.snapshot; affected = proof = s.objects.find((o) => o.type === "Decision")!.id; }
    if (kind === "skeleton") { affected = "skeleton-a"; proof = "cost-transport"; s = compare(s, [{ op: "transition", id: "constraint-budget", event: "relax" }])!.snapshot; }
    const b = compare(issueState(affected, s), [resolve([proof])])!; expect(object(b.snapshot, "issue-cost", "OpenIssue").status).toBe("resolved");
  });
  it("dismiss retains reason/history but changes no fact, feasibility or hard constraint", () => {
    const s = issueState("skeleton-a"), b = compare(s, [{ op: "dismiss_issue", id: "issue-cost", reason: "用户明确接受继续保留未知" }])!;
    for (const o of s.objects.filter((o) => o.id !== "issue-cost")) expect(b.snapshot.objects.find((v) => v.id === o.id)).toEqual(o);
    expect(object(b.snapshot, "issue-cost", "OpenIssue")).toMatchObject({ status: "dismissed", resolution: "用户明确接受继续保留未知", evidence_ids: [] });
  });
  it.each(["resolve", "dismiss"] as const)("generic transition %s cannot bypass the dedicated command", (event) => { compare(base, [{ op: "transition", id: "issue-cost", event }], actors.user, "DEDICATED_COMMAND"); });
  it.each(["resolved", "dismissed"] as const)("closed %s Issue cannot be closed again without formal reopen", (status) => {
    const s = structuredClone(base), o = object(s, "issue-cost", "OpenIssue"); o.status = status; o.resolution = "合成历史处理";
    compare(s, [{ op: "dismiss_issue", id: o.id, reason: "重复关闭" }], actors.user, "ILLEGAL_TRANSITION");
  });
  it.each(["model", "system"] as const)("%s adopt/dismiss must use Proposal confirmation with actual User", (role) => {
    for (const cmd of [adopt(), { op: "dismiss_issue", id: "issue-cost", reason: "合成关闭" } as const]) for (const accept of [true, false]) {
      const request = change(base, [cmd]), uuid = uuids(), b = planCommand(base, request, actors[role], clock, uuid);
      expect(b.response.outcome).toBe("pending_confirmation"); expect(b.snapshot).toEqual(base);
      const pending: PendingProposal = { proposalId: b.response.proposal_id!, request, actor: actors[role], digest: b.response.proposal_digest!, expires: b.proposalDetails!.expires_at, details: b.proposalDetails! };
      const body = { expected_revision: base.revision, idempotency_key: "confirm-final-command", proposal_digest: pending.digest, accept };
      const r = planConfirmation(base, pending, body, actors.user, clock, uuid);
      const py = oracle<Result[]>({ mode: "lifecycle", initial: base, operations: [{ actor: actors[role], request }, { method: "confirm", proposalIndex: 0, actor: actors.user, request: body }] });
      expect(r.response).toEqual(py[1].response); expect(r.snapshot).toEqual(py[1].state_after); expect({ intents: [b.intent, r.intent], changes: [b.change, r.change] }).toEqual(py[1].audit);
      if (!accept) expect(r.snapshot).toEqual(base);
    }
  });
});
