import { describe, it, expect } from "vitest";
import { validateResumeToken } from "../src/domain/resume-token-validation.js";

const pi = (token: string) => validateResumeToken("pi", token);

describe("Pi session-file token on Windows paths", () => {
  it("accepts a drive-letter absolute path", () => {
    expect(pi(String.raw`F:\Projects\arete-rig\.openrig-home\pi\team-scout@arete-trio\sessions\abc.jsonl`)).toMatchObject({ ok: true });
    expect(pi("/home/a/.openrig/pi/s/sessions/abc.jsonl")).toMatchObject({ ok: true });
  });

  it("still refuses relative paths, traversal, stray colons and shell metacharacters", () => {
    for (const bad of [
      String.raw`Projects\x.jsonl`,
      String.raw`F:\a\..\b\x.jsonl`,
      String.raw`F:\a:b\x.jsonl`,
      String.raw`F:\a b\x.jsonl`,
      String.raw`F:\a\$(rm)\x.jsonl`,
      "F:/a/x.jsonl",
      String.raw`\\server\share\x.jsonl`,
    ]) expect(pi(bad), bad).toMatchObject({ ok: false });
  });
});
