/**
 * An isolated deletion-planning candidate. This module does not establish
 * provenance: its caller must supply a transactionally verified, complete
 * graph from a trusted producer. No current host supplies that proof. In
 * particular, caller declarations, task evidence and text matching are not
 * proof of the inputs actually seen by a model.
 *
 * This result is not an authorization to save, restore, deliver, or delete.
 * Those operations additionally need the real Session, retention and deletion
 * barriers, a consistent snapshot, and atomic persistence of the graph.
 */
export type SourceScope = Readonly<{ owner: string; trip: string; workspace: string }>;
export type SourceNode = Readonly<
  | { id: string; scope: SourceScope; kind: "event"; eventId: string }
  | { id: string; scope: SourceScope; kind: "artifact"; inputsComplete: boolean; parents: readonly string[] }
>;
export type ClosureResult = "affected" | "independent" | "unknown";

const MAX_NODES = 512;
const MAX_PARENTS = 256;
const validId = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 256;
const validScope = (scope: SourceScope | undefined): scope is SourceScope =>
  !!scope && validId(scope.owner) && validId(scope.trip) && validId(scope.workspace);
const sameScope = (a: SourceScope, b: SourceScope): boolean =>
  a.owner === b.owner && a.trip === b.trip && a.workspace === b.workspace;

/** Classify a single root against a single deleted event; unknown fails closed. */
export function classifySourceClosure(input: {
  nodes: readonly SourceNode[];
  rootId: string;
  deletedEventId: string;
  scope: SourceScope;
}): ClosureResult {
  if (!Array.isArray(input.nodes) || input.nodes.length > MAX_NODES ||
      !validId(input.rootId) || !validId(input.deletedEventId) || !validScope(input.scope)) return "unknown";

  const index = new Map<string, SourceNode>();
  for (const node of input.nodes) {
    if (!node || !validId(node.id) || index.has(node.id)) return "unknown";
    index.set(node.id, node);
  }

  const visiting = new Set<string>();
  const checked = new Set<string>();
  let invalid = false;
  let affected = false;
  function visit(id: string): void {
    if (invalid || checked.has(id)) return;
    if (visiting.has(id)) { invalid = true; return; }
    const node = index.get(id);
    if (!node || !validScope(node.scope) || !sameScope(node.scope, input.scope)) { invalid = true; return; }
    visiting.add(id);
    if (node.kind === "event") {
      if (!validId(node.eventId)) invalid = true;
      else if (node.eventId === input.deletedEventId) affected = true;
    } else if (node.kind === "artifact") {
      if (node.inputsComplete !== true || !Array.isArray(node.parents) ||
          node.parents.length === 0 || node.parents.length > MAX_PARENTS ||
          node.parents.some(parent => !validId(parent)) || new Set(node.parents).size !== node.parents.length) {
        invalid = true;
      } else {
        for (const parent of node.parents) visit(parent);
      }
    } else {
      invalid = true;
    }
    visiting.delete(id);
    checked.add(id);
  }
  visit(input.rootId);
  return invalid ? "unknown" : affected ? "affected" : "independent";
}
