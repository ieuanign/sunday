// listener/classify.mts — M3.1 failure taxonomy (pure).
//
// Classify a FAILED sandbox run into an operational class off the RunResult SHAPE
// and the thrown error — never exit codes. The act layer (M3.2, in the listener)
// then responds *oppositely* per class: quota → pause + resume, auth → abort +
// halt, transient → bounded backoff, run-failed → the existing agent-failed path,
// unknown → notify + halt.
//
// The string patterns for quota/auth/transient are PROVISIONAL — the real Claude
// CLI / provider error text isn't known until the first live quota hit / 403 /
// refusal. That's the whole point of the `unknown` fail-safe: an unrecognized
// outcome is captured (raw excerpt) in events.jsonl and halts, so the first real
// occurrence is observed and these parsers tightened then (the M3 verify gate).
//
// Pure + fixture-driven (like decideBase / issueAction) so a no-quota smoke drives
// every branch. The types live here (the producer); notify.mts (M3.3) imports them.

/** quota: usage/5-hr limit → pause (resetAt present → auto-resume; absent → human).
 *  auth: 403 / bad credential → abort in-flight + halt, a human re-auths.
 *  transient: 429 / network / 5xx → bounded backoff, then agent-failed.
 *  run-failed: the agent ran but produced a bad/failed outcome → agent-failed path.
 *  summarize-failed: a ≥threshold session's handoff turn produced no usable note
 *    (M5.2) → the issue fails as agent-failed; the bloated session is NOT reused.
 *  setup: the sandbox couldn't be CREATED (missing image, docker down) → halt;
 *    deterministic environment breakage a retry can't fix — a human repairs
 *    (or the boot preflight rebuilds), then /resume.
 *  unknown: unrecognized → fail-safe halt + capture (never silently dropped). */
export type OpClass = "quota" | "auth" | "transient" | "run-failed" | "summarize-failed" | "setup" | "unknown";

/** P1 halts the pipeline (auth/setup/unknown); P2 pauses recoverably (quota); P3
 *  is a single-run or auto-recovering issue (transient/run-failed). */
export type Severity = "P1" | "P2" | "P3";

export interface OpEvent {
  class: OpClass;
  severity: Severity;
  /** One-line headline for the notifier. */
  summary: string;
  /** Raw error message / stdout tail — the capture that tightens these parsers. */
  excerpt: string;
  /** Parsed absolute reset time (epoch ms) for a quota with a timestamp. The act
   *  layer adds the +5min grace before resuming; absent → needs a human /resume-at. */
  resetAt?: number;
  /** Backoff hint (ms) parsed from a transient error's retry-after. */
  retryAfterMs?: number;
}

/** The subset of a RunResult the taxonomy reads (kept structural so a smoke needn't
 *  build a real RunResult). */
export interface RunLike {
  stdout?: string;
  preservedWorktreePath?: string;
}

/** The setup halt's one-line summary — exported so listen.mts can recognize a
 *  re-armed setup halt on boot and start its recovery watcher. Actionable on
 *  purpose: it is what the issue comment, Telegram notice, and pause reason show. */
export const SETUP_SUMMARY =
  "sandbox setup failure — could not create the sandbox. Check the child's .sandcastle/Dockerfile " +
  "and that docker is running; the pipeline rechecks every 5 min and auto-resumes (and retries this issue) once the environment builds";

const EXCERPT_MAX = 2000;
/** Keep the TAIL — provider errors and the final stream-json result land at the end. */
function excerpt(s: string): string {
  return s.length > EXCERPT_MAX ? `…${s.slice(-EXCERPT_MAX)}` : s;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** A Sandcastle structured-output failure: the agent RAN (has commits/branch) but
 *  never emitted a valid `<sunday-result>` even after its one retry. Detected
 *  structurally (name or `rawMatched`), not via instanceof, so a fixture works. */
function isStructuredOutputError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    ((error as { name?: unknown }).name === "StructuredOutputError" || "rawMatched" in error)
  );
}

/** Absolute reset time → epoch ms, or undefined. ISO-8601 or a 10-digit unix
 *  epoch near a "reset" mention. PROVISIONAL — relative durations ("resets in 2h")
 *  are deliberately NOT parsed (they'd need wall-clock, defeating a pure test);
 *  those fall to the no-timestamp quota path (human /resume-at) until the real
 *  format is captured. */
function parseResetTime(msg: string): number | undefined {
  const iso = msg.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/);
  if (iso) {
    const t = Date.parse(iso[1]);
    if (!Number.isNaN(t)) return t;
  }
  const epoch = msg.match(/reset[^0-9]{0,24}(\d{10})\b/i);
  if (epoch) return Number(epoch[1]) * 1000;
  return undefined;
}

/** Relative retry-after → ms, or undefined. `retry-after: N`, `retry after N
 *  seconds`, or a bare `N seconds`. PROVISIONAL. */
function parseRetryAfterMs(msg: string): number | undefined {
  const explicit = msg.match(/retry[\s-]?after[^0-9]{0,10}(\d+)/i);
  if (explicit) return Number(explicit[1]) * 1000;
  const secs = msg.match(/\b(\d+)\s*seconds?\b/i);
  if (secs) return Number(secs[1]) * 1000;
  return undefined;
}

/** Last stream-json `result` subtype in the agent's stdout (json output-format),
 *  or undefined. An `error_*` subtype (e.g. `error_max_turns`) is a run-level
 *  failure the provider surfaced without throwing. */
function parseResultSubtype(stdout: string): string | undefined {
  const all = [...stdout.matchAll(/"subtype"\s*:\s*"([^"]+)"/g)];
  return all.length ? all[all.length - 1][1] : undefined;
}

/** Classify the thrown error from a `run()` call. Order enforces the spec's
 *  discriminator: an absolute RESET time ⇒ quota (pause until reset); a relative
 *  RETRY-AFTER ⇒ 429 transient (backoff) — never conflated. */
function classifyError(error: unknown): OpEvent {
  const msg = messageOf(error);
  const raw = excerpt(msg);
  const lower = msg.toLowerCase();

  // M5.2: a handoff turn that produced no usable note. run-issue throws this with a
  // clear, issue-specific message; act oppositely to a normal run failure only in
  // wording — it still routes to the issue-level agent-failed path (D4b).
  if (/^SUMMARIZE_FAILED:/.test(msg)) {
    return {
      class: "summarize-failed",
      severity: "P2",
      summary: msg.replace(/^SUMMARIZE_FAILED:\s*/, ""),
      excerpt: raw,
    };
  }

  if (isStructuredOutputError(error)) {
    return {
      class: "run-failed",
      severity: "P3",
      summary: "agent emitted no valid result tag (after retry)",
      excerpt: raw,
    };
  }

  // Sandcastle couldn't CREATE the sandbox (image missing, daemon down, …) —
  // captured 2026-07-24 (finance#55, then class `unknown`). Deterministic
  // environment breakage: halt actionably, never retry. Checked BEFORE auth — a
  // create-failed message can mention registry credentials without being a
  // provider-API auth failure.
  if (/provider '[^']+' create failed|image '[^']+' not found locally/.test(lower)) {
    return { class: "setup", severity: "P1", summary: SETUP_SUMMARY, excerpt: raw };
  }

  if (/\b403\b|forbidden|unauthorized|invalid api key|invalid.{0,12}token|authentication|credential|oauth/.test(lower)) {
    return { class: "auth", severity: "P1", summary: "auth failure (403 / invalid credential)", excerpt: raw };
  }

  // reset time present ⇒ quota (auto-resume at reset+grace)
  const resetAt = parseResetTime(msg);
  if (resetAt !== undefined) {
    return {
      class: "quota",
      severity: "P2",
      summary: `quota exhausted — reset ${new Date(resetAt).toISOString()}`,
      excerpt: raw,
      resetAt,
    };
  }

  // retry-after present ⇒ 429 transient (backoff)
  const retryAfterMs = parseRetryAfterMs(msg);
  if (retryAfterMs !== undefined && /\b429\b|too many requests|rate.?limit|retry/.test(lower)) {
    return { class: "transient", severity: "P3", summary: "rate-limited (429)", excerpt: raw, retryAfterMs };
  }

  // keyword fallbacks (no parseable time)
  if (/quota|usage limit|limit reached|rate.?limit/.test(lower)) {
    return { class: "quota", severity: "P2", summary: "quota exhausted — no reset timestamp (needs /resume-at)", excerpt: raw };
  }
  if (/\b429\b|too many requests|\b5\d\d\b|timeout|timed out|econnrefused|econnreset|etimedout|socket hang ?up|network|fetch failed|enotfound|eai_again/.test(lower)) {
    return { class: "transient", severity: "P3", summary: "transient error (network / 5xx)", excerpt: raw };
  }

  return { class: "unknown", severity: "P1", summary: "unrecognized failure — halting (fail-safe)", excerpt: raw };
}

/** Classify a non-throwing RunResult the caller deemed a failure (e.g. no commits,
 *  or a `fail` signal): an `error_*` stream subtype or a preserved (dirty) worktree
 *  → run-level; otherwise a generic run failure. */
function classifyResult(result: RunLike): OpEvent {
  const tail = excerpt(result.stdout ?? "");
  const subtype = parseResultSubtype(result.stdout ?? "");
  if (subtype && subtype.startsWith("error")) {
    return { class: "run-failed", severity: "P3", summary: `agent run error (${subtype})`, excerpt: tail };
  }
  if (result.preservedWorktreePath) {
    return { class: "run-failed", severity: "P3", summary: "agent left a dirty worktree", excerpt: tail };
  }
  return { class: "run-failed", severity: "P3", summary: "run failed (see log)", excerpt: tail };
}

/** Classify a failed run. Pass the thrown `error` (the common path — `run()` threw)
 *  or a non-throwing `result` the caller treats as a failure. Never throws. */
export function classify(input: { error?: unknown; result?: RunLike }): OpEvent {
  if (input.error !== undefined && input.error !== null) return classifyError(input.error);
  if (input.result) return classifyResult(input.result);
  return { class: "unknown", severity: "P1", summary: "unclassifiable: no error or result", excerpt: "" };
}
