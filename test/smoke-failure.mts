// test/smoke-failure.mts — hermetic smoke for the failure taxonomy (assignor/failure.mts):
// what a failure IS (its class) and how far it reaches (its scope).
//   node test/smoke-failure.mts
// Drives the PURE classifier with the failure text each path actually produces — the agent
// seam's flattened message, a build sweep's reason, the parent's own dead-child line. $0,
// no network, no docker.
//
// The quota/auth/transient patterns are PROVISIONAL: the real provider's text is not known
// until the first live quota hit or 403, so these fixtures encode the patterns rather than
// prove them. What they DO prove is the shape — that every class lands on a scope, and that
// the two discriminators captured in production still hold.

import { classify } from "../assignor/failure.mts";

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : `\n    ${detail}`}`);
};

// ── quota: the whole subscription is spent, so every run would hit the same wall ──
{
  const e = classify("Usage limit reached. Your limit resets at 2026-07-19T21:00:00Z");
  ok("quota: an exhausted quota stops the pipeline, not one item", e.class === "quota" && e.scope === "pipeline", JSON.stringify(e));
  ok("quota: an anchored reset time is read, so the pause can lift itself", e.resetAt === Date.parse("2026-07-19T21:00:00Z"), String(e.resetAt));

  const n = classify("You have exceeded your usage limit for this period.");
  ok("quota: no reset time is still a pipeline stop", n.class === "quota" && n.scope === "pipeline", JSON.stringify(n));
  ok("quota: with no reset time there is nothing to auto-resume on", n.resetAt === undefined, String(n.resetAt));
}

// ── auth: the credential is process-wide, so nothing can run until a human re-auths ──
{
  const e = classify("Request failed: 403 Forbidden — invalid API key");
  ok("auth: a 403 stops the pipeline", e.class === "auth" && e.scope === "pipeline", JSON.stringify(e));
  ok("auth: no reset time — a credential does not fix itself on a clock", e.resetAt === undefined, String(e.resetAt));

  const o = classify("OAuth authentication failed");
  ok("auth: a credential failure in other words is still auth", o.class === "auth" && o.scope === "pipeline", JSON.stringify(o));
}

// ── setup: the sandbox image is per-repo, so a broken one stops that repo and nothing
//    else — unless the container daemon itself is down, which breaks every repo at once.
//    (The create-failed excerpt is real, captured 2026-07-24 finance#55, where v1 read it
//    as `unknown` and halted the whole pipeline on it.) ──
{
  const e = classify(
    "Provider 'docker' create failed: Image 'finance-sandbox:latest' not found locally. " +
      "Build it first with 'sandcastle docker build-image'.",
  );
  ok("setup: a missing image stops one repo", e.class === "setup" && e.scope === "repo", JSON.stringify(e));

  const d = classify(
    "Provider 'docker' create failed: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. " +
      "Is the docker daemon running?",
  );
  ok("setup: a dead container daemon stops the pipeline", d.class === "setup" && d.scope === "pipeline", JSON.stringify(d));

  // What the image sweep hands over is the build's own output tail, which never mentions
  // the provider — a daemon that died between builds still has to escalate.
  const b = classify(
    "sandcastle docker build-image (finance-sandbox:latest) exited 1 — ERROR: Cannot connect to the Docker daemon",
  );
  ok("setup: a build that died on the daemon stops the pipeline too", b.class === "setup" && b.scope === "pipeline", JSON.stringify(b));

  // Checked before auth: a create failure can mention registry credentials without the
  // provider API's credential being the problem, and a repo stop must not become a halt.
  const r = classify("Provider 'docker' create failed: pull access denied, no credential found for registry");
  ok("setup: a create failure naming credentials is still that repo's setup", r.class === "setup" && r.scope === "repo", JSON.stringify(r));
}

// ── transient: a blip. One item is stuck; everything else keeps running ──
{
  const e = classify("429 Too Many Requests — retry-after: 30");
  ok("transient: a rate-limited call stops one item", e.class === "transient" && e.scope === "item", JSON.stringify(e));

  // Captured 2026-07-24 (finance#57/#58): GitHub's GraphQL 502 wrapper carries no status
  // code anywhere in its text, so it matched nothing in v1 and halted the whole pipeline.
  const g = classify(
    "gh pr create failed: GraphQL: Something went wrong while executing your query on " +
      "2026-07-24T19:22:36Z. Please include `0852:3A3CD5:70DD66:753396:6A63BB7B` when reporting this issue.",
  );
  ok("transient: GitHub failing under a gh call stops one item", g.class === "transient" && g.scope === "item", JSON.stringify(g));

  // Captured 2026-07-25 (finance PR#61): a human's hand checkout of the same branch, which
  // moved away 44s later. A contention to wait out, never a run failure.
  const w = classify(
    "Branch 'feat/55' is already checked out in worktree at '/Users/x/sunday/repos/finance'. " +
      "git refuses to check out the same branch in two worktrees at once.",
  );
  ok("transient: a branch checked out elsewhere is waited out", w.class === "transient" && w.scope === "item", JSON.stringify(w));

  // Captured 2026-07-25 (finance#57): feat/55 merged and was deleted 25s after the run's
  // `fetch -p`, so only `gh pr create` saw it gone. The next run's own fetch fixes it.
  const b = classify(
    "gh pr create failed: pull request create failed: GraphQL: Head sha can't be blank, " +
      "Base sha can't be blank, No commits between feat/55 and feat/57, Base ref must be a branch (createPullRequest)",
  );
  ok("transient: a PR base deleted mid-run stops one item", b.class === "transient" && b.scope === "item", JSON.stringify(b));
  ok("transient: the vanished base is named for the human reading it", b.summary.includes("feat/55"), b.summary);
}

// ── the two discriminators production taught v1. Both decide between stopping the
//    pipeline and stopping one item, which is the whole of ADR-0002 ──
{
  // An ABSOLUTE reset means the wall is real and timed; a RELATIVE retry-after is a blip
  // measured in seconds. Conflating them either halts on a 429 or retries into a wall.
  const q = classify("Claude usage limit reached — resets at 2026-07-19T21:00:00Z");
  const t = classify("Rate limit exceeded. Please retry after 30 seconds.");
  ok("discriminator: an absolute reset is a quota wall", q.class === "quota" && q.scope === "pipeline", JSON.stringify(q));
  ok("discriminator: a relative retry-after is a blip, not a wall", t.class === "transient" && t.scope === "item", JSON.stringify(t));

  // An unanchored timestamp is NOT a reset: reading the 502's incidental one as a quota
  // reset paused the pipeline until a time that had already passed.
  const g = classify("GraphQL: Something went wrong while executing your query on 2026-07-24T19:22:36Z.");
  ok("discriminator: an incidental timestamp is not a quota reset", g.resetAt === undefined && g.class === "transient", JSON.stringify(g));
}

// ── run-failed: the agent RAN and reported the failure itself. It arrives as a flag off
//    the outcome, never as a pattern — the text on that path is prose Sunday composed, and
//    a regex against our own wording silently reclassifies the day the wording changes ──
{
  const e = classify("signal fail, but no commits — nothing to ship.", { agentFailed: true });
  ok("run-failed: an agent-reported failure stops one item", e.class === "run-failed" && e.scope === "item", JSON.stringify(e));

  // The teeth of it: the agent's own description is arbitrary text that can say anything,
  // and no phrase inside it may reach out and stop the pipeline.
  const q = classify("I gave up: the usage limit reached in the task I was told to test.", { agentFailed: true });
  ok("run-failed: nothing the agent wrote can halt the pipeline", q.class === "run-failed" && q.scope === "item", JSON.stringify(q));
}

// ── unknown: matched nothing. Under ADR-0002 that stops ONE item — the fail-safe global
//    halt is the defect being removed — and keeps the raw text that tightens these
//    patterns once a real failure is captured ──
{
  const e = classify("something entirely unexpected happened");
  ok("unknown: an unrecognised failure stops one item, not the pipeline", e.class === "unknown" && e.scope === "item", JSON.stringify(e));
  ok("unknown: the raw text is kept, because it is what tightens the patterns", e.excerpt.includes("something entirely unexpected"), e.excerpt);

  // What the parent writes when a child dies leaving nothing behind: no provider text at
  // all to match on, and in v1 it halted everything.
  const c = classify("child exited with code 1 leaving no outcome");
  ok("unknown: a dead child stops its own item only", c.class === "unknown" && c.scope === "item", JSON.stringify(c));
}

// ── the caller's fallback: boot classifies a failed IMAGE BUILD, so text that matched
//    nothing there is that repo's environment rather than one item's mystery ──
{
  const b = classify("sandcastle exited 1 — ERROR [4/9] RUN apt-get install: exit code 100", { fallback: "setup" });
  ok("fallback: an unreadable build failure stops that repo", b.class === "setup" && b.scope === "repo", JSON.stringify(b));

  // The fallback only fills a gap — text that classifies itself still wins, so a daemon
  // that died during a build still escalates past the repo.
  const d = classify("Cannot connect to the Docker daemon at unix:///var/run/docker.sock", { fallback: "setup" });
  ok("fallback: recognised text still outranks the caller's guess", d.class === "setup" && d.scope === "pipeline", JSON.stringify(d));

  const u = classify("something entirely unexpected happened", { fallback: "setup" });
  ok("fallback: the default stays `unknown` for callers that pass none", classify("something entirely unexpected happened").class === "unknown" && u.class === "setup", JSON.stringify(u));
}

// ── the capture is bounded, and keeps the END: a build's failing RUN line and a provider's
//    error both land at the tail, while the whole of a runaway build's output as one log
//    line is what a bound is for ──
{
  const e = classify(`${"x".repeat(5000)} Cannot connect to the Docker daemon`);
  ok("excerpt: a huge failure is bounded", e.excerpt.length <= 2001, String(e.excerpt.length));
  ok("excerpt: the informative tail survives the bound", e.excerpt.includes("Cannot connect to the Docker daemon"), e.excerpt.slice(-60));
  ok("excerpt: bounding the capture does not change the class", e.class === "setup" && e.scope === "pipeline", JSON.stringify({ class: e.class, scope: e.scope }));
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
