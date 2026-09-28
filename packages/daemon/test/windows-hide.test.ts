import { describe, it, expect } from "vitest";
import { withWindowsHide } from "../src/windows-hide.js";

describe("withWindowsHide", () => {
  it("defaults windowsHide into the options argument of every child_process shape", () => {
    const cb = () => {};
    expect(withWindowsHide("execFile", ["git", ["status"], { cwd: "x" }, cb])).toEqual(["git", ["status"], { cwd: "x", windowsHide: true }, cb]);
    expect(withWindowsHide("execFile", ["git", ["status"], cb])).toEqual(["git", ["status"], { windowsHide: true }, cb]);
    expect(withWindowsHide("exec", ["ps -A", cb])).toEqual(["ps -A", { windowsHide: true }, cb]);
    expect(withWindowsHide("spawn", ["bash"])).toEqual(["bash", { windowsHide: true }]);
    expect(withWindowsHide("spawn", ["bash", { windowsHide: false }])).toEqual(["bash", { windowsHide: false }]);
  });
});
