// PL-005 Phase B: shared notification adapter contract.
//
// Each adapter implements `send(payload)`. The dispatcher chooses the
// adapter at construction time based on the operator's notification
// mechanism config.

export interface NotificationPayload {
  /** Short human-readable title (e.g., "human-gate qitem arrived"). */
  title: string;
  /** Longer body. May contain qitem id, source rig, action verb. */
  body: string;
  /** Optional qitem reference (URL or id) for click-through. */
  qitemRef?: string;
  /** Operator-supplied tags for downstream routing (Slack channel, etc.). */
  tags?: string[];
}

export interface NotificationDeliveryResult {
  ok: boolean;
  /** When ok=true: provider-side ack (httpStatus, message-id). */
  ack?: string;
  /** When ok=false: human-readable error. */
  error?: string;
}

export interface NotificationAdapter {
  /** Adapter mechanism label for events / audit. */
  readonly mechanism: string;
  /** Target descriptor (ntfy topic URL or webhook endpoint URL). */
  readonly target: string;
  send(payload: NotificationPayload): Promise<NotificationDeliveryResult>;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Roadmap 5.3: the notification target must be an https URL (plain http only to a loopback host,
 *  e.g. a local ntfy) with no embedded credentials. Returns the problem, or null when valid. The
 *  message never echoes the target: webhook URLs routinely carry a secret in their path. */
export function notificationTargetProblem(target: string): string | null {
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return "OPENRIG_NOTIFICATIONS_TARGET is not a valid URL";
  }
  if (u.username || u.password) return "OPENRIG_NOTIFICATIONS_TARGET must not embed credentials (user:password@)";
  if (u.protocol === "https:") return null;
  if (u.protocol === "http:" && LOOPBACK.has(u.hostname)) return null;
  return `OPENRIG_NOTIFICATIONS_TARGET must use https (plain http only to localhost); got ${u.protocol}`;
}
