// test/smoke-classify.mts — no-quota smoke for the M3.1 failure taxonomy.
//   devbox run node test/smoke-classify.mts
// Drives the PURE classifier with synthetic errors/results — one fixture per
// OpClass plus the discriminator edges and the unknown fail-safe. The real
// provider error strings are unknown until the first live failure; these fixtures
// encode the PROVISIONAL patterns, to be tightened against a captured excerpt.

import { classify } from "../listener/classify.mts";

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
