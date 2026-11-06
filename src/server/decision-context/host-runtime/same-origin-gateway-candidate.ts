import http, { type IncomingMessage, type ServerResponse } from "node:http";

const hopHeaders=new Set(["connection","proxy-connection","proxy-authorization","proxy-authenticate","keep-alive","transfer-encoding","upgrade","te","trailer"]);
function stripHopHeaders(headers:Record<string,string|string[]|undefined>) {
  const nominated=typeof headers.connection==="string"?headers.connection.split(","):[];
  for(const header of [...hopHeaders,...nominated.map(value=>value.trim().toLowerCase())])delete headers[header];
}

/**
 * Single-instance loopback integration: the public listener sends E03 routes
 * to the in-process Node host and proxies all other paths to `next start`.
 * The upstream is fixed at installation, never derived from client headers.
 * This is a local acceptance gateway, not a production deployment entry.
 */
export function createSameOriginE03Gateway(
  e03:(request:IncomingMessage,response:ServerResponse)=>Promise<void>,nextOrigin:string,
) {
  const upstream=new URL(nextOrigin);
  if(upstream.protocol!=="http:"||!["127.0.0.1","localhost","[::1]"].includes(upstream.hostname)||upstream.username||upstream.password||upstream.pathname!=="/")
    throw new Error("NEXT_UPSTREAM_MUST_BE_LOOPBACK");
  return (request:IncomingMessage,response:ServerResponse) => {
    const path=request.url;
    if(!path?.startsWith("/")||path.startsWith("//")){response.writeHead(400,{"cache-control":"no-store"});response.end();return;}
    if(/^\/runtime\/trips\//.test(path)){void e03(request,response).catch(()=>{if(!response.headersSent&&!response.destroyed){response.writeHead(503,{"cache-control":"no-store"});response.end();}else response.destroy();});return;}
    if(request.headers.upgrade){response.writeHead(426,{"cache-control":"no-store"});response.end();return;}
    const headers:Record<string,string|string[]|undefined>={...request.headers};
    stripHopHeaders(headers);
    const proxied=http.request({hostname:upstream.hostname,port:upstream.port,path,method:request.method,headers},upstreamResponse=>{
      const outgoing:Record<string,string|string[]|undefined>={...upstreamResponse.headers};
      stripHopHeaders(outgoing);
      response.writeHead(upstreamResponse.statusCode??502,outgoing);upstreamResponse.pipe(response);
    });
    proxied.setTimeout(15_000,()=>proxied.destroy(new Error("UPSTREAM_TIMEOUT")));
    proxied.on("error",()=>{if(!response.headersSent&&!response.destroyed){response.writeHead(502,{"cache-control":"no-store"});response.end();}else response.destroy();});
    response.on("close",()=>{if(!response.writableEnded)proxied.destroy();});
    request.pipe(proxied);
  };
}
