import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe,it,expect,vi } from "vitest";
import { parseDCContract,decodeDCContract,type DCContractName,type DecisionContextContracts } from "../../src/server/decision-context/contracts";
import { dcSchemaResources } from "../../src/server/decision-context/schema-resources.generated";
const root="specs/dc-ac8-r6-calibration-2026-11-05/sources/decision-context-v0.1/90_可运行工程包";
const ex=JSON.parse(fs.readFileSync(path.join(root,"examples/exploration.json"),"utf8"));
const valid=JSON.parse(fs.readFileSync("tests/decision-context/fixtures/r6-contracts.json","utf8")) as Array<{schema:DCContractName;value:unknown}>;

describe("E03-01 frozen DC contract boundaries",()=>{
 it.each(valid)("accepts $schema without mutating input",({schema,value})=>{const before=structuredClone(value);expect(parseDCContract(schema,value)).toEqual(before);expect(value).toEqual(before);});
 it("registers all 20 original identities and resolves cross-package refs offline",async()=>{
  const fail=()=>{throw new Error("Network forbidden");};const fetch=vi.spyOn(globalThis,"fetch").mockImplementation(fail);
  try{vi.resetModules();const offline=await import("../../src/server/decision-context/contracts");expect(Object.keys(dcSchemaResources)).toHaveLength(20);for(const v of valid)offline.parseDCContract(v.schema,v.value);expect(fetch).not.toHaveBeenCalled();}finally{fetch.mockRestore();}
 });
 it("compares positive/negative shapes with the pinned original Python validator",()=>{
  const cases=valid.flatMap(v=>[v,{schema:v.schema,value:{...(v.value as object),injected_authority:true}}]);
  cases.push({schema:"open-turn",value:{...ex.open_turn,runtime_contract_version:"0.2.0"}},{schema:"open-turn",value:{...ex.open_turn,expected_revision:"0"}});
  const result=JSON.parse(execFileSync(process.env.TRIP_STATE_PYTHON??"python3",["scripts/e03-01-reference.py","--shape"],{input:JSON.stringify(cases),encoding:"utf8",timeout:60000}));
  expect(result.ids).toEqual(Object.values(dcSchemaResources).map(s=>s.$id).sort());
  expect(result.valid).toEqual(cases.map(v=>{try{parseDCContract(v.schema,v.value);return true;}catch{return false;}}));
 });
 it.each(["9007199254740993","1.00000000000000001","9007199254740990.1","1e999","-1"])("rejects unsafe/exact counter token %s",token=>{const body=JSON.stringify(ex.open_turn).replace('"expected_revision":0',`"expected_revision":${token}`);expect(()=>decodeDCContract("open-turn",body)).toThrow();});
 it("accepts exact integer exponent and safe maximum without narrowing source schemas",()=>{for(const token of ["1e2","1.0","9007199254740991"]){const body=JSON.stringify(ex.open_turn).replace('"expected_revision":0',`"expected_revision":${token}`);expect(decodeDCContract("open-turn",body).expected_revision).toBe(Number(token));}});
 it("rejects unknown fields, versions and dates without echoing raw input",()=>{
  for(const value of [{...ex.open_turn,runtime_contract_version:"0.2.0"},{...ex.open_turn,owner_id:"forged"},{...ex.open_turn,event:{...ex.open_turn.event,received_at:"2030-02-31T00:00:00Z"}}])expect(()=>parseDCContract("open-turn",value)).toThrow();
  try{decodeDCContract("open-turn",'{"SECRET_RAW_TEXT":');}catch(e){expect(e).toMatchObject({code:"INVALID_JSON"});expect(String(e)).not.toContain("SECRET_RAW_TEXT");}
 });
});
function typeBoundary(v:DecisionContextContracts["open-turn"]){const version:"0.1.0"=v.runtime_contract_version;void version;
 // @ts-expect-error Original contract version is a fixed literal.
 v.runtime_contract_version="0.2.0";
}
void typeBoundary;
