import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkEnvFilePermissions, nodeSecretFs, parseIcaclsReaders } from "../src/domain/gateway/slack/secrets.js";

// Roadmap 5.2 — on Windows the secret env file's ACL (not synthetic mode bits) decides who can read it.

describe("secret env file ACL (Windows)", () => {
  it("parses icacls: the current user, SYSTEM and Administrators are trusted; deny never grants", () => {
    const file = "C:\\Users\\op\\.openrig\\slack.env";
    const out = [
      `${file} DESKTOP-1\\op:(F)`,
      "                NT AUTHORITY\\SYSTEM:(I)(F)",
      "                BUILTIN\\Administrators:(I)(F)",
      "                BUILTIN\\Users:(I)(RX)",
      "                Everyone:(DENY)(R)",
      "                NT AUTHORITY\\Authenticated Users:(I)(M)",
      "                DESKTOP-1\\backup:(W)",
      "",
      "Successfully processed 1 files; Failed processing 0 files",
    ].join("\r\n");
    expect(parseIcaclsReaders(out, file, "op")).toEqual(["BUILTIN\\Users", "NT AUTHORITY\\Authenticated Users"]);
  });

  it("warns on win32 when others can read or the ACL is unreadable; POSIX keeps the mode check", () => {
    const fs = (readers: string[] | null) => ({ readFileSync: () => "", statMode: () => 0o666, aclReaders: () => readers });
    expect(checkEnvFilePermissions("C:\\s.env", fs([]), "win32")).toBeNull();
    expect(checkEnvFilePermissions("C:\\s.env", fs(["BUILTIN\\Users"]), "win32")).toMatch(/readable by BUILTIN\\Users.*icacls/);
    expect(checkEnvFilePermissions("C:\\s.env", fs(null), "win32")).toMatch(/could not be read/);
    expect(checkEnvFilePermissions("/s.env", fs([]), "linux")).toMatch(/0600/);
  });

  it.runIf(process.platform === "win32")("real icacls: a user-only file passes; granting Everyone read is flagged", () => {
    const dir = mkdtempSync(join(tmpdir(), "secret-acl-"));
    const file = join(dir, "slack.env");
    writeFileSync(file, "SLACK_BOT_TOKEN=synthetic\n");
    try {
      execFileSync("icacls", [file, "/inheritance:r", "/grant:r", `${process.env.USERNAME}:F`], { windowsHide: true, stdio: "ignore" });
      expect(checkEnvFilePermissions(file, nodeSecretFs)).toBeNull();
      execFileSync("icacls", [file, "/grant", "*S-1-1-0:R"], { windowsHide: true, stdio: "ignore" }); // Everyone
      expect(checkEnvFilePermissions(file, nodeSecretFs)).toMatch(/readable by Everyone/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
