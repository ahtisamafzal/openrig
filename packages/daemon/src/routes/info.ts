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
export function getDaemonId(home = process.env["OPENRIG_HOME"] || process.env["RIGGED_HOME"] || path.join(os.homedir(), ".openrig")): string {
  const file = path.join(home, "daemon-id");
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    fs.mkdirSync(home, { recursive: true });
    try {
      fs.writeFileSync(file, `openrig-${randomUUID()}`, { flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    return fs.readFileSync(file, "utf8").trim();
  }
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
