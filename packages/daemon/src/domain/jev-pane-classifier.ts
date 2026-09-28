// TypeSafe Jev (https://docs.typesafe.ai) as the last activity rung: when the pane
// heuristics find no signal (herdr reports Claude/Codex seats as "unknown" on
// Windows), ask Jev what the agent on screen is doing.
//
// Jev is most accurate with one plain question each, so it answers two yes/no
// questions in one call and the state is combined here.
//
// DATA BOUNDARY: the bottom 8 lines of a seat's terminal go to api.typesafe.ai.
// Needs BOTH TYPESAFE_API_KEY and OPENRIG_JEV_PANE_CLASSIFICATION=1; common
// secret shapes are masked first (redactSecrets).
//
// Contract: never throws; null when off, failing or unsure. Jev's "idle" is
// display-only: callers must not treat it as permission to send (see
// session-transport), and idle answers are never cached.

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const TIMEOUT_MS = 3_000;
const COOLDOWN_MS = 60_000;
const ASKS_YES = 0.6;
const BUSY_YES = 0.7;
const IDLE_MAX = 0.3; // idle only when BOTH answers are a confident "no"
const CACHE_MAX = 200;

export type JevPaneState = "idle" | "running" | "needs_input";
export interface JevPaneVerdict { state: JevPaneState; confidence: number }

let downUntil = 0;
// Screens repeat between polls; one answer per distinct screen text.
const cache = new Map<string, JevPaneVerdict | null>();

export function resetJevPaneClassifier(): void {
  downUntil = 0;
  cache.clear();
}

export function jevPaneEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const optIn = env.OPENRIG_JEV_PANE_CLASSIFICATION;
  return Boolean(env.TYPESAFE_API_KEY?.trim()) && (optIn === "1" || optIn === "true");
}

// BEST-EFFORT masking, not a DLP guarantee: known token shapes plus anything that
// looks like a credential assignment. Operators who cannot accept that boundary
// leave OPENRIG_JEV_PANE_CLASSIFICATION unset. Extend as new shapes show up.
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  // Key/cert body lines whose BEGIN marker scrolled off the capture: a whole line of base64.
  /^\s*[A-Za-z0-9+/]{40,}={0,2}\s*$/gm,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, // OpenAI / OpenRouter / Stripe-style keys
  /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{10,}/g,
  /\bnpm_[A-Za-z0-9]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bapikey_[A-Za-z0-9]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, // JWT
];
// Keep the label, mask the value.
const LABELLED_SECRETS: RegExp[] = [
  /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(?=@)/gi, // scheme://user:PASSWORD@host
  /(\bbearer\s+)\S+/gi,
  // NAME=value / name: value where the name mentions a credential word (API_KEY, DB_PASSWORD, …)
  /(\b[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?|auth)[A-Za-z0-9_.-]*["']?\s*[:=]\s*["']?)[^\s"']+/gi,
];

export function redactSecrets(text: string): string {
  const masked = SECRET_PATTERNS.reduce((t, re) => t.replace(re, "[redacted]"), text);
  return LABELLED_SECRETS.reduce((t, re) => t.replace(re, "$1[redacted]"), masked);
}

/** Combine the two P(yes) answers into a state, or null when Jev is unsure. */
export function paneVerdict(asks: number, busy: number): JevPaneVerdict | null {
  if (asks >= ASKS_YES) return { state: "needs_input", confidence: asks };
  if (busy >= BUSY_YES) return { state: "running", confidence: busy };
  if (asks <= IDLE_MAX && busy <= IDLE_MAX) return { state: "idle", confidence: 1 - Math.max(asks, busy) };
  return null;
}

export async function classifyPaneWithJev(
  screen: string,
  deps: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch; now?: () => number } = {},
): Promise<JevPaneVerdict | null> {
  const env = deps.env ?? process.env;
  const key = env.TYPESAFE_API_KEY?.trim();
  const now = (deps.now ?? Date.now)();
  const text = screen.trim();
  if (!key || !text || now < downUntil || !jevPaneEnabled(env)) return null;
  if (cache.has(text)) return cache.get(text)!;

  let verdict: JevPaneVerdict | null = null;
  try {
    const res = await (deps.fetch ?? fetch)(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: env.TYPESAFE_DEFAULT_MODEL?.trim() || "jev-latest",
        // The agent's current state lives at the bottom; older lines only add noise.
        // Mask the WHOLE capture first so a multi-line secret cut by the slice still matches.
        state: redactSecrets(text).split("\n").filter((l) => l.trim()).slice(-8).join("\n"),
        questions: {
          busy: {
            type: "noul",
            instructions: "Does the last lines of this AI coding agent's terminal show it busy right now?",
            criteria: {
              true: "A spinner, a 'Working (… esc to interrupt)' or 'Thinking' line, or a tool still running",
              false: "No such line: the agent has finished its turn",
            },
          },
          asks: {
            type: "noul",
            instructions: "Is an interactive prompt open in this terminal that blocks normal typing until the operator answers it?",
            criteria: {
              true: "A permission request, a numbered menu to pick from, a y/n confirmation, or 'Press enter to confirm'",
              false: "No interactive prompt; a question or suggestion written in the agent's reply text does not count, nor does an empty input line",
            },
          },
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`TypeSafe HTTP ${res.status}`);
    const answers = ((await res.json()) as { answers?: Record<string, { noul?: number }> }).answers;
    const asks = answers?.asks?.noul;
    const busy = answers?.busy?.noul;
    if (typeof asks === "number" && typeof busy === "number") verdict = paneVerdict(asks, busy);
  } catch {
    downUntil = now + COOLDOWN_MS; // outage/timeout: stop asking for a minute, heuristics stand
    return null;
  }
  // Idle is never cached: a stable prompt screen must get fresh evidence each time.
  if (verdict?.state !== "idle") {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
    cache.set(text, verdict);
  }
  return verdict;
}
