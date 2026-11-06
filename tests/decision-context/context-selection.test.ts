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
 it("retains protected hard constraints and all unresolved issues even without a target",()=>{
  const s=original(),result=selectContextObjects(s,[]);
  for(const id of [...result.must_include_constraints,...result.open_issues])expect(result.selected_object_ids).toContain(id);
 });
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
