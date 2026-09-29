import { execFileSync } from "node:child_process";

/** 5.2: a gateway secrets env file must be readable by the current user only; on Windows the temp
 *  folder a test writes into can grant other principals, which the daemon now refuses. */
export function restrictToCurrentUser(file: string): void {
  if (process.platform !== "win32") return;
  execFileSync("icacls", [file, "/inheritance:r", "/grant:r", `${process.env.USERNAME}:F`], { windowsHide: true, stdio: "ignore" });
}
