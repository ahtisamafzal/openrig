import { describe, it, expect } from "vitest";
import nodePath from "node:path";
import { claudeMcpArgs, codexMcpArgs } from "../src/adapters/yolo-mode.js";

describe("claudeMcpArgs", () => {
  const seat = nodePath.join("seat", ".mcp.json");
  it("is off unless OPENRIG_SEAT_STRICT_MCP is set, so the command stays byte-identical", () => {
    expect(claudeMcpArgs({}, "seat", () => true)).toBe("");
  });
  it("uses only the seat's own .mcp.json when strict", () => {
    expect(claudeMcpArgs({ OPENRIG_SEAT_STRICT_MCP: "1" }, "seat", (p) => p === seat))
      .toBe(` --strict-mcp-config --mcp-config '${seat}'`);
    expect(claudeMcpArgs({ OPENRIG_SEAT_STRICT_MCP: "true" }, "seat", () => false)).toBe(" --strict-mcp-config");
  });
  it("disables Codex plugins and tool apps only when strict", () => {
    expect(codexMcpArgs({})).toBe("");
    expect(codexMcpArgs({ OPENRIG_SEAT_STRICT_MCP: "1" })).toBe(" --disable plugins --disable apps --disable computer_use");
  });
});
