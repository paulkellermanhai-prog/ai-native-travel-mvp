import {describe,expect,it} from "vitest";
import {NapPhaseTransitionError,nextActionPhase} from "../../src/server/next-action-policy/action-phase";

const evaluate={kind:"evaluate",structureValid:true,eligibilityPassed:true};
const start={kind:"start",dependenciesCurrent:true,authorized:true,stepConditionsMet:true,claimAcquired:true};

describe("E04 Action phase pure transition",()=>{
  it("advances valid phases and marks an unknown execution for receipt lookup",()=>{
    expect(nextActionPhase("proposed",evaluate)).toEqual({phase:"eligible",receiptLookupRequired:false});
    expect(nextActionPhase("eligible",start)).toEqual({phase:"running",receiptLookupRequired:false});
    expect(nextActionPhase("running",{kind:"execution_unknown"})).toEqual({phase:"running",receiptLookupRequired:true});
    expect(nextActionPhase("running",{kind:"await_confirmation",proposalRecorded:true})).toEqual({phase:"waiting_user",receiptLookupRequired:false});
    expect(nextActionPhase("running",{kind:"complete",basisCurrent:true,outcome:"success"}).phase).toBe("succeeded");
  });
  it("supports waiting, resume, invalidation, cancellation and terminal outcomes",()=>{
    expect(nextActionPhase("eligible",{kind:"await_user",userInputRequired:true}).phase).toBe("waiting_user");
    expect(nextActionPhase("waiting_user",{kind:"resume",feedbackVerified:true,basisCurrent:true,scopeAuthorized:true}).phase).toBe("eligible");
    expect(nextActionPhase("waiting_user",{kind:"invalidate"}).phase).toBe("stale");
    expect(nextActionPhase("eligible",{kind:"cancel",hostConfirmed:true}).phase).toBe("cancelled");
    expect(nextActionPhase("running",{kind:"complete",basisCurrent:true,outcome:"partial"}).phase).toBe("partial");
    expect(nextActionPhase("running",{kind:"complete",basisCurrent:true,outcome:"failure"}).phase).toBe("failed");
    expect(nextActionPhase("running",{kind:"complete",basisCurrent:false,outcome:"success"}).phase).toBe("stale");
  });
  it("rejects missing guards and never revives terminal phases",()=>{
    expect(()=>nextActionPhase("eligible",{...start,authorized:false})).toThrow(NapPhaseTransitionError);
    for(const phase of ["blocked","partial","succeeded","failed","stale","cancelled"])
      expect(()=>nextActionPhase(phase,evaluate)).toThrow(NapPhaseTransitionError);
  });
});
