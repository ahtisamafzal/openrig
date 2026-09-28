import { beforeEach, describe, expect, it } from "vitest";
import { classifyPaneWithJev, jevPaneEnabled, paneVerdict, redactSecrets, resetJevPaneClassifier } from "../src/domain/jev-pane-classifier.js";

const env = { TYPESAFE_API_KEY: "test-key", OPENRIG_JEV_PANE_CLASSIFICATION: "1" } as NodeJS.ProcessEnv;
const answer = (asks: number, busy: number) =>
  new Response(JSON.stringify({ answers: { asks: { type: "noul", noul: asks }, busy: { type: "noul", noul: busy } } }), { status: 200 });
function fakeFetch(...responses: Array<Response | Error>) {
  let calls = 0;
  const f = (async () => {
    calls++;
    const next = responses.shift();
    if (!next) throw new Error("unexpected call");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { f, calls: () => calls };
}

describe("classifyPaneWithJev (offline)", () => {
  beforeEach(() => resetJevPaneClassifier());

  it("needs both the key and the dedicated pane-upload opt-in", async () => {
    expect(jevPaneEnabled({})).toBe(false);
    expect(jevPaneEnabled({ TYPESAFE_API_KEY: "k" })).toBe(false);
    expect(jevPaneEnabled({ OPENRIG_JEV_PANE_CLASSIFICATION: "1" })).toBe(false);
    expect(jevPaneEnabled(env)).toBe(true);
    const none = fakeFetch();
    expect(await classifyPaneWithJev("screen", { env: { TYPESAFE_API_KEY: "k" }, fetch: none.f })).toBeNull();
    expect(none.calls()).toBe(0);
  });

  it("masks secrets before the screen leaves the machine", () => {
    const out = redactSecrets([
      "export OPENROUTER_API_KEY=sk-or-v1-abcdefghijklmnop",
      "curl -H 'Authorization: Bearer abc.def.ghijklmnopqrstu'",
      "token: ghp_ABCDEFGHIJKLMNOP1234",
      "password=hunter2hunter2",
      "key apikey_2214bcf76a67f010",
      "plain text stays",
    ].join("\n"));
    for (const secret of ["sk-or-v1", "abc.def.ghijk", "ghp_ABC", "hunter2", "apikey_2214"]) expect(out).not.toContain(secret);
    expect(out).toContain("plain text stays");
    expect(out).toContain("password=[redacted]");
  });

  it("masks credential assignments, URL passwords, npm tokens and private keys", () => {
    const out = redactSecrets([
      "DATABASE_URL=postgres://app:s3cretPw@db.internal:5432/prod",
      "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      "GITHUB_TOKEN: abc123def456ghi789",
      "db_password = 'tiger-tiger'",
      "//registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrstuvwxyz0123",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "b3BlbnNzaC1rZXktdjEAAAAABG5vbmU",
      "-----END OPENSSH PRIVATE KEY-----",
      "Working (3s • esc to interrupt)",
    ].join("\n"));
    for (const secret of ["s3cretPw", "wJalrXUtnFEMI", "abc123def456", "tiger-tiger", "npm_abcdef", "b3BlbnNzaC1"]) expect(out).not.toContain(secret);
    expect(out).toContain("postgres://app:[redacted]@db.internal");
    expect(out).toContain("Working (3s • esc to interrupt)");
  });

  it("a long private key never reaches the request body, even when its header is cut off", async () => {
    const body = Array.from({ length: 12 }, (_, i) => `${"QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo"}${String(i).padStart(10, "0")}xyz`);
    for (const screen of [
      ["-----BEGIN OPENSSH PRIVATE KEY-----", ...body, "-----END OPENSSH PRIVATE KEY-----", "$"].join("\n"),
      [...body, "-----END OPENSSH PRIVATE KEY-----", "$"].join("\n"), // BEGIN scrolled off
      [...body, "QUJDREVGR0hJSktMTU5Pshort==", "-----END RSA PRIVATE KEY-----", "$"].join("\n"), // short final line
    ]) {
      resetJevPaneClassifier();
      let sent = "";
      const f = (async (_u: string, init: RequestInit) => {
        sent = String(init.body);
        return answer(0.05, 0.9);
      }) as unknown as typeof fetch;
      await classifyPaneWithJev(screen, { env, fetch: f });
      expect(sent).not.toContain("QUJDREVGR0hJSktMTU5P");
    }
  });

  it("never caches idle (a stable prompt screen must be re-asked)", async () => {
    const ff = fakeFetch(answer(0.05, 0.1), answer(0.05, 0.1));
    await classifyPaneWithJev("quiet", { env, fetch: ff.f });
    await classifyPaneWithJev("quiet", { env, fetch: ff.f });
    expect(ff.calls()).toBe(2);
  });

  it("combines the two answers; needs_input beats busy; idle needs two confident no's", () => {
    expect(paneVerdict(0.7, 0.9)).toEqual({ state: "needs_input", confidence: 0.7 });
    expect(paneVerdict(0.1, 0.8)).toEqual({ state: "running", confidence: 0.8 });
    expect(paneVerdict(0.1, 0.2)).toEqual({ state: "idle", confidence: 0.8 });
    expect(paneVerdict(0.4, 0.1)).toBeNull();
    expect(paneVerdict(0.1, 0.5)).toBeNull();
  });

  it("reads both answers from one call", async () => {
    expect(await classifyPaneWithJev("a", { env, fetch: fakeFetch(answer(0.05, 0.1)).f })).toEqual({ state: "idle", confidence: 0.9 });
  });

  it("caches per screen text", async () => {
    const ff = fakeFetch(answer(0.05, 0.9));
    await classifyPaneWithJev("same", { env, fetch: ff.f });
    await classifyPaneWithJev("same", { env, fetch: ff.f });
    expect(ff.calls()).toBe(1);
  });

  it("an outage trips a 60s breaker", async () => {
    let t = 1_000;
    const now = () => t;
    expect(await classifyPaneWithJev("x", { env, fetch: fakeFetch(new Error("down")).f, now })).toBeNull();
    const idle = fakeFetch();
    expect(await classifyPaneWithJev("y", { env, fetch: idle.f, now })).toBeNull();
    expect(idle.calls()).toBe(0);
    t += 61_000;
    expect(await classifyPaneWithJev("y", { env, fetch: fakeFetch(answer(0.05, 0.9)).f, now })).toEqual({ state: "running", confidence: 0.9 });
  });
});

// Live: real TypeSafe calls with the operator's key (skipped when TYPESAFE_API_KEY is unset).
// Screens are real captures from the Windows trio smoke (2026-09-28).
describe.skipIf(!process.env.TYPESAFE_API_KEY?.trim())("classifyPaneWithJev (live TypeSafe)", () => {
  beforeEach(() => {
    resetJevPaneClassifier();
    process.env.OPENRIG_JEV_PANE_CLASSIFICATION = "1";
  });

  it("Codex approval prompt -> needs_input", async () => {
    const screen = [
      "• Running rig whoami --json",
      "  Would you like to run the following command?",
      "  Environment: local",
      "  $ rig whoami --json",
      "› 1. Yes, proceed (y)",
      "  2. Yes, and don't ask again for commands that start with `rig whoami` (p)",
      "  3. No, and tell Codex what to do differently (esc)",
      "  Press enter to confirm or esc to cancel",
    ].join("\n");
    expect((await classifyPaneWithJev(screen))?.state).toBe("needs_input");
  }, 20_000);

  it("Claude finished turn at empty prompt -> idle", async () => {
    const screen = [
      "● PONG",
      "✻ Brewed for 12s · done 8:36 PM",
      "──────────────────────────────────────────",
      "❯",
      "──────────────────────────────────────────",
      "  ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents",
    ].join("\n");
    expect((await classifyPaneWithJev(screen))?.state).toBe("idle");
  }, 20_000);

  it("Codex mid-task -> running", async () => {
    const screen = [
      "• Explored",
      "  └ Read SKILL.md (openrig-skills skill)",
      "• Working (33s • esc to interrupt)",
      "  └ Tip: Use /export to save your conversation as Markdown.",
      "› Ask Codex to do anything",
      "  GPT-5.6-Sol default fast · F:\\Projects\\arete-rig-sandbox",
    ].join("\n");
    expect((await classifyPaneWithJev(screen))?.state).toBe("running");
  }, 20_000);

  it("Codex finished turn at empty composer -> idle (the heuristics return unknown here)", async () => {
    const screen = [
      "• Step 3 of 3 blocked: QA identity is confirmed as team.review@arete-trio, but no review assignment exists.",
      "  Next: assign a slice or provide the candidate branch/commit to verify.",
      "  Worked for 9m 47s · 20:43",
      "› Ask Codex to do anything",
      "  GPT-5.6-Sol default fast · F:\\Projects\\arete-rig-sandbox · Verify assigned outcome",
      "  ? for shortcuts                                                   ⚠ 4 warnings · f2 to view",
    ].join("\n");
    expect((await classifyPaneWithJev(screen))?.state).toBe("idle");
  }, 20_000);
});
