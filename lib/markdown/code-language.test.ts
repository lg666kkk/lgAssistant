import { describe, expect, it } from "vitest";
import { detectCodeLanguage } from "./code-language";

describe("detectCodeLanguage", () => {
  it("detects an unlabelled JavaScript function", () => {
    expect(detectCodeLanguage(`
/** Find target in a sorted array. */
function binarySearch(arr, target) {
  let left = 0;
  return arr[left] === target ? left : -1;
}
`)).toBe("javascript");
  });

  it.each([
    ["interface User { id: number }", "typescript"],
    ["def greet(name):\n    return f\"Hello {name}\"", "python"],
    ['{"name":"assistant","enabled":true}', "json"],
    ["SELECT id, name FROM users WHERE active = true;", "sql"],
    ["This is ordinary multiline text.\nIt should stay readable.", "text"],
  ])("detects %s as %s", (code, language) => {
    expect(detectCodeLanguage(code)).toBe(language);
  });
});
