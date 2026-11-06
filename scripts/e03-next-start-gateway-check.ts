import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createSameOriginE03Gateway } from "../src/server/decision-context/host-runtime/same-origin-gateway-candidate";

async function freePort(){const server=http.createServer();server.listen(0,"127.0.0.1");await once(server,"listening");const address=server.address();if(!address||typeof address==="string")throw Error("NO_PORT");const port=address.port;await new Promise<void>(resolve=>server.close(()=>resolve()));return port;}
const port=await freePort();
const next=spawn(process.execPath,["node_modules/next/dist/bin/next","start","-p",String(port),"-H","127.0.0.1"],{env:{...process.env,NODE_ENV:"production"},stdio:"ignore"});
let gateway:http.Server|undefined;
try {
  let ready=false;
  for(let attempt=0;attempt<100;attempt++){
    if(next.exitCode!==null)throw Error("NEXT_EXITED");
    try{const response=await fetch(`http://127.0.0.1:${port}/api/health`);if(response.ok){ready=true;break;}}catch{/* starting */}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  if(!ready)throw Error("NEXT_START_TIMEOUT");
  gateway=http.createServer(createSameOriginE03Gateway(async(_request,response)=>{response.writeHead(503,{"cache-control":"no-store"});response.end();},`http://127.0.0.1:${port}`));
  gateway.listen(0,"127.0.0.1");await once(gateway,"listening");
  const address=gateway.address();if(!address||typeof address==="string")throw Error("NO_GATEWAY");
  const origin=`http://127.0.0.1:${address.port}`;
  const nextResponse=await fetch(`${origin}/api/health`),e03Response=await fetch(`${origin}/runtime/trips/trip_test/pages`);
  const health=await nextResponse.json();
  if(nextResponse.status!==200||JSON.stringify(health)!==JSON.stringify({status:"ok",service:"antu-mvp"})||e03Response.status!==503)throw Error("ROUTE_MISMATCH");
  process.stdout.write(JSON.stringify({next_start:true,same_origin_proxy:true,health_status:nextResponse.status,e03_status:e03Response.status})+"\n");
} finally {
  if(gateway?.listening)await new Promise<void>(resolve=>gateway!.close(()=>resolve()));
  next.kill("SIGTERM");
  if(next.exitCode===null)await Promise.race([once(next,"exit"),new Promise(resolve=>setTimeout(resolve,2000))]);
  if(next.exitCode===null)next.kill("SIGKILL");
}
