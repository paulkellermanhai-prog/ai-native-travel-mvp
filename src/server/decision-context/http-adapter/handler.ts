import { decodeDCContract, parseDCContract, DecisionContextContractError, type DCContractName } from "../contracts";
import { json, readJsonText, requireOrigin } from "../../http/security";
import { TripStateContractError } from "../../trip-state/contracts";
import { businessResponse, runtimeError, RuntimeHttpFault } from "../http-core/response";

type Operation = "turns" | "assemble" | "pages" | "changes" | "confirm" | "checkpoints/save" | "checkpoints/restore" | "checkpoints/delete" | "checkpoints/list" | "checkpoints/status" | "checkpoints/retry";
type Mapping = { request: DCContractName; response?: DCContractName };
const operations: Readonly<Record<Operation, Mapping>> = {
  turns: { request: "open-turn", response: "turn" }, assemble: { request: "assemble", response: "packet" }, pages: { request: "page-request", response: "page" },
  changes: { request: "change" }, confirm: { request: "confirm" },
  "checkpoints/save": { request: "scene-save", response: "scene-ack" }, "checkpoints/restore": { request: "scene-restore", response: "scene-restored" },
  "checkpoints/delete": { request: "scene-delete", response: "scene-ack" }, "checkpoints/list": { request: "scene-list", response: "scene-list-result" },
  "checkpoints/status": { request: "scene-status", response: "scene-status-result" }, "checkpoints/retry": { request: "scene-retry", response: "scene-ack" },
};
/** Host-installed operations must themselves enforce current session, ownership and transactional guards. */
export type RuntimeOperations = Partial<Record<Operation, (value: unknown) => Promise<unknown>>>;
export type RuntimeHost = { origin: string; authorize: (tripId: string, headers: Headers) => Promise<RuntimeOperations> };

/** Internal test/integration adapter; never mount publicly without the real host and all corresponding gates. */
export function createRuntimeHandler(host: RuntimeHost) {
  return async function handle(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      const match = /^\/runtime\/trips\/([A-Za-z][A-Za-z0-9_-]{0,95})\/(.+)$/.exec(path);
      if (!match) throw new RuntimeHttpFault("NOT_FOUND");
      // Auth before operation existence/method/input, and only cookie is forwarded.
      const runtime = await host.authorize(match[1], new Headers({ cookie: request.headers.get("cookie") ?? "" }));
      if (!Object.hasOwn(operations, match[2])) throw new RuntimeHttpFault("NOT_FOUND");
      const op = match[2] as Operation;
      if (request.method !== "POST") throw new RuntimeHttpFault("METHOD_NOT_ALLOWED");
      try { requireOrigin(request, host.origin); } catch { throw new RuntimeHttpFault("ACCESS_DENIED"); }
      if (!runtime[op]) throw new RuntimeHttpFault(op.startsWith("checkpoints/") ? "RECOVERY_UNAVAILABLE" : "INTERNAL_FAILURE");
      let value: unknown;
      try { value = decodeDCContract(operations[op].request, await readJsonText(request)); }
      catch (error) { if (error instanceof TripStateContractError || error instanceof DecisionContextContractError) throw new RuntimeHttpFault("CONTRACT_INVALID"); throw error; }
      const result = await runtime[op]!(value);
      return operations[op].response ? json(parseDCContract(operations[op].response!, result), 200) : businessResponse(result);
    } catch (error) {
      if (error instanceof TripStateContractError && ["PERMISSION", "ACTOR"].includes(error.code)) return runtimeError(new RuntimeHttpFault("ACCESS_DENIED"));
      return runtimeError(error);
    }
  };
}
