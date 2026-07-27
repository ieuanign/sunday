// assignor/failure.mts — the failure taxonomy: what a failure IS, and how far it reaches.
//
// Ported from v1's `listener/classify.mts`, which gave every unrecognised failure a
// fail-safe GLOBAL halt — the defect ADR-0002 removes. Here each class carries a SCOPE
// instead of a severity-that-means-halt, and only `pipeline` stops everything.
//
// Pure: a string in, a `Failure` out. No clock, no I/O, no logger — so every class is
// drivable from a fixture, and the act layer (which pauses, retries, quarantines) is a
// separate thing that can be reasoned about on its own.
//
// It classifies TEXT because text is all the parent ever has: the agent seam flattens
// every library error to a plain `Error` whose message is preserved precisely so this can
// read it (`services/agent/claude.mts`), the image sweep reports a failed build as a
// `reason` string, and a dead child is an exit code the parent turns into a line.
//
// The quota/auth/transient patterns are PROVISIONAL. The real provider's error text is not
// known until the first live quota hit or 403, which is why an unrecognised failure still
// carries its raw excerpt into the durable log — that capture is what tightens these.

/** quota: the subscription's window is spent — every run would hit the same wall.
 *  auth: the credential is process-wide, so every run fails identically and instantly.
 *  setup: the sandbox could not be built or created — one repo's environment, unless the
 *    container daemon itself is down.
 *  transient: a blip (429, 5xx, network, a branch briefly checked out elsewhere).
 *  run-failed: the agent RAN and reported the failure itself.
 *  unknown: matched nothing. Not a halt any more — one work item is stopped, retried once
 *    with its own error, and quarantined if it fails again. */
export type FailureClass = "quota" | "auth" | "setup" | "transient" | "run-failed" | "unknown";

/** How far a failure reaches (CONTEXT.md): `pipeline` — every run would fail the same way;
 *  `repo` — this child repo is broken; `item` — only this work item is stuck. */
export type FailureScope = "pipeline" | "repo" | "item";

export interface Failure {
  class: FailureClass;
  scope: FailureScope;
  /** One-line headline of WHAT happened — the pause reason, and the head of the act
   *  layer's line. What Sunday is DOING about it is the act layer's to say. */
  summary: string;
  /** The failure text, tail-bounded: the capture that tightens these patterns. */
  excerpt: string;
  /** Absolute reset time (epoch ms) for a quota that named one. Absent → the pause has
   *  nothing to lift itself on and waits for a human. */
  resetAt?: number;
}

/** Which class reaches how far (ADR-0002). `setup` is the one class whose scope is not
 *  fixed here — see `scopeOf`. */
const SCOPE: Record<FailureClass, FailureScope> = {
  quota: "pipeline",
  auth: "pipeline",
  setup: "repo",
  transient: "item",
  "run-failed": "item",
  unknown: "item",
};

/** The one setup failure that is NOT one repo's: no image anywhere can be built or run
 *  while the daemon is down, so this is the third thing allowed to stop the pipeline
 *  (constraint 4). */
const DAEMON_DOWN = /cannot connect to the docker daemon|is the docker daemon running|docker daemon is not running/;

/** The environment a run needs could not be produced: the image is missing or could not be
 *  created, or the daemon that would run it is not there. Deterministic breakage a retry
 *  cannot fix — a human (or the recheck rebuild) repairs it. A dead daemon is included
 *  rather than left to the caller's fallback, so it is recognised as setup wherever it
 *  surfaces; a build failure that says nothing recognisable is boot's `setup` fallback. */
const SETUP = new RegExp(`provider '[^']+' create failed|image '[^']+' not found locally|${DAEMON_DOWN.source}`);

/** A RELATIVE wait — `retry-after: N`, `retry after N seconds`, a bare `N seconds`. The
 *  discriminator against a quota's ABSOLUTE reset: conflating them either halts the
 *  pipeline on a 429 or retries one item into a wall the whole backlog then hits. */
const RETRY_AFTER = /retry[\s-]?after[^0-9]{0,10}\d+|\b\d+\s*seconds?\b/;

/** 5xx, network, and GitHub's own API failing under a `gh` call. The GraphQL 502 wrapper
 *  is named explicitly because it carries NO status code in its text (captured 2026-07-24,
 *  finance#57/#58, where it matched nothing and halted the pipeline). */
const TRANSIENT =
  /\b429\b|too many requests|rate.?limit|\b5\d\d\b|graphql: something went wrong|bad gateway|service unavailable|timeout|timed out|econnrefused|econnreset|etimedout|socket hang ?up|network|fetch failed|enotfound|eai_again/;

const EXCERPT_MAX = 2000;

/** Keep the TAIL — provider errors and a build's failing RUN line land at the end. */
function excerpt(text: string): string {
  return text.length > EXCERPT_MAX ? `…${text.slice(-EXCERPT_MAX)}` : text;
}

/** Absolute reset time → epoch ms, or undefined. ISO-8601 or a 10-digit unix epoch, BOTH
 *  anchored to a nearby reset/limit/quota mention. The anchor is not optional: unanchored,
 *  ANY timestamped error reads as a quota reset — a GitHub 502 whose text happens to carry
 *  `…on 2026-07-24T19:22:36Z` (captured 2026-07-24, finance#57/#58) then halts the pipeline
 *  until a reset that never existed. PROVISIONAL — relative durations ("resets in 2h") are
 *  deliberately NOT parsed (they would need a clock, and this is pure); they fall to the
 *  no-reset quota path, which waits for a human. */
function parseResetTime(text: string): number | undefined {
  const iso = text.match(
    /(?:reset|usage limit|quota)[^0-9]{0,40}(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/i,
  );
  if (iso) {
    const t = Date.parse(iso[1]);
    if (!Number.isNaN(t)) return t;
  }
  const epoch = text.match(/reset[^0-9]{0,24}(\d{10})\b/i);
  return epoch ? Number(epoch[1]) * 1000 : undefined;
}

/** How far a class reaches. Fixed per class except `setup`, which reads the text: one
 *  repo's image is that repo's problem, a dead daemon is everyone's. */
function scopeOf(cls: FailureClass, lower: string): FailureScope {
  return cls === "setup" && DAEMON_DOWN.test(lower) ? "pipeline" : SCOPE[cls];
}

export interface ClassifyOptions {
  /** The class for text that matches nothing. `unknown` (one item, retried once, then
   *  quarantined) unless the caller knows better: boot passes `setup`, because a failure
   *  that came out of an image build is that repo's environment whatever docker said. */
  fallback?: FailureClass;
  /** The agent RAN and reported the failure itself. A typed fact off the outcome, never a
   *  pattern: the text on that path is prose SUNDAY composed around the agent's own
   *  description, so matching it would both break the day that wording changes and let
   *  anything the agent happened to write stop the pipeline. */
  agentFailed?: boolean;
}

/** Classify a failure's text into a class and a scope. Never throws. */
export function classify(text: string, options: ClassifyOptions = {}): Failure {
  const raw = excerpt(text);
  const lower = text.toLowerCase();

  if (options.agentFailed) {
    return { class: "run-failed", scope: SCOPE["run-failed"], summary: "the agent ran and reported a failure", excerpt: raw };
  }

  // Before auth: a create or pull failure can name registry credentials without the
  // provider API's credential being the problem, and one repo's stop must not become a
  // pipeline halt.
  if (SETUP.test(lower)) {
    return {
      class: "setup",
      scope: scopeOf("setup", lower),
      summary: DAEMON_DOWN.test(lower)
        ? "the container daemon is not running — no sandbox can be created"
        : "the sandbox image could not be built or created",
      excerpt: raw,
    };
  }

  // The branch is checked out in the PARENT repo, so the run cannot put its worktree on it
  // (git refuses the same branch twice). Captured 2026-07-25 (finance PR#61): a human's
  // hand checkout that moved away 44s later — a contention to wait out, and never the
  // fail-safe halt v1 fell through to. Ahead of auth for the same reason setup is: the
  // path in the message can name anything.
  if (/already checked out in worktree|used by worktree at/.test(lower)) {
    return {
      class: "transient",
      scope: SCOPE.transient,
      summary: "the branch is checked out in the parent worktree",
      excerpt: raw,
    };
  }

  // `gh pr create` against a base that no longer exists: a stacked base whose blocker
  // merged — and GitHub deleted the branch — WHILE this run was in flight (captured
  // 2026-07-25, finance#57). Self-healing: the next run's own `fetch -p` prunes the
  // dangling ref and re-derives the base. GitHub reports it as a cluster of blank-sha
  // noise; the discriminating clause is "Base ref must be a branch".
  if (/base ref must be a branch|head sha can't be blank/.test(lower)) {
    const base = text.match(/no commits between (\S+) and \S+/i)?.[1];
    return {
      class: "transient",
      scope: SCOPE.transient,
      summary: `the PR base ${base ? `${base} ` : ""}no longer exists (a stacked blocker merged mid-run)`,
      excerpt: raw,
    };
  }

  if (/\b403\b|forbidden|unauthorized|invalid api key|invalid.{0,12}token|authentication|credential|oauth/.test(lower)) {
    return { class: "auth", scope: SCOPE.auth, summary: "auth failure (403 / invalid credential)", excerpt: raw };
  }

  // A reset time present ⇒ quota (the pause can lift itself at reset + grace).
  const resetAt = parseResetTime(text);
  if (resetAt !== undefined) {
    return {
      class: "quota",
      scope: SCOPE.quota,
      summary: `quota exhausted — reset ${new Date(resetAt).toISOString()}`,
      excerpt: raw,
      resetAt,
    };
  }

  // A relative wait on a rate-limited call ⇒ the blip, checked BEFORE the quota keywords
  // below: "rate limit" appears in both, and only the shape of the wait tells them apart.
  if (RETRY_AFTER.test(lower) && /\b429\b|too many requests|rate.?limit|retry/.test(lower)) {
    return { class: "transient", scope: SCOPE.transient, summary: "rate-limited (429)", excerpt: raw };
  }

  // Quota worded without a time. Includes "rate limit" deliberately: a quota wall reported
  // in those words must stop the pipeline, or the whole backlog feeds into it.
  if (/quota|usage limit|limit reached|rate.?limit/.test(lower)) {
    return { class: "quota", scope: SCOPE.quota, summary: "quota exhausted — no reset time in the error", excerpt: raw };
  }

  if (TRANSIENT.test(lower)) {
    return { class: "transient", scope: SCOPE.transient, summary: "transient error (network / 5xx)", excerpt: raw };
  }

  const fallback = options.fallback ?? "unknown";
  return { class: fallback, scope: scopeOf(fallback, lower), summary: "unrecognised failure", excerpt: raw };
}
