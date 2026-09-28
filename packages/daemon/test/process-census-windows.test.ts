import { describe, it, expect } from "vitest";
import { defaultListProcessesStrict, parseWindowsProcessRows, windowsCensusRows } from "../src/domain/resume-metadata-refresher.js";
import { lstartToMinTs } from "../src/domain/codex-thread-id.js";
import { ProcessCensus } from "../src/domain/process-census.js";

describe("Windows process census", () => {
  it("parses tab-separated CIM rows and drops malformed lines", () => {
    const out = "4\t0\t\tSystem\tSystem\r\n1200\t4\tMon Sep 28 18:52:01 2026\tnode.exe\tC:\\x\\node.exe a b\r\nbad line\r\n";
    expect(parseWindowsProcessRows(out)).toEqual([
      { pid: 4, ppid: 0, startedAt: "", image: "System", command: "System" },
      { pid: 1200, ppid: 4, startedAt: "Mon Sep 28 18:52:01 2026", image: "node.exe", command: "C:\\x\\node.exe a b" },
    ]);
  });

  it.runIf(process.platform === "win32")("lists this process with a ps-lstart start time", async () => {
    const rows = await defaultListProcessesStrict();
    const self = rows.find((r) => r.pid === process.pid);
    expect(self?.ppid).toBe(process.ppid);
    expect(self?.command).toContain("node");
    const startSec = lstartToMinTs(self?.startedAt);
    expect(startSec).toBeDefined();
    expect(Math.abs(startSec! * 1000 - (Date.now() - process.uptime() * 1000))).toBeLessThan(60_000);
  }, 30_000);

  it("rejects an empty or unparseable enumeration, and the census retries instead of caching it", async () => {
    expect(() => windowsCensusRows("")).toThrow();
    expect(() => windowsCensusRows("garbage only")).toThrow();
    let calls = 0;
    const census = new ProcessCensus({ list: async () => { calls++; return windowsCensusRows(calls === 1 ? "" : "4\t0\t\tSystem\tSystem"); } });
    await expect(census.list()).rejects.toThrow();
    expect(await census.list()).toEqual([{ pid: 4, ppid: 0, startedAt: "", image: "System", command: "System" }]);
  });
});
