import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { assembleContextSnapshot } from "../../src/server/decision-context/context-assembly";
import type { Annotation } from "../../src/server/decision-context/contracts.generated";
import { digest } from "../../src/server/trip-state/command-json";
import type { Condition, DecisionContext, State } from "../../src/server/trip-state/contracts.generated";
import { base, object } from "../support/bcg-fixtures";

const now = new Date("2030-01-01T00:00:00Z"), targets = ["skeleton-a"];
function reference(state: State) {
  return JSON.parse(execFileSync(process.env.TRIP_STATE_PYTHON ?? "python3", ["scripts/e03-02-annotation-oracle.py"], {
    input: JSON.stringify([{state, targets, now: now.toISOString()}]), encoding: "utf8", timeout: 20000,
    env: {...process.env, PYTHONDONTWRITEBYTECODE:"1"},
  }))[0] as {context:DecisionContext;annotations:Annotation[]};
}
function fixture(opposite: boolean, selected: boolean) {
  const state = structuredClone(base), fact = object(state,"fact-cairo-luxor","ExternalFact");
  object(state,"pref-culture","Preference").condition = {op:"eq",object_id:fact.id,path:"/value/service_exists",value:true};
  if (opposite) {
    const other = structuredClone(fact); other.id="opposite-fact";other.query_status="no_service";
    if (other.value?.kind !== "transport") throw new Error("Fixture");
    Object.assign(other.value,{service_exists:false,departure:null,arrival:null,duration_minutes:null});
    state.objects.push(other);
    if (selected) object(state,"skeleton-a","Skeleton").connections[0].fact_ids.push(other.id);
  }
  return state;
}

describe("C12 applicability comparison with pinned R6 annotation runtime", () => {
  it("matches the original annotation when no fact is contested", () => {
    const state=fixture(false,false), candidate=assembleContextSnapshot(state,"task-test",targets,now), original=reference(state);
    expect(candidate.context.selected_object_ids).toEqual(original.context.selected_object_ids);
    expect(candidate.annotations).toEqual(original.annotations.sort((a,b)=>a.id.localeCompare(b.id)));
    expect(candidate.annotations.find(a=>a.id==="pref-culture")?.applicability).toBe("applicable");
  });
  it("records the exact observable difference when an opposite fact is outside selected bodies", () => {
    const state=fixture(true,false), candidate=assembleContextSnapshot(state,"task-test",targets,now), original=reference(state);
    // IDs are independently generated UUIDs. Every other Context field must match.
    const referenceContext={...original.context}, candidateContext={...candidate.context};
    referenceContext.id="context-normalized";candidateContext.id="context-normalized";
    expect(candidateContext).toEqual(referenceContext);
    expect(candidate.context.selected_object_ids).not.toContain("opposite-fact");
    const referencePref=original.annotations.find(a=>a.id==="pref-culture"), candidatePref=candidate.annotations.find(a=>a.id==="pref-culture");
    expect(referencePref?.applicability).toBe("applicable");
    expect(candidatePref?.applicability).toBe("unknown");
    expect({...candidatePref,applicability:"applicable"}).toEqual(referencePref);
    expect(candidate.annotations.filter(a=>a.id!=="pref-culture")).toEqual(original.annotations.filter(a=>a.id!=="pref-culture").sort((a,b)=>a.id.localeCompare(b.id)));
    const evidencePath=process.env.E03_C12_REFERENCE_EVIDENCE_PATH;
    if(process.env.CI && !evidencePath) throw new Error("CI requires R6/C12 comparison evidence path");
    if(evidencePath) fs.writeFileSync(evidencePath,JSON.stringify({
      scenario:"synthetic unselected opposite fact; R6 selected versus full snapshot condition evaluation",
      reference_source:"locked R6 Runtime._annotations and approved TS Store.context",
      candidate_source:"TypeScript assembleContextSnapshot", comparison_clock:now.toISOString(), targets,
      state_digest:digest(state), state, original, candidate,
      permitted_context_difference:["id: independent UUID"],
      permitted_annotation_difference:["pref-culture.applicability: R6 applicable; candidate unknown"],
    },null,2)+"\n");
  });
  it.each([
    { op:"not", condition:{op:"not",arg:{op:"eq",object_id:"fact-cairo-luxor",path:"/value/service_exists",value:true}} as Condition, r6:"not_applicable", candidate:"unknown" },
    { op:"all true", condition:{op:"all",args:[{op:"eq",object_id:"fact-cairo-luxor",path:"/value/service_exists",value:true},{op:"always"}]} as Condition, r6:"applicable", candidate:"unknown" },
    { op:"all false", condition:{op:"all",args:[{op:"eq",object_id:"fact-cairo-luxor",path:"/value/service_exists",value:true},{op:"not",arg:{op:"always"}}]} as Condition, r6:"not_applicable", candidate:"not_applicable" },
    { op:"any false", condition:{op:"any",args:[{op:"eq",object_id:"fact-cairo-luxor",path:"/value/service_exists",value:true},{op:"not",arg:{op:"always"}}]} as Condition, r6:"applicable", candidate:"unknown" },
    { op:"any true", condition:{op:"any",args:[{op:"eq",object_id:"fact-cairo-luxor",path:"/value/service_exists",value:true},{op:"always"}]} as Condition, r6:"applicable", candidate:"applicable" },
  ])("compares R6 and candidate for composite $op", ({condition,r6,candidate:expected}) => {
    const state=fixture(true,false);object(state,"pref-culture","Preference").condition=condition;
    const candidate=assembleContextSnapshot(state,"task-test",targets,now),original=reference(state);
    expect(original.annotations.find(a=>a.id==="pref-culture")?.applicability).toBe(r6);
    expect(candidate.annotations.find(a=>a.id==="pref-culture")?.applicability).toBe(expected);
    expect(candidate.context.stale_fact_ids).toEqual(original.context.stale_fact_ids);
  });
  it("distinguishes an R6-selected opposite fact deferred by the real reference Packet budget", () => {
    const state=fixture(true,true),candidate=assembleContextSnapshot(state,"task-test",targets,now);
    const output=JSON.parse(execFileSync(process.env.TRIP_STATE_PYTHON ?? "python3", ["scripts/e03-02-annotation-oracle.py"], {
      input:JSON.stringify([{state,targets,now:now.toISOString(),packet_budget:2}]),encoding:"utf8",timeout:20000,
      env:{...process.env,PYTHONDONTWRITEBYTECODE:"1"},
    }))[0] as {packet:{context:{selected_object_ids:string[]};objects:Array<{id:string}>;deferred_ids:string[];annotations:Annotation[]}};
    const packet=output.packet;
    expect(packet.context.selected_object_ids).toContain("opposite-fact");
    expect(packet.deferred_ids).toContain("opposite-fact");
    expect(packet.objects.map(o=>o.id)).not.toContain("opposite-fact");
    expect(packet.annotations.find(a=>a.id==="pref-culture")?.applicability).toBe("unknown");
    expect(candidate.annotations.find(a=>a.id==="pref-culture")?.applicability).toBe("unknown");
  });
  it("matches the original annotation when both opposing facts are selected", () => {
    const state=fixture(true,true), candidate=assembleContextSnapshot(state,"task-test",targets,now), original=reference(state);
    expect(candidate.context.selected_object_ids).toEqual(original.context.selected_object_ids);
    expect(candidate.context.stale_fact_ids).toEqual(original.context.stale_fact_ids);
    expect(original.annotations.find(a=>a.id==="pref-culture")?.applicability).toBe("unknown");
    expect(candidate.annotations.find(a=>a.id==="pref-culture")?.applicability).toBe("unknown");
    expect(candidate.annotations).toEqual(original.annotations.sort((a,b)=>a.id.localeCompare(b.id)));
  });
});
