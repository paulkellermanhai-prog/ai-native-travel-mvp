import http from "node:http";
import { once } from "node:events";
import { openEvidenceHost, type ControlledInterpreter } from "../../src/server/decision-context/host-runtime/evidence-host";
import { openEvidenceLifecycleAdapter } from "../../src/server/decision-context/host-runtime/lifecycle-adapter";
import { createPr29HostHttpCandidate } from "../../src/server/decision-context/http-adapter/pr29-host-candidate";
import { createInternalHost, issueInternalCapability } from "../../src/server/auth/internal-service";

const server=http.createServer();
server.listen(0,"127.0.0.1");
await once(server,"listening");
const address=server.address();
if(!address||typeof address==="string")throw new Error("Missing child test socket");
const origin=`http://127.0.0.1:${address.port}`;
const host=await openEvidenceHost({...process.env,BETTER_AUTH_URL:origin});
const secret=process.env.INTERNAL_SERVICE_SECRET,lifecycleUrl=process.env.E03_CHILD_LIFECYCLE_URL;
if(!secret||!lifecycleUrl)throw new Error("Missing child lifecycle configuration");
const lifecycle=await openEvidenceLifecycleAdapter(lifecycleUrl,createInternalHost(secret));
const interpret:ControlledInterpreter=async input=>{
  const prior=input.runtime_focus.tasks.find(task=>input.runtime_focus.focus_keys.includes(task.task_key));
  const key=prior?.task_key??await input.mint_task_key(0);
  return {tasks:[{task_key:key,question:input.event.text,kind:prior?.kind??"explore",target_ids:prior?.target_ids??["constraint-nights"],
    branch:prior?.branch??"actual",relation:prior?"continue":"new",related_task_keys:[],certainty:"explicit",
    evidence:[{start:0,end:Array.from(input.event.text).length,quote:input.event.text}],progress:"open",progress_evidence:null}],focus_keys:[key]};
};
const adapter=createPr29HostHttpCandidate(host,origin,interpret,async(tripId,revision)=>{
  await lifecycle.sync(await issueInternalCapability(secret,tripId,{role:"system",id:"e03-http-child"}),{trip_id:tripId,source_revision:revision,ended_at:null});
});
server.removeAllListeners("request");
server.on("request",(request,response)=>{void adapter.handle(request,response);});
process.stdout.write(`${JSON.stringify({origin})}\n`);
process.stdin.resume();
await once(process.stdin,"end");
server.close();
await once(server,"close");
await Promise.all([host.close(),lifecycle.close()]);
