// test/smoke-failure.mts — hermetic smoke for the failure taxonomy (assignor/failure.mts):
// what a failure IS (its class), how far it reaches (its scope), and what Sunday DOES
// about it.
//   node test/smoke-failure.mts
// The first half drives the PURE classifier with the failure text each path actually
// produces — the agent seam's flattened message, a build sweep's reason, the parent's own
// dead-child line. The second half drives the real `FailurePolicy` over the real scheduler,
// pause store, state store and Assignor, with the two things that reach the world
// substituted (GitHub and the fork). $0, no network, no docker.
//
// The quota/auth/transient patterns are PROVISIONAL: the real provider's text is not known
// until the first live quota hit or 403, so these fixtures encode the patterns rather than
// prove them. What they DO prove is the shape — that every class lands on a scope, and that
// the two discriminators captured in production still hold.

import { rmSync } from "node:fs";
import { resolve } from "node:path";

import type { RepoConfig } from "#config/repos.mts";
import { classify, FailurePolicy } from "#assignor/failure.mts";
import { Assignor, type ChildExit, type Delivery, type ForkWorkItem, type Paths, type WorkItemRef } from "#assignor/index.mts";
import { PauseStore } from "#assignor/pause.mts";
import { createScheduler } from "#assignor/scheduler.mts";
import { StateStore } from "#assignor/state.mts";
import type { Job } from "#issue/run.mts";
import { acquireLock } from "#lib/lock.mts";
import { writeOutcome, type Outcome } from "#lib/outcome.mts";
import type { GitHub, GitHubLabels } from "#services/github/index.mts";
import { Logger, type Destinations, type LogLine } from "#services/logger.mts";

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : `\n    ${detail}`}`);
};
const tick = () => new Promise((r) => setTimeout(r, 0)); // flush the scheduler's microtasks

/** Wait for something a TIMER does, bounded so a regression is a failing assertion rather
 *  than a smoke that hangs the whole suite. */
async function until(cond: () => boolean, ms = 2_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 2));
  return cond();
}

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

  // #39: `credential` and `authentication` matched BARE, and auth is `pipeline` — so an item
  // failure whose text merely NAMED a credential file halted the whole backlog. Reachable
  // from any repo with such a path, which is most of them.
  const p = classify("Merge conflict in src/auth/credentials.ts");
  ok("auth: a credential in a file PATH is one item's problem, not a wall", p.class === "unknown" && p.scope === "item", JSON.stringify(p));

  const t = classify("npm test failed: test/authentication.test.ts — 2 assertions failed");
  ok("auth: a failing authentication test stops its own item", t.class === "unknown" && t.scope === "item", JSON.stringify(t));

  // The other direction, and the WORSE failure of the two: a real wall that stops halting
  // feeds the entire backlog into the same 403, one wasted run at a time. So a credential
  // word next to a word that says it was refused still halts, whichever way round it reads.
  const g = classify("gh: HTTP 401: Bad credentials (https://api.github.com/user)");
  ok("auth: a refused credential still stops the pipeline", g.class === "auth" && g.scope === "pipeline", JSON.stringify(g));

  const x = classify("The OAuth token has expired — run /login");
  ok("auth: an expired token still stops the pipeline", x.class === "auth" && x.scope === "pipeline", JSON.stringify(x));
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

// ─────────────────────────────────────────────────────────────────────────────────────
// The ACT layer. Only `pipeline` stops everything — that is the whole of ADR-0002, and
// the fixtures below drive it through the real pause store, the real scheduler and the
// real Assignor rather than asserting on a classification nobody acted on.
// ─────────────────────────────────────────────────────────────────────────────────────

/** Two routed repos, with one trigger label each: nothing here is about admission. The
 *  SECOND one is the whole of ADR-0002 — a scope is only a scope if the work in the other
 *  repo carries on, and with one repo in the table a halt and a repo stop look identical. */
const TABLE: Record<string, RepoConfig> = {
  "acme/finance": {
    path: "repos/finance",
    imageName: "sunday-finance",
    promptFile: "docs/prompt.md",
    triggerLabels: ["sunday"],
  },
  "acme/ops": {
    path: "repos/ops",
    imageName: "sunday-ops",
    promptFile: "docs/prompt.md",
    triggerLabels: ["sunday"],
  },
};

const dir = resolve(import.meta.dirname, "..", ".scratch", `smoke-failure-${process.pid}`);
let caseNo = 0;

/** `lib/paths.mts`'s own key-to-segment rule, so the harness names files the way the real
 *  layout would. */
const slug = (key: string) => key.replace(/[^A-Za-z0-9._-]/g, "-");

/** A real `FailurePolicy` over the real scheduler and the real pause store, plus the real
 *  Assignor that routes failures INTO it — the two things that reach the world (GitHub,
 *  the fork) substituted, and every path pointed into this case's own dir so the real
 *  `var/` is never touched. */
function harness(over: { pause?: PauseStore; resumeGraceMs?: number; labelFails?: boolean; imageBroken?: string } = {}) {
  const caseDir = resolve(dir, `case-${caseNo++}`);
  /** Every line, at any level — the run log is the one destination every level routes to. */
  const lines: LogLine[] = [];
  /** What would actually be posted on an issue. A pipeline-scope line must never get
   *  here: a halt has no business commenting on whichever item happened to hit it. */
  const comments: LogLine[] = [];
  const logger = new Logger({
    console: () => {},
    runLog: (line) => void lines.push(line),
    eventLog: () => {},
    github: (line) => void comments.push(line),
    phone: () => {},
  } satisfies Destinations);

  const scheduler = createScheduler(2, logger.child("scheduler"));
  const pause = over.pause ?? new PauseStore(resolve(caseDir, "pause.json"));
  const state = new StateStore(resolve(caseDir, "state.json"));

  const claimed: string[] = [];
  const released: string[] = [];
  const github: GitHub = {
    claim: (repo, issue) => void claimed.push(`${repo}#${issue}`),
    release: (repo, issue) => void released.push(`${repo}#${issue}`),
    // Nothing here is about dependencies: every issue is unblocked.
    blockedBy: async () => [],
    issueState: async () => "closed",
    readIssue: async () => ({ title: "", body: "" }),
    openPrForHead: async () => undefined,
    // #44's read, and nothing here drives the PR lane: a stub that ANSWERED would let a
    // case reach a decision this smoke never checked.
    readPr: async () => {
      throw new Error("readPr: no case in this smoke reads a pull request");
    },
  };

  /** The policy's own seam, narrower than the Assignor's: one label write, which is a
   *  real edit to a real repo. `labelFails` is the repo that was never seeded with the
   *  label — `gh` answers "not found", and durable state has to carry the quarantine
   *  anyway. */
  const labelled: string[] = [];
  const labels: GitHubLabels = {
    addLabels: async (repo, issue, names) => {
      if (over.labelFails) throw new Error(`gh: '${names.join(",")}' not found`);
      labelled.push(`${repo}#${issue} +${names.join(",")}`);
    },
    // The PR lane's write (#44), recorded as its own spelling: a comment run's failures
    // are driven where the lane is (`test/smoke-assignor.mts`), and marking one with
    // `gh issue edit` would label an unrelated issue that shares the number.
    labelPr: async (repo, pr, names) => void labelled.push(`${repo}#pr${pr} +${names.join(",")}`),
  };

  const paths: Paths = {
    resultPath: (key) => resolve(caseDir, "results", `${slug(key)}.json`),
    pidPath: (key) => resolve(caseDir, "running", `${slug(key)}.pid`),
    runLogPath: (fullName, flow) => resolve(caseDir, "log", fullName, flow, "run.log"),
    eventLogPath: resolve(caseDir, "log", "events.jsonl"),
  };

  /** The fork, stood in for: it settles only when the case says the child exited, exactly
   *  as the real one does — so a queued second item is genuinely still waiting. */
  const forked: Job[] = [];
  const exits = new Map<string, (exit: ChildExit) => void>();
  const fork: ForkWorkItem = (job) => {
    // Every case here is an issue run — a PR-comment run's failures are the same policy's
    // and are driven where the lane is (`test/smoke-assignor.mts`).
    if ("pr" in job) throw new Error("no case in this smoke forks a PR-comment run");
    forked.push(job);
    acquireLock(job.pidPath, process.pid);
    return new Promise((settle) => exits.set(job.key, settle));
  };

  /** How a stopped repo heals, stood in for: the rebuild is docker (minutes), and the
   *  re-derive is `assignor/reconcile.mts` reading GitHub. `imageBroken` is the reason a
   *  rebuild still fails, and `fix()` is the human editing the Dockerfile. */
  const rebuilt: string[] = [];
  const reDerived: string[] = [];
  let broken = over.imageBroken;
  const recheck = {
    rebuild: async (repo: string) => {
      rebuilt.push(repo);
      return broken;
    },
    reconcile: async (repo: string) => void reDerived.push(repo),
    // Constraint 11 again: milliseconds here, five minutes in production.
    everyMs: 5,
  };

  const policy = new FailurePolicy({
    pause,
    scheduler,
    state,
    github: labels,
    log: logger.child("failure"),
    // Constraint 11: the timing constants are injected, so the suite drives a REAL timer
    // at millisecond scale instead of a mocked clock.
    resumeGraceMs: over.resumeGraceMs ?? 5,
    recheck,
  });

  const assignor = new Assignor({
    repos: TABLE,
    github,
    log: logger.child("assignor"),
    scheduler,
    state,
    fork,
    paths,
    // Nothing in this file merges a pull request — what a merge sets off is #43's own
    // smoke's subject, and the real one force-pushes branches.
    restack: async () => {},
    failure: policy,
  });

  const delivery = (number: number, repo = "acme/finance"): Delivery => ({
    event: "issues",
    action: "labeled",
    repo,
    number,
    labels: ["sunday"],
    onPullRequest: false,
    merged: false,
  });

  /** Admit one issue the way a webhook does, and let it reach the fork. */
  const admit = async (number: number, repo?: string) => {
    assignor.handle(delivery(number, repo));
    await tick();
  };

  /** The child finishing: what it left on disk, then the exit the parent settles on. */
  const finish = async (number: number, outcome: Partial<Outcome> & Pick<Outcome, "status" | "summary">) => {
    const key = `acme/finance#${number}`;
    writeOutcome(paths.resultPath(key), { key, finishedAt: "2026-07-26T00:00:00.000Z", ...outcome });
    exits.get(key)?.({ code: 0, signal: null });
    await tick();
  };

  const started = () => forked.map((j) => j.key);
  return {
    policy,
    assignor,
    scheduler,
    pause,
    state,
    lines,
    comments,
    claimed,
    released,
    labelled,
    forked,
    admit,
    finish,
    started,
    rebuilt,
    reDerived,
    /** The human who edits the Dockerfile: the next recheck builds clean. */
    fix: () => void (broken = undefined),
  };
}

/** The item every act case below is about, and a second one queued alongside it: whether
 *  the OTHER work item keeps running is the entire difference between a scope and a halt. */
const ITEM: WorkItemRef = { key: "acme/finance#57", repo: "acme/finance", issue: 57, kind: "issue" };

/** The halt line — pipeline scope, so it is the one line that carries no repo at all. */
const halted = (lines: LogLine[]) => lines.find((l) => l.message.includes("halt"));

try {
  // ── quota: the subscription's window is spent, so every run would hit the same wall.
  //    The pause is armed DURABLY as well as in memory — the scheduler's flag dies with
  //    the process, and a restart that read no file would spend the quota it is waiting on ──
  {
    const h = harness({ resumeGraceMs: 30 });
    const resetAt = Date.now() + 40;
    h.policy.failed({
      text: `Usage limit reached. Your limit resets at ${new Date(resetAt).toISOString()}`,
      repo: ITEM.repo,
      item: ITEM,
    });

    ok("quota: the scheduler is paused, so nothing new starts anywhere", h.scheduler.isPaused());
    const armed = h.pause.read();
    ok("quota: the pause is durable, so a restart inside the window stays paused", armed !== undefined, JSON.stringify(armed));
    ok(
      "quota: the resume is the reset PLUS the grace — resuming exactly at it races the provider",
      armed?.resumeAt === resetAt + 30,
      JSON.stringify(armed),
    );

    // The halt is only worth anything if it actually holds work back: an item admitted
    // into the window is claimed and queued, and starts when the window closes.
    await h.admit(58);
    ok("quota: work admitted into the window is held, not started", h.started().length === 0, h.started().join(","));

    ok("quota: the window closing resumes the pipeline by itself", await until(() => !h.scheduler.isPaused()));
    ok(
      "quota: and disarms the pause on disk, or the next boot re-applies a window that has closed",
      h.pause.read() === undefined,
      JSON.stringify(h.pause.read()),
    );
    await tick();
    ok("quota: the work it held starts as soon as it resumes", h.started().join(",") === "acme/finance#58", h.started().join(","));
  }

  // ── a quota that named no reset has nothing to lift itself on. It waits for a human,
  //    and must NOT guess a window: resuming on a guess feeds the backlog into the wall ──
  {
    const h = harness();
    h.policy.failed({ text: "You have exceeded your usage limit for this period.", repo: ITEM.repo, item: ITEM });
    ok("quota (no reset): the pipeline is paused", h.scheduler.isPaused());
    ok("quota (no reset): with nothing to auto-resume on", h.pause.read()?.resumeAt === undefined, JSON.stringify(h.pause.read()));
    await new Promise((r) => setTimeout(r, 30));
    ok("quota (no reset): so it is still held a window later — a human lifts this one", h.scheduler.isPaused() && h.pause.read() !== undefined);
  }

  // ── nor does a quota whose reset is further out than a timer can hold. `setTimeout`
  //    CLAMPS a delay over ~24.8 days to 1ms instead of refusing it, so a nonsense reset —
  //    the likeliest product of the PROVISIONAL patterns until real provider text tightens
  //    them — would lift the pause almost at once and feed the backlog straight back into
  //    the wall. An unusable reset gets the same answer as an absent one: a human lifts it ──
  {
    const h = harness();
    h.policy.failed({ text: "Usage limit reached. Your limit resets at 2099-01-01T00:00:00Z", repo: ITEM.repo, item: ITEM });
    ok("quota (unholdable reset): the pipeline is paused", h.scheduler.isPaused());
    ok(
      "quota (unholdable reset): with nothing to auto-resume on, so the next boot re-arms it as a human's to lift",
      h.pause.read()?.resumeAt === undefined,
      JSON.stringify(h.pause.read()),
    );
    ok(
      "quota (unholdable reset): and the reset it named is reported rather than silently dropped",
      halted(h.lines)?.message.includes("2099-01-01") === true && halted(h.lines)?.message.includes("further out than a timer can hold") === true,
      JSON.stringify(halted(h.lines)),
    );
    await new Promise((r) => setTimeout(r, 30));
    ok("quota (unholdable reset): so no clamped timer lifts it a moment later", h.scheduler.isPaused() && h.pause.read() !== undefined);
  }

  // ── auth: the credential is process-wide, so every run fails identically and instantly.
  //    No reset exists — a token does not fix itself on a clock — and it is reported as a
  //    failure rather than a wall ──
  {
    const h = harness();
    h.policy.failed({ text: "Request failed: 403 Forbidden — invalid API key", repo: ITEM.repo, item: ITEM });
    ok("auth: the pipeline is paused", h.scheduler.isPaused());
    ok("auth: no resumeAt — a credential does not fix itself on a clock", h.pause.read()?.resumeAt === undefined, JSON.stringify(h.pause.read()));
    ok("auth: reported at error, which is what reaches the phone", halted(h.lines)?.level === "error", JSON.stringify(halted(h.lines)));
  }

  // ── the level is the priority channel: a quota wall is operator-facing and NOT a break
  //    (`alert`), an auth failure is something broken (`error`). Both reach the phone ──
  {
    const h = harness();
    h.policy.failed({ text: "Claude usage limit reached — resets at 2099-01-01T00:00:00Z", repo: ITEM.repo, item: ITEM });
    ok("quota: reported at alert — a wall Sunday is waiting out, not a break", halted(h.lines)?.level === "alert", JSON.stringify(halted(h.lines)));
    ok("halt: the line says WHY the pipeline stopped", halted(h.lines)?.message.includes("quota exhausted") === true, JSON.stringify(halted(h.lines)));
  }

  // ── constraint 5: a pipeline-scope line carries NO repo and NO target, so a halt lands
  //    on no issue thread. The item that happened to hit the wall did nothing wrong, and
  //    the next 200 items would each carry the same comment ──
  {
    for (const [what, text] of [
      ["quota", "Usage limit reached. Your limit resets at 2099-01-01T00:00:00Z"],
      ["auth", "Request failed: 403 Forbidden — invalid API key"],
    ] as const) {
      const h = harness();
      h.policy.failed({ text, repo: ITEM.repo, item: ITEM });
      const line = halted(h.lines);
      ok(`${what}: the halt names no repo and no issue`, line?.context.repo === undefined && line?.context.target === undefined, JSON.stringify(line));
      ok(`${what}: so it reaches no issue thread`, h.comments.length === 0, JSON.stringify(h.comments.map((c) => c.message)));
    }
  }

  // ── …and NOTHING ELSE does. This is the defect ADR-0002 removes: v1 halted the whole
  //    pipeline on anything it did not recognise, which is why it sat stopped for hours on
  //    one bad issue. Only the three above may arm the pause (constraint 4) ──
  {
    for (const [what, input] of [
      ["unknown", { text: "something entirely unexpected happened" }],
      ["a dead child", { text: "child exited with code 1 leaving no outcome" }],
      ["transient", { text: "429 Too Many Requests — retry-after: 30" }],
      ["a broken image", { text: "Provider 'docker' create failed: Image 'x:latest' not found locally." }],
      // The teeth of constraint 3: the agent's own failure description is arbitrary text,
      // and no phrase inside it may reach out and stop everyone else's work.
      ["the agent's own verdict", { text: "I gave up: the usage limit reached in the task.", agentFailed: true }],
    ] as const) {
      const h = harness();
      h.policy.failed({ ...input, repo: ITEM.repo, item: ITEM });
      ok(`${what}: the pipeline keeps running`, !h.scheduler.isPaused(), JSON.stringify(h.lines.map((l) => l.message)));
      ok(`${what}: and nothing is armed on disk, so the next boot starts working`, h.pause.read() === undefined, JSON.stringify(h.pause.read()));
      ok(`${what}: and it is accounted for by a line`, h.lines.length > 0);
    }

    // The one setup failure that is not one repo's: no image anywhere can be built or run
    // while the daemon is down, so this is the third thing allowed to stop the pipeline.
    const d = harness();
    d.policy.failed({ text: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock", repo: ITEM.repo });
    ok("a dead container daemon: no sandbox can be created anywhere, so this one halts", d.scheduler.isPaused() && d.pause.read() !== undefined);
    ok("a dead container daemon: reported at error — something is broken", halted(d.lines)?.level === "error", JSON.stringify(halted(d.lines)));
  }

  // ── the routing: a failure reaches the policy through ONE sink (constraint 1) —
  //    `Assignor.record`, which the live path and boot's recovery sweep already share. A
  //    second entry point is how v1's live and recovery paths drifted apart ──
  {
    const h = harness();
    await h.admit(57);
    await h.admit(58);
    ok("record: two work items are running", h.started().join(",") === "acme/finance#57,acme/finance#58", h.started().join(","));

    await h.finish(57, { status: "failed", summary: "Usage limit reached. Your limit resets at 2099-01-01T00:00:00Z" });
    ok("record: a failed outcome reaches the policy, and the wall in it halts the pipeline", h.scheduler.isPaused());
    ok("record: with the pause armed durably", h.pause.read() !== undefined, JSON.stringify(h.pause.read()));
    // Constraint 6: the raw error is the outcome milestone the apply already posted, and
    // the halt says what Sunday is DOING — one copy of the error on the issue, not two.
    const raw = h.comments.filter((c) => c.message.includes("Usage limit reached"));
    ok("record: the raw error reaches the issue exactly once", raw.length === 1, JSON.stringify(h.comments.map((c) => c.message)));
  }

  // ── the other half of the same sink, and the whole point of the issue: an unrecognised
  //    failure stops ONE work item, and every other item in every other repo keeps going ──
  {
    const h = harness();
    await h.admit(57);
    await h.finish(57, { status: "failed", summary: "something entirely unexpected happened" });
    ok("record: an unrecognised failure leaves the pipeline running", !h.scheduler.isPaused(), JSON.stringify(h.lines.map((l) => l.message)));
    ok("record: and arms nothing on disk", h.pause.read() === undefined, JSON.stringify(h.pause.read()));

    await h.admit(58);
    ok("record: so the next work item starts", h.started().includes("acme/finance#58"), h.started().join(","));
    await h.finish(58, { status: "done", summary: "shipped it" });
    ok("record: and runs all the way to done", h.state.get("acme/finance#58")?.status === "done", JSON.stringify(h.state.all()));
    ok("record: a successful outcome is never classified", !h.lines.some((l) => l.message.includes("shipped it") && l.module === "failure"));
  }

  // ── the item ladder, first rung: an unrecognised failure is neither a halt nor a dead
  //    item. It is RESTARTED once, carrying its own error into the prompt — the one thing
  //    a fresh run would not know — and the retry is spent DURABLY, because a restart that
  //    forgot it hands every failed item another agent run on real quota (constraint 7) ──
  {
    const h = harness();
    await h.admit(57);
    await h.admit(58);
    const before = h.comments.length;
    await h.finish(57, { status: "failed", summary: "something entirely unexpected happened" });

    ok(
      "unknown: the item is started again — once, and through the Assignor's own claim-and-enqueue",
      await until(() => h.started().filter((k) => k === ITEM.key).length === 2),
      h.started().join(","),
    );
    const retry = h.forked.at(-1);
    ok(
      "unknown: the retry hands the agent the error the last run died on, which is the whole point of retrying it",
      retry?.retryError?.includes("something entirely unexpected") === true,
      JSON.stringify(retry?.retryError),
    );
    ok("unknown: it is claimed again, like any other start — an unclaimed run looks free to the next delivery", h.claimed.filter((k) => k === ITEM.key).length === 2, h.claimed.join(","));
    ok("unknown: on the base the item was admitted on, re-asserted rather than re-derived", retry?.base === "main", JSON.stringify(retry?.base));
    ok(
      "unknown: the retry is spent durably, so a restart cannot hand this item a second one",
      h.state.get(ITEM.key)?.status === "in-flight" && h.state.get(ITEM.key)?.retried === true,
      JSON.stringify(h.state.get(ITEM.key)),
    );
    ok(
      "unknown: the raw error reaches the issue exactly once — the outcome milestone carries it, and the policy says what Sunday is DOING (constraint 6)",
      h.comments.filter((c) => c.message.includes("something entirely unexpected")).length === 1,
      JSON.stringify(h.comments.slice(before).map((c) => c.message)),
    );
    ok(
      "unknown: and it says that at info — a retry is the mechanism working, not something a human has to act on",
      h.lines.find((l) => l.module === "failure" && l.message.includes("retry"))?.level === "info",
      JSON.stringify(h.lines.filter((l) => l.module === "failure").map((l) => `${l.level} ${l.message}`)),
    );
    ok("unknown: and the work item queued alongside it is untouched", h.started().includes("acme/finance#58"), h.started().join(","));
  }

  // ── …and the rung after it: the retry failed too, so the item is SET ASIDE. Quarantine
  //    is durable and distinct from `failed` (constraint 7) — a failed item is exactly what
  //    the next reconcile re-admits, which is the loop this issue exists to stop — and it
  //    is the one thing on this ladder a human is told about, because only a human can end
  //    it ──
  {
    const h = harness();
    await h.admit(57);
    await h.admit(58);
    await h.finish(57, { status: "failed", summary: "something entirely unexpected happened" });
    await until(() => h.started().filter((k) => k === ITEM.key).length === 2);
    await h.finish(57, { status: "failed", summary: "the retry died the same way" });

    ok("quarantine: the item is set aside, in a state reconcile does NOT pick back up", h.state.get(ITEM.key)?.status === "quarantined", JSON.stringify(h.state.get(ITEM.key)));
    ok(
      "quarantine: the label goes on, which is what a human takes off to hand the item back",
      h.labelled.join(",").includes("acme/finance#57 +quarantined"),
      h.labelled.join(","),
    );
    const said = h.lines.find((l) => l.module === "failure" && l.message.includes("quarantine"));
    ok("quarantine: reported at error — the P1 notification ADR-0002 asks for, which is what reaches a phone", said?.level === "error", JSON.stringify(said));
    ok(
      "quarantine: addressed at the issue, so the release instruction lands where the human is reading",
      said?.context.repo === "acme/finance" && said.context.target === 57,
      JSON.stringify(said?.context),
    );
    ok("quarantine: and it says how to release it — a set-aside item with no instructions is a dead one", said?.message.includes("quarantined") === true, JSON.stringify(said?.message));
    ok("quarantine: the item is not started a third time — the retry is one, and it is spent", h.started().filter((k) => k === ITEM.key).length === 2, h.started().join(","));

    // The whole of ADR-0002 in one assertion: the work item beside this one does not just
    // survive the quarantine, it finishes.
    await h.finish(58, { status: "done", summary: "shipped it" });
    ok(
      "quarantine: and the work item beside it runs all the way to done — nothing else is affected",
      !h.scheduler.isPaused() && h.state.get("acme/finance#58")?.status === "done",
      JSON.stringify(h.state.all()),
    );
  }

  // ── the label is a SIGNAL and durable state is the guard, which is what makes the label
  //    write best-effort (constraint 9). The likely failure is a repo onboarded before this
  //    label existed — and a policy that threw there would leave the item unquarantined, on
  //    a path reached from a timer with nobody above it (ADR-0001) ──
  {
    const h = harness({ labelFails: true });
    await h.admit(57);
    await h.finish(57, { status: "failed", summary: "something entirely unexpected happened" });
    await until(() => h.started().filter((k) => k === ITEM.key).length === 2);
    await h.finish(57, { status: "failed", summary: "the retry died the same way" });
    await tick(); // the label write is a promise; its failure lands on the next turn

    ok("label failure: the quarantine is recorded anyway — durable state is what stops the item being re-admitted", h.state.get(ITEM.key)?.status === "quarantined", JSON.stringify(h.state.get(ITEM.key)));
    const failed = h.lines.find((l) => l.message.includes("could not be labelled"));
    ok("label failure: and the write that failed is said out loud, naming the one-line fix", failed?.message.includes("gh label create quarantined") === true, JSON.stringify(failed?.message));
    ok(
      "label failure: to whoever can fix the repo, and NOT to the issue — that thread has had its one comment",
      failed?.level === "error" && failed.context.repo === "acme/finance" && failed.context.target === undefined,
      JSON.stringify(failed),
    );
    ok("label failure: and nothing stops — a failure handled badly must not become a halt", !h.scheduler.isPaused(), JSON.stringify(h.pause.read()));
  }

  // ── …and the release. The signal is the LABEL's absence, because `labeled` and reconcile
  //    are the only two ways a label change reaches admission — and both hand it the
  //    issue's CURRENT labels, so one guard serves the live delivery and the re-derive
  //    alike. Released, the item starts with its retry budget back: an item that kept a
  //    spent retry would quarantine on its first failure after every release ──
  {
    const h = harness();
    await h.admit(57);
    await h.finish(57, { status: "failed", summary: "something entirely unexpected happened" });
    await until(() => h.started().filter((k) => k === ITEM.key).length === 2);
    await h.finish(57, { status: "failed", summary: "the retry died the same way" });
    const held = h.started().length;

    // The trigger label landing again — a human re-labelling an issue they have not
    // actually released. GitHub redelivers these for as long as the label is on.
    h.assignor.handle({ event: "issues", action: "labeled", repo: ITEM.repo, number: 57, labels: ["sunday", "quarantined"], onPullRequest: false, merged: false });
    await tick();
    ok("release: a delivery while the label is on does not start it again", h.started().length === held, h.started().join(","));

    // The same issue as the next boot's reconcile hands it over — same seam, same labels.
    await h.assignor.considerIssue({ repo: ITEM.repo, number: 57, labels: ["sunday", "quarantined"] });
    ok("release: and neither does a reconcile — one guard, so the live and recovery paths cannot drift", h.started().length === held, h.started().join(","));
    ok("release: the item is still set aside while it is held", h.state.get(ITEM.key)?.status === "quarantined", JSON.stringify(h.state.get(ITEM.key)));

    // A human takes the label off and re-labels it.
    await h.assignor.considerIssue({ repo: ITEM.repo, number: 57, labels: ["sunday"] });
    ok("release: the label gone, the item is admitted again", h.started().length === held + 1, h.started().join(","));
    ok(
      "release: with its retry budget back — a released item that kept a spent retry quarantines on its first failure ever",
      h.state.get(ITEM.key)?.status === "in-flight" && h.state.get(ITEM.key)?.retried === undefined,
      JSON.stringify(h.state.get(ITEM.key)),
    );
  }

  // ── the agent RAN and reported its own defeat. There is nothing to retry — the run
  //    happened, and a second one spends real quota re-deciding what it already decided —
  //    and nothing to quarantine either: the issue is the problem, and a human re-labelling
  //    it is what starts the next attempt ──
  {
    const h = harness();
    await h.admit(57);
    await h.finish(57, {
      status: "failed",
      summary: "Could not make the integration test pass.\n\nsignal fail, but no commits — nothing to ship.",
      agentFailed: true,
    });
    await tick();

    ok("run-failed: the issue is labelled agent-failed, which is what a human triages on", h.labelled.join(",").includes("acme/finance#57 +agent-failed"), h.labelled.join(","));
    ok("run-failed: it is NOT started again — the agent ran, and its verdict is not a blip", h.started().filter((k) => k === ITEM.key).length === 1, h.started().join(","));
    ok(
      "run-failed: nor set aside — it stays `failed`, which is the state a re-label picks back up",
      h.state.get(ITEM.key)?.status === "failed",
      JSON.stringify(h.state.get(ITEM.key)),
    );
    ok("run-failed: and the retry budget is left unspent, because nothing spent it", h.state.get(ITEM.key)?.retried === undefined, JSON.stringify(h.state.get(ITEM.key)));

    // …and because nothing moves it again, the human is PAGED. The level is the whole of
    // it: `error` is the one that reaches the phone, and the phone is the only place a
    // human standing away from a desk finds out (`test/smoke-logger.mts` owns the routing;
    // the level is the complete pin here).
    const parked = h.lines.find((l) => l.module === "failure" && l.message.includes(ITEM.key));
    ok(
      "run-failed: the human is told at error — an item that will not move again until they act is not routine progress",
      parked?.level === "error",
      JSON.stringify(h.lines.filter((l) => l.module === "failure").map((l) => `${l.level} ${l.message}`)),
    );
    ok(
      "run-failed: addressed at the issue as well, so the hand-back is readable from where the work is",
      parked?.context.repo === "acme/finance" && parked.context.target === 57,
      JSON.stringify(parked?.context),
    );
    ok(
      "run-failed: carrying what the agent actually said — a page that only says 'it failed' still costs a trip to a desktop",
      parked?.message.includes("Could not make the integration test pass") === true,
      JSON.stringify(parked?.message),
    );
    ok(
      "run-failed: and how to hand it back, naming the label — a parked item with no instructions is a lost one",
      parked?.message.includes("agent-failed") === true && parked.message.includes("trigger label"),
      JSON.stringify(parked?.message),
    );
    // Rewritten (#68): this used to pin that the agent's words cost the issue no second
    // comment. Paging the diagnosis is what buys the repeat, so the bound is now the intent —
    // exactly two, the outcome milestone and this parked notice, and never a third.
    ok(
      "run-failed: the agent's words reach the thread exactly twice — the outcome milestone, then the notice that says what to do about them",
      h.comments
        .filter((c) => c.message.includes("integration test"))
        .map((c) => c.level)
        .join(",") === "milestone,error",
      JSON.stringify(h.comments.map((c) => `${c.level} ${c.message}`)),
    );
  }

  // ── a blip gets the same single retry, and ends differently: `failed` is where a
  //    transient failure stops, because the next reconcile re-admits one and somebody
  //    else's 502 is not a reason to set a work item aside for a human. (Named ceiling: one
  //    retry, not a bounded backoff loop — if that proves too few, the upgrade is a count
  //    instead of the boolean.) ──
  {
    const h = harness();
    await h.admit(57);
    await h.finish(57, { status: "failed", summary: "429 Too Many Requests — retry-after: 30" });
    ok("transient: the item is started again", await until(() => h.started().filter((k) => k === ITEM.key).length === 2), h.started().join(","));
    ok(
      "transient: with NO error handed to the agent — the blip was not its fault, and somebody else's 502 in the prompt is noise",
      h.forked.at(-1)?.retryError === undefined,
      JSON.stringify(h.forked.at(-1)?.retryError),
    );

    await h.finish(57, { status: "failed", summary: "gh: Server Error (HTTP 502)" });
    ok(
      "transient: the second failure stops at `failed` — the next reconcile re-admits it, where a quarantine never would",
      h.state.get(ITEM.key)?.status === "failed",
      JSON.stringify(h.state.get(ITEM.key)),
    );
    ok("transient: and nothing is labelled — a blip is not something to set aside for a human", h.labelled.length === 0, h.labelled.join(","));
    ok("transient: nor started a third time", h.started().filter((k) => k === ITEM.key).length === 2, h.started().join(","));
  }

  // ── the repo scope: one child's sandbox image is broken, so nothing in THAT repo can
  //    run — and every other repo carries on. v1 read exactly this create failure as
  //    `unknown` and stopped everything on it (captured 2026-07-24, finance#55), which is
  //    the day ADR-0002 was written about ──
  {
    const h = harness({ imageBroken: "Image 'sunday-finance:latest' not found locally" });
    await h.admit(57);
    await h.finish(57, {
      status: "failed",
      summary: "Provider 'docker' create failed: Image 'sunday-finance:latest' not found locally.",
    });

    ok(
      "setup: the pipeline keeps running — one broken image is one repo's problem",
      !h.scheduler.isPaused() && h.pause.read() === undefined,
      JSON.stringify(h.pause.read()),
    );
    ok("setup: and that repo is stopped, because every run in it would die the same way", h.policy.isStopped("acme/finance"));
    ok(
      "setup: the item that hit it is left `failed` — the state the re-derive picks back up once the repo builds",
      h.state.get(ITEM.key)?.status === "failed",
      JSON.stringify(h.state.get(ITEM.key)),
    );
    ok(
      "setup: and it is NOT retried — a missing image does not appear on a second run, it just spends the quota",
      h.started().filter((k) => k === ITEM.key).length === 1,
      h.started().join(","),
    );

    const said = h.lines.find((l) => l.module === "failure" && l.message.includes("stopped"));
    ok("setup: reported at error — a broken environment is something a human has to go and fix", said?.level === "error", JSON.stringify(said));
    ok(
      "setup: naming the repo and NO issue, so a broken image comments on no issue thread (constraint 5)",
      said?.context.repo === "acme/finance" && said.context.target === undefined,
      JSON.stringify(said?.context),
    );

    // The teeth of the scope: admission into the stopped repo is refused, and admission
    // anywhere else is untouched.
    await h.admit(58);
    ok("setup: a delivery in the stopped repo is not started on an image that is not there", !h.started().includes("acme/finance#58"), h.started().join(","));
    ok(
      "setup: it is skipped with a reason — an issue that goes quiet with no line is the defect this rewrite exists to kill",
      h.lines.some((l) => l.message.includes("skip acme/finance#58") && l.message.includes("stopped")),
      JSON.stringify(h.lines.map((l) => l.message)),
    );

    await h.admit(11, "acme/ops");
    ok("setup: while a work item in another repo starts as if nothing happened", h.started().includes("acme/ops#11"), h.started().join(","));

    // Nobody is watching the child repo but Sunday, so the stop lifts ITSELF: the image is
    // rebuilt on a timer, and a clean build is the signal that the repair landed.
    ok("setup: the image is rechecked on a timer", await until(() => h.rebuilt.includes("acme/finance")), h.rebuilt.join(","));
    ok("setup: and while it is still broken the repo stays stopped", h.policy.isStopped("acme/finance"));
    ok("setup: only the stopped repo is rebuilt — a healthy repo's image is not rebuilt on somebody else's failure", h.rebuilt.every((r) => r === "acme/finance"), h.rebuilt.join(","));

    h.fix(); // the human edits the Dockerfile, or starts the daemon
    ok("setup: a recheck that builds clean clears the stop", await until(() => !h.policy.isStopped("acme/finance")));
    ok(
      "setup: and re-derives that repo, which is what brings back the items that died on the broken image",
      await until(() => h.reDerived.includes("acme/finance")),
      h.reDerived.join(","),
    );
    ok("setup: that repo only — a re-derive of everybody's backlog is somebody else's rate limit", h.reDerived.every((r) => r === "acme/finance"), h.reDerived.join(","));

    // What the re-derive meets: it hands every open issue to the same admission seam, so
    // the guard being gone IS the re-admission.
    await h.assignor.considerIssue({ repo: "acme/finance", number: 58, labels: ["sunday"] });
    ok("setup: so the work the stop held back starts again, with no bookkeeping of its own", h.started().includes("acme/finance#58"), h.started().join(","));
  }

  // ── …unless the container daemon itself is down. No image anywhere can be built or run
  //    then, so this is the third thing allowed to stop the pipeline (constraint 4):
  //    stopping one repo for it would leave every other repo dying item by item ──
  {
    const h = harness();
    h.policy.failed({
      text: "Provider 'docker' create failed: Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
      repo: ITEM.repo,
      item: ITEM,
    });
    ok("a dead daemon: the pipeline stops instead", h.scheduler.isPaused() && h.pause.read() !== undefined, JSON.stringify(h.pause.read()));
    ok("a dead daemon: and no single repo is blamed for it — there is nothing to rebuild until the daemon is back", !h.policy.isStopped(ITEM.repo));
  }

  // ── an auth halt armed WHILE a quota window is running outranks it: the quota's timer
  //    is not the auth halt's to lift, and resuming into a credential that is still broken
  //    fails every queued item instantly and re-arms nothing that says so ──
  {
    const h = harness({ resumeGraceMs: 5 });
    h.policy.failed({ text: `Usage limit reached. Your limit resets at ${new Date(Date.now() + 10).toISOString()}`, repo: ITEM.repo });
    h.policy.failed({ text: "Request failed: 403 Forbidden — invalid API key", repo: ITEM.repo });
    await new Promise((r) => setTimeout(r, 60)); // past the quota window

    ok("a later halt wins: the quota window closing does not lift the auth halt", h.scheduler.isPaused());
    ok("a later halt wins: and the auth halt is still armed on disk", h.pause.read()?.reason.includes("auth") === true, JSON.stringify(h.pause.read()));
  }

  // ── one wall, one page. The wall is process-wide, so every agent in flight hits it
  //    within seconds of the first — `maxConcurrency` failed outcomes, each reaching the
  //    policy on its own. Deduplicated exactly as a repo stop is: the pipeline is already
  //    halted on the same terms, so the rest are accounted for at `info` and page nobody,
  //    and the armed pause is left alone rather than re-written under its own timer ──
  {
    const h = harness({ resumeGraceMs: 5 });
    const text = `Usage limit reached. Your limit resets at ${new Date(Date.now() + 10_000).toISOString()}`;
    h.policy.failed({ text, repo: ITEM.repo, item: ITEM });
    const armed = JSON.stringify(h.pause.read());
    h.policy.failed({ text, repo: "acme/ops", item: { key: "acme/ops#1", repo: "acme/ops", issue: 1, kind: "issue" } });
    h.policy.failed({ text, repo: ITEM.repo, item: { key: "acme/finance#58", repo: ITEM.repo, issue: 58, kind: "issue" } });

    const paged = h.lines.filter((l) => l.level === "alert" || l.level === "error");
    ok("one wall: three items on the same wall page a human once", paged.length === 1, JSON.stringify(paged.map((l) => l.message)));
    ok("one wall: and the armed pause is untouched, so the auto-resume it scheduled still lifts it", JSON.stringify(h.pause.read()) === armed, JSON.stringify(h.pause.read()));
    ok("one wall: with the duplicates still accounted for", h.lines.filter((l) => l.message.includes("already halted")).length === 2, JSON.stringify(h.lines.map((l) => l.message)));

    // …and a halt that says something NEW is not a duplicate: an auth failure landing in
    // the window takes the auto-resume away, and a human has to hear that.
    h.policy.failed({ text: "Request failed: 403 Forbidden — invalid API key", repo: ITEM.repo });
    ok(
      "one wall: an auth halt arriving during it still pages, because it changes the answer",
      h.lines.filter((l) => l.level === "alert" || l.level === "error").length === 2,
      JSON.stringify(h.lines.map((l) => `${l.level} ${l.message}`)),
    );
    ok("one wall: and re-arms the pause with nothing to lift itself on", h.pause.read()?.resumeAt === undefined, JSON.stringify(h.pause.read()));
  }

  // ── the same rule the other way round, which is the one that would be dangerous: a quota
  //    window landing on an armed AUTH halt must not hand a broken credential an auto-resume
  //    it never had — the pipeline would lift itself into a 403 and fail every queued item ──
  {
    const h = harness({ resumeGraceMs: 5 });
    h.policy.failed({ text: "Request failed: 403 Forbidden — invalid API key", repo: ITEM.repo });
    h.policy.failed({ text: `Usage limit reached. Your limit resets at ${new Date(Date.now() + 10).toISOString()}`, repo: ITEM.repo });
    await new Promise((r) => setTimeout(r, 40)); // past the quota window

    ok("a quota window does not lift an auth halt", h.scheduler.isPaused() && h.pause.read()?.reason.includes("auth") === true, JSON.stringify(h.pause.read()));
  }

  // ── constraint 9: the policy NEVER throws. It sits on every failure path and is reached
  //    from timers with nobody above them, so a throw is either a work item that dies
  //    twice or an unhandled rejection that takes the parent down under `restart: always`.
  //    And the in-memory pause goes on FIRST, so a disk that cannot be written still
  //    leaves the pipeline stopped rather than spending the quota it was told about ──
  {
    /** A real store on a disk that will not take it: `gh` fails, and so does `write`. */
    class FullDisk extends PauseStore {
      override write(): void {
        throw new Error("ENOSPC: no space left on device");
      }
    }
    const h = harness({ pause: new FullDisk(resolve(dir, "full-disk", "pause.json")) });
    let threw = false;
    try {
      h.policy.failed({ text: "Request failed: 403 Forbidden — invalid API key", repo: ITEM.repo, item: ITEM });
    } catch {
      threw = true;
    }
    ok("never throws: a durable write that fails does not reach the caller", !threw);
    ok("never throws: and the pipeline is stopped anyway — the in-memory pause cannot fail", h.scheduler.isPaused());
    ok("never throws: with what broke said out loud", h.lines.some((l) => l.message.includes("ENOSPC")), JSON.stringify(h.lines.map((l) => l.message)));
  }

  console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(fails === 0 ? 0 : 1);
