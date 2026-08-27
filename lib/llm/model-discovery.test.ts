import { describe, expect, it } from "vitest";
import { normalizeDiscoveredModels } from "./model-discovery";

describe("OpenAI-compatible model discovery", () => {
  it("normalizes the standard data array and sorts unique model IDs", () => {
    expect(normalizeDiscoveredModels({
      object: "list",
      data: [
        { id: "model-b", owned_by: "provider" },
        { id: "model-a" },
        { id: "model-b", owned_by: "provider" },
      ],
    })).toEqual([
      { id: "model-a" },
      { id: "model-b", ownedBy: "provider" },
    ]);
  });

  it("accepts root arrays and provider-specific models arrays", () => {
    expect(normalizeDiscoveredModels(["model-a", { name: "model-b" }]))
      .toEqual([{ id: "model-a" }, { id: "model-b" }]);
    expect(normalizeDiscoveredModels({ models: [{ id: "model-c" }] }))
      .toEqual([{ id: "model-c" }]);
  });

  it("rejects incompatible response shapes", () => {
    expect(() => normalizeDiscoveredModels({ result: [] })).toThrow("模型列表格式");
  });
});

