import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { CODEX_SEAT_ENV_VARS, codexSeatEnvArg } from "../src/adapters/yolo-mode.js";

describe("codexSeatEnvArg (seat identity survives shell_environment_policy)", () => {
  const on = { OPENRIG_CODEX_SEAT_ENV: "1" } as NodeJS.ProcessEnv;

  it("is off (byte-identical launch) unless OPENRIG_CODEX_SEAT_ENV=1", () => {
    expect(codexSeatEnvArg({})).toBe("");
  });

  it("re-injects every seat var through the policy's set table", () => {
    const arg = codexSeatEnvArg(on);
    for (const v of CODEX_SEAT_ENV_VARS) expect(arg).toContain(`-c "shell_environment_policy.set.${v}=\\"$${v}\\""`);
  });

  it.skipIf(process.platform === "win32" && !process.env.SHELL && !process.env.MSYSTEM)(
    "expands to TOML string overrides in the seat shell",
    () => {
      const out = execFileSync("bash", ["-c", `printf '%s\\n' ${codexSeatEnvArg(on)}`], {
        env: { ...process.env, OPENRIG_SESSION_NAME: "dev-qa@r", OPENRIG_NODE_ID: "n1" },
        encoding: "utf8",
      });
      expect(out).toContain('shell_environment_policy.set.OPENRIG_SESSION_NAME="dev-qa@r"');
      expect(out).toContain('shell_environment_policy.set.OPENRIG_NODE_ID="n1"');
    },
  );
});
