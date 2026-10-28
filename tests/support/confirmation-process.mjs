// Independent Node process running the actual TS service. This loader is test tooling, not an app adapter.
import fs from "node:fs";
import path from "node:path";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

if (process.env.NODE_ENV !== "test" || !process.send) throw new Error("Isolated IPC test process required");
const root = process.cwd();
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && context.parentURL?.startsWith(pathToFileURL(root + "/src/").href)) {
      const location = fileURLToPath(new URL(specifier, context.parentURL));
      const candidate = [location, location + ".ts", location + ".js"].find((name) => fs.existsSync(name) && fs.statSync(name).isFile());
      if (candidate) return { url: pathToFileURL(candidate).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith(pathToFileURL(root + "/src/").href) && url.endsWith(".ts")) {
      return { format: "module", source: ts.transpileModule(fs.readFileSync(fileURLToPath(url), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText, shortCircuit: true };
    }
    if (url.startsWith(pathToFileURL(root + "/specs/").href) && url.endsWith(".json")) {
      return { format: "module", source: `export default ${fs.readFileSync(fileURLToPath(url), "utf8")}`, shortCircuit: true };
    }
    return next(url, context);
  },
});
const config = JSON.parse(fs.readFileSync(process.env.E02_STORAGE_ENV_FILE, "utf8"));
if (!/^antu_e02_test_[a-z0-9_]+$/.test(config.database)) throw new Error("Disposable PostgreSQL required");
const { openTripCommandService } = await import(pathToFileURL(path.join(root, "src/server/trip-state/internal/persistence.ts")).href);
process.once("message", async (message) => {
  const connection = new URL(config.runtimeUrl);
  if (message.applicationName) connection.searchParams.set("application_name", message.applicationName);
  let nextUuid = message.uuidStart;
  const service = await openTripCommandService(connection.toString(), {
    ...(message.clock ? { clock: () => new Date(message.clock) } : {}),
    ...(typeof nextUuid === "number" ? { uuid: () => (nextUuid++).toString(16).padStart(32, "0") } : {}),
    authorize: (trip, credential) => {
      if (trip !== message.tripId || credential !== "synthetic-child-session") throw new Error("Denied by synthetic child host");
      // Explicit synthetic host fixtures only; this IPC process is guarded by NODE_ENV and a disposable database.
      const actors = { model: { role: "model", id: "scenario-ai" }, user: { role: "user", id: "scenario-user" },
        tool: { role: "tool", id: "scenario-provider" }, system: { role: "system", id: "scenario-system" } };
      const role = message.syntheticActor ?? (message.method === "submit" ? "model" : "user");
      if (!Object.hasOwn(actors, role)) throw new Error("Unknown synthetic host fixture");
      return { tripId: trip, actor: actors[role] };
    },
  });
  try {
    const response = message.method === "submit" ? await service.submit(message.tripId, message.request, "synthetic-child-session")
      : await service.confirm(message.tripId, message.proposalId, message.request, "synthetic-child-session");
    process.send({ response, processId: process.pid });
  } finally { await service.close(); process.disconnect(); }
});
process.send({ ready: true });
