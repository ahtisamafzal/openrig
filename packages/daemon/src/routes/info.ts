import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { getOpenRigInstallRoot } from "../domain/cwd-resolution.js";

/**
 * This daemon's stable identity: minted once into `<OPENRIG_HOME>/daemon-id` (exclusive create, so
 * racing starts agree) and never changed. Clients that must know WHICH daemon they reach (Arete's
 * per-company isolation: two URLs can alias one daemon) compare it with their configuration.
 */
const DAEMON_ID = /^openrig-[0-9a-f-]{36}$/;
export function getDaemonId(
  home = process.env["OPENRIG_HOME"] || process.env["RIGGED_HOME"] || path.join(os.homedir(), ".openrig"),
  opts: { platform?: NodeJS.Platform; fsyncDir?: (dir: string) => void } = {},
): string {
  const file = path.join(home, "daemon-id");
  const read = () => {
    const id = fs.readFileSync(file, "utf8").trim();
    // never silently re-minted: a changed identity would detach this daemon from its company
    if (!DAEMON_ID.test(id)) throw new Error(`${file} is corrupt (${JSON.stringify(id.slice(0, 40))}); restore it or remove it deliberately`);
    return id;
  };
  // Reported only once COMMITTED: `<file>.committed` exists after the name was made durable. Any
  // caller completes a pending commit; a failed barrier leaves the marker absent, so the next call
  // retries it. The identity itself is never removed or replaced once linked.
  const committed = `${file}.committed`;
  if (fs.existsSync(committed)) return read();
  fs.mkdirSync(home, { recursive: true });
  if (!fs.existsSync(file)) {
    // written + fsynced to a temp file, then hard-linked into place (exclusive: racing starts agree)
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    const fd = fs.openSync(tmp, "wx");
    try {
      fs.writeSync(fd, `openrig-${randomUUID()}`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.linkSync(tmp, file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  const id = read();
  const fsyncDir =
    opts.fsyncDir ??
    ((dir: string) => {
      const dfd = fs.openSync(dir, "r");
      try {
        fs.fsyncSync(dfd);
      } finally {
        fs.closeSync(dfd);
      }
    });
  try {
    fsyncDir(home);
  } catch (err) {
    // Windows cannot fsync a directory (the file itself is durable there); everywhere else a failed
    // directory fsync means the name may not survive a crash: not committed, not reported
    if ((opts.platform ?? process.platform) !== "win32") throw err;
  }
  // the marker only records that the barrier passed (lost in a crash = the barrier simply reruns)
  try {
    fs.writeFileSync(committed, id, { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  return id;
}

// GET /api/info — daemon-info surface for tactical CLI awareness paths
// (OPR.0.3.2.22 Bug 3 first consumer: CLI default-cwd extension for
// path-form `rig up <install-internal-spec>` without --cwd).
//
// installRoot is the daemon's on-disk install root (the parent of the
// daemon's package directory). The CLI uses it to detect when a spec
// path lives inside the OpenRig install — the case that hits
// getOpenRigInstallCwdError at preflight without a --cwd override.
export function infoRoutes(): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    return c.json({
      installRoot: getOpenRigInstallRoot(),
      daemonId: getDaemonId(),
    });
  });

  return app;
}
