// test/smoke-classify.mts — no-quota smoke for the M3.1 failure taxonomy.
//   devbox run node test/smoke-classify.mts
// Drives the PURE classifier with synthetic errors/results — one fixture per
// OpClass plus the discriminator edges and the unknown fail-safe. The real
// provider error strings are unknown until the first live failure; these fixtures
// encode the PROVISIONAL patterns, to be tightened against a captured excerpt.

import { classify } from "#listener/classify.mts";

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : `\n    ${detail}`}`);
};

// ── auth (403) → abort + halt (P1) ──
{
  const e = classify({ error: new Error("Request failed: 403 Forbidden — invalid API key") });
  ok("auth: 403 → class auth / P1", e.class === "auth" && e.severity === "P1", JSON.stringify(e));
  const o = classify({ error: new Error("OAuth authentication failed") });
  ok("auth: oauth wording → auth", o.class === "auth");
}

// ── quota with an absolute reset time → pause + auto-resume (P2) ──
{
  const e = classify({ error: new Error("Usage limit reached. Your limit resets at 2026-07-19T21:00:00Z") });
  ok("quota+ISO: class quota / P2", e.class === "quota" && e.severity === "P2", JSON.stringify(e));
  ok("quota+ISO: resetAt parsed", e.resetAt === Date.parse("2026-07-19T21:00:00Z"), String(e.resetAt));
}

// ── discriminator: retry-after ⇒ 429 transient, NOT quota ──
{
  const e = classify({ error: new Error("429 Too Many Requests — retry-after: 30") });
  ok("429+retry-after: class transient / P3", e.class === "transient" && e.severity === "P3", JSON.stringify(e));
  ok("429+retry-after: retryAfterMs=30000", e.retryAfterMs === 30_000, String(e.retryAfterMs));
  ok("429+retry-after: no resetAt (not quota)", e.resetAt === undefined);
}

// ── quota keyword, NO timestamp → pause, needs a human /resume-at ──
{
  const e = classify({ error: new Error("You have exceeded your usage limit for this period.") });
  ok("quota no-ts: class quota / P2", e.class === "quota" && e.severity === "P2", JSON.stringify(e));
  ok("quota no-ts: resetAt absent → human", e.resetAt === undefined);
}

// ── transient: bare network error, no retry-after ──
{
  const e = classify({ error: new Error("fetch failed: ECONNRESET") });
  ok("transient: ECONNRESET → transient / P3", e.class === "transient" && e.severity === "P3", JSON.stringify(e));
  const g = classify({ error: new Error("upstream 503 Service Unavailable") });
  ok("transient: 5xx → transient", g.class === "transient");
}

// ── run-level: a StructuredOutputError shape (agent ran, bad output) ──
{
  const soe = Object.assign(new Error("no <sunday-result> tag found"), {
    name: "StructuredOutputError",
    rawMatched: undefined,
    commits: [{ sha: "abc" }],
    branch: "feat/9",
  });
  const e = classify({ error: soe });
  ok("run-failed: StructuredOutputError → run-failed / P3", e.class === "run-failed" && e.severity === "P3", JSON.stringify(e));
}

// ── run-level from a non-throwing result: error subtype + dirty worktree ──
{
  const e = classify({ result: { stdout: '{"type":"result","subtype":"error_max_turns"}' } });
  ok("run-failed: error_max_turns subtype", e.class === "run-failed" && e.summary.includes("error_max_turns"), JSON.stringify(e));
  const d = classify({ result: { preservedWorktreePath: "/tmp/wt", stdout: "" } });
  ok("run-failed: preserved worktree → run-failed", d.class === "run-failed");
}

// ── setup: sandbox couldn't be created → halt with an actionable class ──
// (Real excerpt captured 2026-07-24, finance#55 — previously the unknown halt.)
{
  const e = classify({
    error: new Error(
      "Provider 'docker' create failed: Image 'finance-sandbox:latest' not found locally. Build it first with 'sandcastle docker build-image'.",
    ),
  });
  ok("setup: missing image → setup / P1 (halt)", e.class === "setup" && e.severity === "P1", JSON.stringify(e));
  const d = classify({
    error: new Error(
      "Provider 'docker' create failed: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
    ),
  });
  ok("setup: daemon down → setup (not auth/transient)", d.class === "setup", JSON.stringify(d));
}

// ── GitHub's API failing under a `gh` call → transient (retry), NOT the halt ──
// (Real excerpt captured 2026-07-24, finance#57/#58 — previously the unknown halt.
// Note there is no status code anywhere in this text, which is why it fell through.)
{
  const e = classify({
    error: new Error(
      "gh pr create failed: GraphQL: Something went wrong while executing your query on " +
        "2026-07-24T19:22:36Z. Please include `0852:3A3CD5:70DD66:753396:6A63BB7B` when reporting this issue.",
    ),
  });
  ok("github-5xx: GraphQL wrapper → transient / P3", e.class === "transient" && e.severity === "P3", JSON.stringify(e));
  // The excerpt carries an ISO timestamp; an unanchored reset parse read it as a
  // quota reset and paused the pipeline until a time that had already passed.
  ok("github-5xx: incidental ISO timestamp is NOT a quota reset", e.resetAt === undefined, String(e.resetAt));
  const g = classify({ error: new Error("gh api failed: HTTP 502: Bad Gateway") });
  ok("github-5xx: bad gateway → transient", g.class === "transient", JSON.stringify(g));
}

// ── the classifier must read the command's STDERR, never our argv ──
// helper.mts:cmdError keeps agent-authored `--title`/`--body` text out of the thrown
// message. PR 61's real body says "credential-free sandbox"; with the argv in the
// message that alone would have classified a failed create as a P1 auth halt.
{
  const leaked = classify({
    error: new Error(
      'Command failed: gh pr create --title "Shell 1" --body "this credential-free sandbox has no docker"',
    ),
  });
  ok("argv-leak: argv text WOULD misclassify as auth (why cmdError trims it)", leaked.class === "auth", JSON.stringify(leaked));
  const trimmed = classify({
    error: new Error("gh pr create failed: GraphQL: Something went wrong while executing your query"),
  });
  ok("argv-leak: stderr-only message → transient, not auth", trimmed.class === "transient", JSON.stringify(trimmed));
}

// ── parent-worktree contention → transient (wait it out), NOT the fail-safe halt ──
// (Real excerpt captured 2026-07-25, finance PR#61 — a hand checkout of feat/55 that
// moved away 44s later. Previously fell through to `unknown`.)
{
  const e = classify({
    error: new Error(
      "Branch 'feat/55' is already checked out in worktree at '/Users/x/sunday/repos/finance'. " +
        "Sandcastle's branch and merge-to-head strategies run the agent in a git worktree under " +
        ".sandcastle/worktrees/, and git refuses to check out the same branch in two worktrees at once.",
    ),
  });
  ok("worktree: contention → transient / P3", e.class === "transient" && e.severity === "P3", JSON.stringify(e));
  ok("worktree: backs off in minutes, not seconds", e.retryAfterMs === 300_000, String(e.retryAfterMs));
  const d = classify({ error: new Error("error: cannot delete branch 'feat/55' used by worktree at '/x/repos/finance'") });
  ok("worktree: delete-blocked wording → transient", d.class === "transient", JSON.stringify(d));
}

// ── PR base deleted mid-run → transient (re-derive + retry), NOT the fail-safe halt ──
// (Real excerpt captured 2026-07-25, finance#57 — feat/55 merged via PR #61 and was
// deleted 25s after the run's `fetch -p`, so only `gh pr create` saw it gone. Halted
// the whole pipeline on `unknown`; the next run's `fetch -p` + base-gone guard fixes
// it unaided, so it must retry.)
{
  const e = classify({
    error: new Error(
      "gh pr create failed: pull request create failed: GraphQL: Head sha can't be blank, " +
        "Base sha can't be blank, No commits between feat/55 and feat/57, Base ref must be a branch " +
        "(createPullRequest)",
    ),
  });
  ok("base-gone: deleted PR base → transient / P3", e.class === "transient" && e.severity === "P3", JSON.stringify(e));
  ok("base-gone: summary names the vanished base", e.summary.includes("'feat/55'"), e.summary);
  ok("base-gone: keeps the raw GraphQL excerpt", e.excerpt.includes("Base ref must be a branch"));
  // Must not be read as a quota/auth stop — those halt or pause instead of retrying.
  ok("base-gone: not quota (no reset invented)", e.resetAt === undefined, String(e.resetAt));
  // The "Base ref must be a branch" clause alone (no no-commits noise) still classifies.
  const bare = classify({ error: new Error("gh pr create failed: GraphQL: Base ref must be a branch (createPullRequest)") });
  ok("base-gone: bare base-ref clause → transient", bare.class === "transient", JSON.stringify(bare));
}

// ── fail-safe: an unrecognized failure → halt, and captures the excerpt ──
{
  const e = classify({ error: new Error("something entirely unexpected happened") });
  ok("unknown: unrecognized → unknown / P1 (halt)", e.class === "unknown" && e.severity === "P1", JSON.stringify(e));
  ok("unknown: captures the raw excerpt", e.excerpt.includes("something entirely unexpected"));
  const n = classify({});
  ok("unknown: empty input → unknown", n.class === "unknown");
}

// ── excerpt is tail-bounded (keeps the informative end of a huge error) ──
{
  const huge = "x".repeat(5000) + " RESET-MARKER-AT-END";
  const e = classify({ error: new Error(huge) });
  ok("excerpt: bounded + keeps the tail", e.excerpt.length <= 2001 && e.excerpt.includes("RESET-MARKER-AT-END"), String(e.excerpt.length));
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
