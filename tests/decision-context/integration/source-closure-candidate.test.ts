import { describe, expect, it } from "vitest";
import { classifySourceClosure, type SourceNode } from "../../../src/server/decision-context/integration/source-closure-candidate";

const scope = { owner: "owner", trip: "trip", workspace: "workspace" };
const event = (id: string, eventId = id): SourceNode => ({ id, scope, kind: "event", eventId });
const artifact = (id: string, parents: string[], inputsComplete = true): SourceNode =>
  ({ id, scope, kind: "artifact", parents, inputsComplete });
const classify = (nodes: SourceNode[], rootId: string, deletedEventId = "A") =>
  classifySourceClosure({ nodes, rootId, deletedEventId, scope });

describe("isolated source-closure deletion planner", () => {
  it("distinguishes independent scenes, direct and transitive dependencies", () => {
    const graph = [event("A"), event("B"), artifact("task-B", ["B"]), artifact("scene-B", ["task-B"]),
      artifact("summary-A", ["A"]), artifact("task-mixed", ["B", "summary-A"]), artifact("scene-mixed", ["task-mixed"])];
    expect(classify(graph, "scene-B")).toBe("independent");
    expect(classify(graph, "scene-mixed")).toBe("affected");
    expect(classify(graph, "A")).toBe("affected");
    expect(classify(graph, "scene-B", "B")).toBe("affected");
  });

  it("treats an incomplete, empty, missing or cyclic ancestry as unknown", () => {
    expect(classify([event("B"), artifact("scene", ["B"], false)], "scene")).toBe("unknown");
    expect(classify([artifact("scene", [])], "scene")).toBe("unknown");
    expect(classify([artifact("scene", ["missing"])], "scene")).toBe("unknown");
    expect(classify([artifact("scene", ["task"]), artifact("task", ["scene"])], "scene")).toBe("unknown");
    expect(classify([event("A"), artifact("scene", ["A", "missing"])], "scene")).toBe("unknown");
  });

  it("rejects a cross-workspace path, duplicate identities and malformed parent lists", () => {
    const foreign: SourceNode = { id: "B", kind: "event", eventId: "B", scope: { ...scope, workspace: "other" } };
    expect(classify([foreign, artifact("scene", ["B"])], "scene")).toBe("unknown");
    expect(classify([event("B"), event("B"), artifact("scene", ["B"])], "scene")).toBe("unknown");
    expect(classify([event("B"), artifact("scene", ["B", "B"])], "scene")).toBe("unknown");
    expect(classify([event("B"), artifact("scene", [""])], "scene")).toBe("unknown");
  });

  it("uses event identity rather than text similarity and handles shared ancestors", () => {
    const graph = [event("event-one", "A"), event("event-two", "B"), artifact("task-1", ["event-two"]),
      artifact("task-2", ["event-two"]), artifact("scene", ["task-1", "task-2"])];
    expect(classify(graph, "scene")).toBe("independent");
    expect(classify(graph, "scene", "B")).toBe("affected");
  });

  it("fails closed at graph limits and for absent or malformed roots", () => {
    expect(classify(Array.from({ length: 513 }, (_, i) => event(`e${i}`)), "e0")).toBe("unknown");
    const parents = Array.from({ length: 257 }, (_, i) => `e${i}`);
    expect(classify([...parents.map(id => event(id)), artifact("scene", parents)], "scene")).toBe("unknown");
    expect(classify([event("B")], "missing")).toBe("unknown");
    expect(classifySourceClosure({ nodes: [event("B")], rootId: "B", deletedEventId: "A", scope: { ...scope, trip: "" } })).toBe("unknown");
  });
});
