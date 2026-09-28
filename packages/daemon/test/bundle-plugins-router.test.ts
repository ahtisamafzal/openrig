import { vi, describe, it, expect } from "vitest";
import { routePlugins, type PluginsRouterFsOps, type RoutePluginsInput } from "../src/domain/bundle-plugins-router.js";

// These tests drive the code against in-memory POSIX-keyed fixtures; run the code's
// path handling as POSIX so the fixtures hold on Windows too.
vi.mock("node:path", async () => {
  const actual = await vi.importActual<typeof import("node:path")>("node:path");
  return { ...actual.posix, default: actual.posix };
});


// Item 6 / slice-05 Checkpoint 7.3c: bundle-plugins-router pure-function tests.
// Banked both-sides trust-boundary lesson applied: source + target containment.

function mockFs(initial: { dirs?: string[]; files?: Record<string, string> } = {}): PluginsRouterFsOps & { _copyCalls: Array<{ src: string; dest: string }>; _mkdirpCalls: string[]; _dirs: Set<string> } {
  const dirs = new Set<string>(initial.dirs ?? []);
  const files = new Map<string, string>(Object.entries(initial.files ?? {}));
  const copyCalls: Array<{ src: string; dest: string }> = [];
  const mkdirpCalls: string[] = [];
  return {
    _copyCalls: copyCalls,
    _mkdirpCalls: mkdirpCalls,
    _dirs: dirs,
    exists: (p: string) => dirs.has(p) || files.has(p),
    isDirectory: (p: string) => dirs.has(p),
    mkdirp: (p: string) => { mkdirpCalls.push(p); dirs.add(p); },
    copyDir: (src: string, dest: string) => { copyCalls.push({ src, dest }); dirs.add(dest); },
  };
}

const BUNDLE_ROOT = "/bundle/root";
const TARGET = "/operator/.openrig/plugins";

function makeInput(overrides?: Partial<RoutePluginsInput>): RoutePluginsInput {
  return {
    bundleRoot: BUNDLE_ROOT,
    declaredPlugins: [],
    targetPluginsDir: TARGET,
    ...overrides,
  };
}

describe("routePlugins", () => {
  // P1: empty plugin list
  it("empty declaredPlugins produces empty records but still mkdirp's target", () => {
    const fs = mockFs();
    const result = routePlugins(makeInput(), fs);
    expect(result.records).toEqual([]);
    expect(result.routedCount).toBe(0);
    expect(fs._mkdirpCalls).toContain(TARGET);
  });

  // P2: single plugin routes end-to-end
  it("routes one plugin: copyDir called from source to target/<id>", () => {
    const fs = mockFs({ dirs: [`${BUNDLE_ROOT}/plugins/gstack`] });
    const result = routePlugins(
      makeInput({
        declaredPlugins: [{ id: "gstack", source: { kind: "local", path: "plugins/gstack" } }],
      }),
      fs,
    );
    expect(result.routedCount).toBe(1);
    expect(result.records[0]!.status).toBe("routed");
    expect(result.records[0]!.installedAt).toBe(`${TARGET}/gstack`);
    expect(fs._copyCalls).toHaveLength(1);
    expect(fs._copyCalls[0]).toEqual({
      src: `${BUNDLE_ROOT}/plugins/gstack`,
      dest: `${TARGET}/gstack`,
    });
  });

  // P3: multiple plugins
  it("routes multiple plugins each landing at target/<id>", () => {
    const fs = mockFs({ dirs: [`${BUNDLE_ROOT}/plugins/a`, `${BUNDLE_ROOT}/plugins/b`] });
    const result = routePlugins(
      makeInput({
        declaredPlugins: [
          { id: "a", source: { kind: "local", path: "plugins/a" } },
          { id: "b", source: { kind: "local", path: "plugins/b" } },
        ],
      }),
      fs,
    );
    expect(result.routedCount).toBe(2);
    expect(fs._copyCalls).toHaveLength(2);
  });

  // P4: missing source skipped honestly
  it("missing source plugin is skipped with status=missing", () => {
    const fs = mockFs(); // no dirs
    const result = routePlugins(
      makeInput({
        declaredPlugins: [{ id: "absent", source: { kind: "local", path: "plugins/absent" } }],
      }),
      fs,
    );
    expect(result.routedCount).toBe(0);
    expect(result.records[0]!.status).toBe("missing");
    expect(fs._copyCalls).toHaveLength(0);
  });

  // P5: source path is a file (not a directory) is rejected
  it("source path that is a file (not directory) produces status=not_directory", () => {
    const fs = mockFs({ files: { [`${BUNDLE_ROOT}/plugins/notadir.txt`]: "content" } });
    const result = routePlugins(
      makeInput({
        declaredPlugins: [{ id: "x", source: { kind: "local", path: "plugins/notadir.txt" } }],
      }),
      fs,
    );
    expect(result.records[0]!.status).toBe("not_directory");
    expect(fs._copyCalls).toHaveLength(0);
  });

  // P6: SOURCE-side path escaping bundle workspace rejected
  it("source path escaping bundle workspace produces status=unsafe (source containment)", () => {
    const fs = mockFs();
    const result = routePlugins(
      makeInput({
        declaredPlugins: [{ id: "x", source: { kind: "local", path: "../escape" } }],
      }),
      fs,
    );
    expect(result.records[0]!.status).toBe("unsafe");
    expect(result.records[0]!.detail).toContain("escapes bundle workspace");
    expect(fs._copyCalls).toHaveLength(0);
  });

  // P7: TARGET-side containment — plugin id that resolves outside target rejected
  // (banked both-sides-trust-boundary lesson applied)
  it("plugin id with traversal escapes target plugins library — status=unsafe (target containment)", () => {
    const fs = mockFs({ dirs: [`${BUNDLE_ROOT}/plugins/legitsource`] });
    const result = routePlugins(
      makeInput({
        declaredPlugins: [{ id: "../escape-id", source: { kind: "local", path: "plugins/legitsource" } }],
      }),
      fs,
    );
    expect(result.records[0]!.status).toBe("unsafe");
    expect(result.records[0]!.detail).toContain("resolve outside target plugins library");
    expect(fs._copyCalls).toHaveLength(0);
  });

  // P8: invalid plugin entry (missing id or wrong source.kind) rejected
  it("plugin reference with non-local source.kind rejected", () => {
    const fs = mockFs({ dirs: [`${BUNDLE_ROOT}/plugins/x`] });
    const result = routePlugins(
      makeInput({
        declaredPlugins: [{ id: "x", source: { kind: "remote" as "local", path: "plugins/x" } }],
      }),
      fs,
    );
    expect(result.records[0]!.status).toBe("unsafe");
    expect(result.records[0]!.detail).toContain("source.kind must be 'local'");
    expect(fs._copyCalls).toHaveLength(0);
  });

  // P9: mixed list — routed + missing + unsafe + not_directory aggregate
  it("mixed plugin list aggregates by status correctly", () => {
    const fs = mockFs({
      dirs: [`${BUNDLE_ROOT}/plugins/ok`],
      files: { [`${BUNDLE_ROOT}/plugins/file.txt`]: "x" },
    });
    const result = routePlugins(
      makeInput({
        declaredPlugins: [
          { id: "good", source: { kind: "local", path: "plugins/ok" } },
          { id: "absent", source: { kind: "local", path: "plugins/missing" } },
          { id: "escapes", source: { kind: "local", path: "../escape" } },
          { id: "filething", source: { kind: "local", path: "plugins/file.txt" } },
        ],
      }),
      fs,
    );
    expect(result.records).toHaveLength(4);
    expect(result.routedCount).toBe(1);
    expect(result.rejectedCount).toBe(3);
    expect(result.records[0]!.status).toBe("routed");
    expect(result.records[1]!.status).toBe("missing");
    expect(result.records[2]!.status).toBe("unsafe");
    expect(result.records[3]!.status).toBe("not_directory");
  });
});
