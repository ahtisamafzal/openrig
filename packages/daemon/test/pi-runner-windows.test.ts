import { describe, it, expect } from "vitest";
import { resolvePiSpawn } from "../src/adapters/pi-runner.js";
import { buildPiChildEnv } from "../src/adapters/pi-runner-protocol.js";

const SHIM = String.raw`endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js" %*`;

describe("Pi launch on Windows", () => {
  it("runs the npm shim's JS entry under node instead of the .cmd", () => {
    const files: Record<string, string> = { [String.raw`C:\npm\pi.cmd`]: SHIM };
    const read = (p: string) => { if (p in files) return files[p]!; throw new Error("ENOENT"); };
    const r = resolvePiSpawn(["--mode", "rpc", "--model", "a b"], { PATH: String.raw`C:\missing;C:\npm` }, "win32", read);
    expect(r.command).toBe(process.execPath);
    expect(r.args).toEqual([
      String.raw`C:\npm\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js`, "--mode", "rpc", "--model", "a b",
    ]);
    expect(resolvePiSpawn(["x"], { PATH: "/usr/bin" }, "linux")).toEqual({ command: "pi", args: ["x"] });
  });

  it("keeps the Windows system variables node needs, only on Windows", () => {
    const src = { PATH: "p", SystemRoot: String.raw`C:\Windows`, APPDATA: "a", SECRET_TOKEN: "no" };
    const opts = { agentDir: "ad", sessionsDir: "sd" };
    expect(buildPiChildEnv(src, opts, "win32")).toMatchObject({ SystemRoot: String.raw`C:\Windows`, APPDATA: "a" });
    expect(buildPiChildEnv(src, opts, "win32").SECRET_TOKEN).toBeUndefined();
    expect(buildPiChildEnv(src, opts, "linux").SystemRoot).toBeUndefined();
  });
});
