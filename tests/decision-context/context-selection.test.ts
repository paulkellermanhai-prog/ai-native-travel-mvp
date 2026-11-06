import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { selectContextObjects, scopeApplicability, isCurrentlyUsableFact } from "../../src/server/decision-context/context-selection";
import { parseStateReferences } from "../../src/server/trip-state/references";
import type { State } from "../../src/server/trip-state/contracts.generated";
const path="specs/baseline-2026-10-27/trip-state-schema-v0.1/90_可运行工程包/examples/initial-egypt-state.json";
const original=()=>parseStateReferences(JSON.parse(fs.readFileSync(path,"utf8")));
const objects=(s:State)=>new Map(s.objects.map(o=>[o.id,o]));
describe("E03-02 pure candidate selection (not production integration)",()=>{
 it("matches the pinned AC8 Python reference for multiple targets and preserves input",()=>{
  const state=original(),before=structuredClone(state),cases=[[],["candidate-luxor"],["skeleton-a"],["egypt"],["missing"]].map(targets=>({state,targets}));
  const result=JSON.parse(execFileSync(process.env.TRIP_STATE_PYTHON??"python3",["scripts/e03-02-selection-oracle.py"],{input:JSON.stringify(cases),encoding:"utf8",timeout:60000}));
  for (let i=0;i<cases.length;i++) {
   if(result[i].error) expect(()=>selectContextObjects(state,cases[i].targets)).toThrow();
   else expect(selectContextObjects(state,cases[i].targets)).toEqual(result[i].value);
  }
  expect(state).toEqual(before);
 },65000);
 it("preserves original multilevel reference closure and deliberately does not traverse issue evidence_ids",()=>{
  const s=original(),baseCandidate=s.objects.find(o=>o.id==="candidate-luxor"),aswan=s.objects.find(o=>o.id==="candidate-aswan"),basePref=s.objects.find(o=>o.id==="pref-culture"),issue=s.objects.find(o=>o.id==="issue-cost");
  if(!baseCandidate||baseCandidate.type!=="Candidate"||!aswan||aswan.type!=="Candidate"||!basePref||basePref.type!=="Preference"||!issue||issue.type!=="OpenIssue")throw new Error("fixture");
  const candidate=structuredClone(baseCandidate);candidate.id="candidate-chain";candidate.dependencies=[];candidate.preference_ids=["pref-chain"];
  const pref=structuredClone(basePref);pref.id="pref-chain";pref.status="withdrawn";pref.condition={op:"eq",object_id:aswan.id,path:"/status",value:"exploring"};
  issue.evidence_ids=[aswan.id];s.objects.push(candidate,pref);
  const cases=[{state:s,targets:[]},{state:s,targets:[candidate.id]}];
  const python=JSON.parse(execFileSync(process.env.TRIP_STATE_PYTHON??"python3",["scripts/e03-02-selection-oracle.py"],{input:JSON.stringify(cases),encoding:"utf8",timeout:60000}));
  expect(python.map((r:{error:unknown})=>r.error)).toEqual([null,null]);
  const base=selectContextObjects(s,[]),selected=selectContextObjects(s,[candidate.id]);
  expect(base).toEqual(python[0].value);expect(base.selected_object_ids).not.toContain(aswan.id);expect(base.selected_object_ids).not.toContain("aswan");
  expect(selected).toEqual(python[1].value);expect(selected.selected_object_ids).toEqual(expect.arrayContaining([candidate.id,pref.id,aswan.id,"aswan"]));
 },65000);
 it.each(["dependency","reconsider_when","affected_ids","cost_fact_ids","destination_ids"] as const)("matches the original rule for %s references",key=>{
  const s=original(),candidate=s.objects.find(o=>o.id==="candidate-luxor"),issue=s.objects.find(o=>o.id==="issue-cost"),skeleton=s.objects.find(o=>o.id==="skeleton-a"),goal=s.objects.find(o=>o.id==="goal"),fact=s.objects.find(o=>o.id==="cost-transport");
  if(!candidate||candidate.type!=="Candidate"||!issue||issue.type!=="OpenIssue"||!skeleton||skeleton.type!=="Skeleton"||!goal||goal.type!=="TripGoal"||!fact||fact.type!=="ExternalFact")throw new Error("fixture");
  const targets:string[]=[];let expected="candidate-aswan";
  if(key==="dependency") {candidate.dependencies=[{object_id:expected,version:1,paths:["/status"],relation:"association"}];targets.push(candidate.id);}
  if(key==="reconsider_when") {candidate.reconsider_when={op:"eq",object_id:expected,path:"/status",value:"exploring"};targets.push(candidate.id);}
  if(key==="affected_ids") issue.affected_ids=[expected];
  if(key==="destination_ids") {expected="aswan";goal.destination_ids=[expected];}
  if(key==="cost_fact_ids") {expected="cost-hidden";const clone=structuredClone(fact);clone.id=expected;s.objects.push(clone);skeleton.cost_fact_ids=[expected];}
  const result=selectContextObjects(s,targets), python=JSON.parse(execFileSync(process.env.TRIP_STATE_PYTHON??"python3",["scripts/e03-02-selection-oracle.py"],{input:JSON.stringify([{state:s,targets}]),encoding:"utf8",timeout:60000}));
  expect(python[0].error).toBeNull();expect(result).toEqual(python[0].value);expect(result.selected_object_ids).toContain(expected);
 },65000);
 it("rejects dangling references rather than silently substituting another object",()=>{
  const s=original(),candidate=s.objects.find(o=>o.id==="candidate-luxor");if(!candidate||candidate.type!=="Candidate")throw new Error("fixture");
  candidate.dependencies=[{object_id:"missing",version:1,paths:["/status"],relation:"association"}];
  const result=JSON.parse(execFileSync(process.env.TRIP_STATE_PYTHON??"python3",["scripts/e03-02-selection-oracle.py"],{input:JSON.stringify([{state:s,targets:[candidate.id]}]),encoding:"utf8",timeout:60000}));
  expect(result[0].error).toBeTruthy();expect(()=>selectContextObjects(s,[candidate.id])).toThrow();
 },65000);
 it("retains protected hard constraints and all unresolved issues even without a target",()=>{
  const s=original(),result=selectContextObjects(s,[]);
  for(const id of [...result.must_include_constraints,...result.open_issues])expect(result.selected_object_ids).toContain(id);
 });
 it("preserves confirmed decisions and their referenced basis from the original context rule",()=>{
  const s=parseStateReferences(JSON.parse(fs.readFileSync("specs/baseline-2026-10-27/trip-state-schema-v0.1/90_可运行工程包/examples/final-state.json","utf8")));
  const decision=s.objects.find(o=>o.type==="Decision" && o.status==="confirmed");if(!decision||decision.type!=="Decision")throw new Error("fixture");
  const result=selectContextObjects(s,[]), python=JSON.parse(execFileSync(process.env.TRIP_STATE_PYTHON??"python3",["scripts/e03-02-selection-oracle.py"],{input:JSON.stringify([{state:s,targets:[]}]),encoding:"utf8",timeout:60000}));
  expect(python[0].error).toBeNull();expect(result).toEqual(python[0].value);expect(result.active_decisions).toContain(decision.id);
  expect(result.selected_object_ids).toEqual(expect.arrayContaining([decision.id,decision.subject_id,...decision.basis_ids]));
 },65000);
 it("does not broaden local preference applicability or turn unknown conditions into false",()=>{
  const s=original(),pref=s.objects.find(o=>o.type==="Preference")!;if(pref.type!=="Preference")throw new Error("fixture");
  pref.scope={kind:"entity",ids:["luxor"]};const map=objects(s),now=new Date("2030-01-01T00:00:00Z");
  expect(scopeApplicability(pref,["candidate-luxor"],map,now)).toBe("applicable");
  expect(scopeApplicability(pref,[],map,now)).toBe("unknown");
  pref.scope={kind:"traveler",ids:["traveler-a"]};expect(scopeApplicability(pref,["candidate-luxor"],map,now)).toBe("unknown");
  pref.scope={kind:"trip",ids:[]};pref.condition={op:"eq",object_id:"missing",path:"/status",value:"active"};expect(scopeApplicability(pref,["candidate-luxor"],map,now)).toBe("unknown");
 });
 it("treats fact expiry as time-dependent without a state revision change",()=>{
  const s=original(),fact=s.objects.find(o=>o.type==="ExternalFact")!;if(fact.type!=="ExternalFact")throw new Error("fixture");
  const revision=s.revision, before=new Date(fact.observed_at),after=new Date(fact.expires_at);
  expect(isCurrentlyUsableFact(fact,before)).toBe(true);expect(isCurrentlyUsableFact(fact,after)).toBe(false);expect(s.revision).toBe(revision);
 });
});
