import { describe, it, expect } from "vitest";
import { HerdrSeatAdapter, toHerdrKey } from "../src/adapters/herdr-seat-adapter.js";

const ok = (result: unknown) => JSON.stringify({ id: "cli", result });
const err = (code: string) => JSON.stringify({ id: "cli", error: { code, message: code } });

/** Fake herdr: one seat `dev-impl@r` (w2:p1) in workspace `openrig:r`, plus a foreign pane. */
function fakeHerdr(opts: { serverDown?: boolean } = {}) {
  const calls: string[][] = [];
  const exec = async (args: string[]) => {
    calls.push(args);
    if (opts.serverDown) return err("server_not_running");
    const [a, b] = args;
    if (a === "workspace" && b === "list") {
      return ok({ workspaces: [{ workspace_id: "w1", label: "Projects" }, { workspace_id: "w2", label: "openrig:r" }] });
    }
    if (a === "pane" && b === "list") {
      return ok({ panes: [
        { pane_id: "w1:p1", workspace_id: "w1", label: "dev-impl@r" }, // same label outside openrig:* — must be ignored
        { pane_id: "w2:p1", workspace_id: "w2", label: "dev-impl@r", revision: 1 },
      ] });
    }
    if (a === "pane" && b === "get") return args[2] === "w2:p1" ? ok({ pane: { pane_id: "w2:p1", workspace_id: "w2" } }) : err("pane_not_found");
    return ok({ type: "ok" });
  };
  return { calls, exec };
}

describe("toHerdrKey", () => {
  it("maps tmux key names to herdr names and passes other text through", () => {
    expect(toHerdrKey("C-m")).toEqual({ key: "enter" });
    expect(toHerdrKey("Enter")).toEqual({ key: "enter" });
    expect(toHerdrKey("Escape")).toEqual({ key: "esc" });
    expect(toHerdrKey("C-c")).toEqual({ key: "ctrl+c" });
    expect(toHerdrKey("M-x")).toEqual({ key: "alt+x" });
    expect(toHerdrKey("3")).toEqual({ text: "3" });
    expect(toHerdrKey("")).toBeNull();
  });
});

describe("HerdrSeatAdapter", () => {
  it("resolves seats only inside openrig:* workspaces", async () => {
    const h = fakeHerdr();
    const t = new HerdrSeatAdapter({ exec: h.exec });
    expect(await t.probeSession("dev-impl@r")).toEqual({ state: "present" });
    expect(await t.probeSession("dev-check@r")).toEqual({ state: "absent" });
    expect((await t.listPanes("dev-impl@r"))[0]?.id).toBe("w2:p1");
    expect((await t.listSessions()).map((s) => s.name)).toEqual(["dev-impl@r"]);
  });

  it("reports an unreachable server as transport_unavailable, never absent", async () => {
    const t = new HerdrSeatAdapter({ exec: fakeHerdr({ serverDown: true }).exec });
    expect((await t.probeSession("dev-impl@r")).state).toBe("transport_unavailable");
  });

  it("opens a window and waits when the server is down at start", async () => {
    let opened = "";
    const h = fakeHerdr({ serverDown: true });
    const t = new HerdrSeatAdapter({ session: "s1", exec: h.exec, openWindow: (s) => { opened = s; } });
    const started = t.startServer();
    expect((await Promise.race([started, new Promise((r) => setTimeout(() => r("pending"), 50))]))).toBe("pending");
    expect(opened).toBe("s1");
  });

  it("wraps multi-line text in bracketed paste so a newline does not submit", async () => {
    const h = fakeHerdr();
    const t = new HerdrSeatAdapter({ exec: h.exec });
    expect(await t.sendText("dev-impl@r", "one\ntwo")).toEqual({ ok: true });
    expect(await t.sendText("dev-impl@r", "single")).toEqual({ ok: true });
    const sends = h.calls.filter((c) => c[1] === "send-text").map((c) => c[3]);
    expect(sends).toEqual(["\x1b[200~one\ntwo\x1b[201~", "single"]);
  });

  it("maps a missing seat to session_not_found", async () => {
    const t = new HerdrSeatAdapter({ exec: fakeHerdr().exec });
    expect(await t.sendKeys("nope@r", ["C-m"])).toMatchObject({ ok: false, code: "session_not_found" });
  });

  it("fails loudly instead of running tmux for unmapped calls", async () => {
    const t = new HerdrSeatAdapter({ exec: fakeHerdr().exec });
    expect(await t.respawnPane("w2:p1")).toMatchObject({ ok: false, code: "unsupported" });
  });
});
