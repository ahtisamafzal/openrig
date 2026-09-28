import { vi, describe, it, expect } from "vitest";
import { agentPreflight } from "../src/domain/agent-preflight.js";
import type { AgentResolverFsOps } from "../src/domain/agent-resolver.js";

// These tests drive the code against in-memory POSIX-keyed fixtures; run the code's
// path handling as POSIX so the fixtures hold on Windows too.
vi.mock("node:path", async () => {
  const actual = await vi.importActual<typeof import("node:path")>("node:path");
  return { ...actual.posix, default: actual.posix };
});


function mockFs(files: Record<string, string>): AgentResolverFsOps {
  return {
    readFile: (p: string) => { if (p in files) return files[p]!; throw new Error(`Not found: ${p}`); },
    exists: (p: string) => p in files,
  };
}

function validAgentYaml(name: string): string {
  return `name: ${name}\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []`;
}

const RIG_ROOT = "/project/rigs/my-rig";

describe("Agent preflight", () => {
  it("resolves valid agent ref successfully", () => {
    const files = {
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: validAgentYaml("impl"),
    };
    const result = agentPreflight("local:agents/impl", RIG_ROOT, mockFs(files));
    expect(result.ready).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("fails on missing agent.yaml", () => {
    const result = agentPreflight("local:agents/missing", RIG_ROOT, mockFs({}));
    expect(result.ready).toBe(false);
    expect(result.errors[0]).toMatch(/agent\.yaml/);
  });

  it("reports import collisions as warnings", () => {
    const files = {
      [`${RIG_ROOT}/agents/impl/agent.yaml`]: `name: impl\nversion: "1.0.0"\nimports:\n  - ref: local:../lib\nresources:\n  skills:\n    - id: shared\n      path: skills/shared\nprofiles:\n  default:\n    uses:\n      skills: [shared]`,
      [`${RIG_ROOT}/agents/lib/agent.yaml`]: `name: lib\nversion: "1.0.0"\nresources:\n  skills:\n    - id: shared\n      path: skills/shared\nprofiles: {}`,
    };
    const result = agentPreflight("local:agents/impl", RIG_ROOT, mockFs(files));
    expect(result.ready).toBe(true);
    expect(result.warnings.some((w) => w.includes("collision"))).toBe(true);
  });
});
