import { describe, expect, it } from "vitest";
import { selectTraceRequestChain } from "./trace-request-chain";

function row(id: string, parent?: string) {
  return {
    id, request_id: id, created_at: id,
    steps: parent ? [{ type: "tool", metadata: { parentRequestId: parent } }] : [],
  };
}

describe("trace request chain", () => {
  const root = row("1");
  const first = row("2", "1");
  const unrelated = row("3");
  const second = row("4", "2");
  const sibling = row("5", "1");
  const rows = [sibling, unrelated, first, second, root];

  it.each([root, first, second])("merges only linked continuations when selecting request $id", (selected) => {
    expect(selectTraceRequestChain(rows, selected).map((item) => item.id)).toEqual(["1", "2", "4", "5"]);
  });

  it("leaves unrelated requests independent", () => {
    expect(selectTraceRequestChain(rows, unrelated)).toEqual([unrelated]);
  });

  it("preserves the selected row if the related query omits it", () => {
    expect(selectTraceRequestChain([first], root)).toEqual([root, first]);
  });

  it("handles missing parents, malformed steps and cyclic links", () => {
    const child = row("2", "missing");
    expect(selectTraceRequestChain([child, { ...unrelated, steps: null }], child)).toEqual([child]);
    const a = row("1", "2");
    const b = row("2", "1");
    expect(selectTraceRequestChain([a, b], a)).toEqual([a, b]);
  });
});
