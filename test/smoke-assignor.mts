// test/smoke-assignor.mts — hermetic smoke for the one thing that DECIDES: the
// Assignor. It drives the real Assignor over the real scheduler, the real state store
// and the real Logger, with the two things that reach the world substituted — GitHub
// and the fork — so what is asserted is the decisions, not the wiring.
//   devbox run node test/smoke-assignor.mts
// Every path it uses is injected, so nothing here goes near the real `var/` and no
// child is ever spawned. $0, no network, no GitHub.

import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import type { RepoConfig } from "#config/repos.mts";
import {
  admitIssue,
  Assignor,
  parseWorkItemKey,
  type ChildExit,
  type Delivery,
  type ForkWorkItem,
  type Paths,
  type WorkItemRef,
} from "#assignor/index.mts";
import { classify, FailurePolicy } from "#assignor/failure.mts";
import { PauseStore } from "#assignor/pause.mts";
import { createScheduler } from "#assignor/scheduler.mts";
import { StateStore } from "#assignor/state.mts";
import type { Job } from "#issue/run.mts";
import type { PrJob } from "#pr/run.mts";
import { acquireLock, readLock } from "#lib/lock.mts";
import { sundayComment, sundayReply, SUNDAY_MARKER } from "#lib/markers.mts";
import { writeOutcome, type Outcome } from "#lib/outcome.mts";
import { commentBody } from "#services/destinations.mts";
import type { GitHub } from "#services/github/index.mts";
import { Logger, type Destinations, type LogLine } from "#services/logger.mts";

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : `\n    ${detail}`}`);
};
const tick = () => new Promise((r) => setTimeout(r, 0)); // flush the scheduler's microtasks

/** A routing table with TWO trigger labels, so "all present" and "one missing" are
 *  different answers rather than the same one. */
const TABLE: Record<string, RepoConfig> = {
  "acme/finance": {
    path: "repos/finance",
    imageName: "sunday-finance",
    promptFile: "docs/prompt.md",
    triggerLabels: ["sunday", "ready-for-agent"],
  },
};

const dir = resolve(import.meta.dirname, "..", ".scratch", `smoke-assignor-${process.pid}`);
let caseNo = 0;

/** One delivery as the receiver normalises it, defaulting to the one the spine cares
 *  about: a trigger label landing on a routed issue. */
function delivery(over: Partial<Delivery> = {}): Delivery {
  return {
    event: "issues",
    action: "labeled",
    repo: "acme/finance",
    number: 57,
    labels: ["sunday", "ready-for-agent"],
    onPullRequest: false,
    merged: false,
    ...over,
  };
}

/** A human's comment on the issue, as the receiver hands one over. */
function reply(body: string, over: Partial<Delivery> = {}): Delivery {
  return delivery({ event: "issue_comment", action: "created", comment: body, ...over });
}

/** A comment on a pull request's CONVERSATION (#44). GitHub delivers one as an
 *  `issue_comment` whose subject carries a `pull_request` key — the only thing separating
 *  it from a comment on an issue. */
function prComment(body: string, over: Partial<Delivery> = {}): Delivery {
  return reply(body, { onPullRequest: true, labels: [], ...over });
}

/** …and the other stream: a comment left INLINE on a file line, which arrives as its own
 *  event and is always about a pull request. */
function inlineComment(body: string, over: Partial<Delivery> = {}): Delivery {
  return prComment(body, { event: "pull_request_review_comment", head: "feat/57", ...over });
}

/** A real Assignor over the real scheduler, state store and Logger, with the two things
 *  that reach the world substituted: GitHub (every method is a real write to a real
 *  repo) and the fork (a child process). Every path it uses points into this case's own
 *  dir, so the real `var/` is never touched. */
function harness(reads: Partial<GitHub> = {}, restackError?: string) {
  const caseDir = resolve(dir, `case-${caseNo++}`);
  /** Every line either module emits, at any level — the run log is the one destination
   *  every level routes to. */
  const lines: LogLine[] = [];
  /** What actually reaches GitHub as a comment. `milestone` is the only level in this
   *  issue that gets here, which is what "exactly two comments per work item" means. */
  const comments: LogLine[] = [];
  const dests: Destinations = {
    console: () => {},
    runLog: (line) => void lines.push(line),
    eventLog: () => {},
    github: (line) => void comments.push(line),
    phone: () => {},
  };

  const claimed: string[] = [];
  const released: string[] = [];
  /** What the failure policy would mark on the issue (#39) — its own seam, one write wide. */
  const labelled: string[] = [];
  const github: GitHub = {
    claim: (repo, issue) => void claimed.push(`${repo}#${issue}`),
    release: (repo, issue) => void released.push(`${repo}#${issue}`),
    // Admission's blocker read (#42). Nothing in this file is about dependencies, so the
    // defaults say "nothing blocks this issue" — native links empty, a body with no
    // `## Blocked by` section — which is the unblocked issue every case here drives.
    blockedBy: async () => [],
    issueState: async () => "closed",
    readIssue: async () => ({ title: "", body: "" }),
    openPrForHead: async () => undefined,
    // The one read a PR summon costs (#44): the head branch admission holds the branch
    // lock on, so a comment run and an issue run cannot be on one branch at once.
    readPr: async () => ({ head: "feat/57", base: "main", state: "open" }),
    // …and a case about dependencies says so, one read at a time.
    ...reads,
  };

  const paths: Paths = {
    resultPath: (key) => resolve(caseDir, "results", `${slug(key)}.json`),
    pidPath: (key) => resolve(caseDir, "running", `${slug(key)}.pid`),
    runLogPath: (fullName, flow) => resolve(caseDir, "log", fullName, flow, "run.log"),
    eventLogPath: resolve(caseDir, "log", "events.jsonl"),
  };

  /** The fork, stood in for: it records the job it was handed and settles only when the
   *  case says the child exited — exactly as the real one settles on the exit, so the
   *  cap and the branch lock hold for the child's whole life. */
  const forked: Job[] = [];
  /** The other lane's children (#44), kept apart so every case above reads the issue lane
   *  exactly as it did — and so a PR job's own shape (no base, no resume) is asserted as
   *  itself rather than through a union. */
  const forkedPr: PrJob[] = [];
  const exits = new Map<string, (exit: ChildExit) => void>();
  const fork: ForkWorkItem = (job) => {
    if ("pr" in job) forkedPr.push(job);
    else forked.push(job);
    // A real child's first act, and it does NOT release on the way out here: a child
    // killed before its own release is the case the parent's clearing exists for.
    acquireLock(job.pidPath, process.pid);
    return new Promise((settle) => exits.set(job.key, settle));
  };

  /** The child finishing: what it left on disk (an outcome, or nothing at all), then the
   *  exit the parent settles on. */
  const finish = async (key: string, outcome: Outcome | undefined, exit: ChildExit = { code: 0, signal: null }) => {
    if (outcome) writeOutcome(paths.resultPath(key), outcome);
    exits.get(key)?.(exit);
    await tick();
  };

  /** What the restack lane was seeded with (#43) — `<repo>#<merged issue>`, in order.
   *  Substituted for the same reason the fork is: the real one force-pushes branches. */
  const restacked: string[] = [];

  const logger = new Logger(dests);
  const state = new StateStore(resolve(caseDir, "state.json"));
  /** The durable halt, so a case can assert that a work item's own failure did NOT stop
   *  the pipeline (#38): a precondition is one item's condition, and the file is what a
   *  restart would read back as "everything is held". */
  const pause = new PauseStore(resolve(caseDir, "pause.json"));
  const scheduler = createScheduler(2, logger.child("scheduler"));
  const assignor = new Assignor({
    repos: TABLE,
    github,
    log: logger.child("assignor"),
    scheduler,
    state,
    fork,
    paths,
    restack: async (repo, issue) => {
      restacked.push(`${repo}#${issue}`);
      // The real one reaches GitHub and git, so it really can reject.
      if (restackError) throw new Error(restackError);
    },
    // The real policy, over this case's own pause file and state: what it DOES about each
    // scope is `test/smoke-failure.mts`'s subject, and what matters here is that no case in
    // this file reaches the real `var/pause.json` or writes a label to a real repo.
    failure: new FailurePolicy({
      pause,
      scheduler,
      state,
      github: {
        addLabels: async (repo, issue, names) => void labelled.push(`${repo}#${issue} +${names.join(",")}`),
        // The PR lane's label write (#44): a DIFFERENT `gh` call, and recorded as its own
        // spelling — `gh issue edit` against a pull request's number marks whatever issue
        // happens to share it.
        labelPr: async (repo, pr, names) => void labelled.push(`${repo}#pr${pr} +${names.join(",")}`),
      },
      log: logger.child("failure"),
    }),
  });

  return { assignor, state, pause, lines, comments, claimed, released, labelled, forked, forkedPr, restacked, finish, paths };
}

/** The work item every case below is about, and the run that gated on it. */
const KEY = "acme/finance#57";
/** …and the PR-comment run on the pull request that happens to share its number (#44). */
const PR_KEY = "acme/finance#pr57";
const QUESTION = "Which of the two auth flows should this use?";
const SESSION = "9f3c1a7e-2b40-4d61-8c55-0e1d2f3a4b5c";
/** The commit a child says it created its branch at (#42). */
const FORK_POINT = "9c1f0b2e4d6a8c0e2f4a6b8d0c2e4f6a8b0d2c4e";
/** How big the gated session had grown by the time it asked (#67) — what the resume
 *  decides whether to continue or to hand off with. */
const CONTEXT_TOKENS = 143_500;

/** Take the item all the way to a gate — forked, gated, its claim back off. That is the
 *  state a human's reply arrives into, and it is reached through the real path so no case
 *  below is driven from a state the pipeline could not actually produce. */
async function gate(h: ReturnType<typeof harness>, sessionId?: string): Promise<void> {
  h.assignor.handle(delivery());
  await tick();
  await h.finish(KEY, {
    key: KEY,
    status: "awaiting-human",
    summary: QUESTION,
    finishedAt: "2026-07-25T00:00:00.000Z",
    contextTokens: CONTEXT_TOKENS,
    ...(sessionId ? { sessionId } : {}),
  });
}

/** `lib/paths.mts`'s own key-to-segment rule, so the harness names files the way the
 *  real layout would. */
function slug(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, "-");
}

/** Did the Assignor say anything at all about this delivery? Constraint 10: a work item
 *  dropped with no line anywhere is the defect class this rewrite exists to kill. */
const said = (lines: LogLine[], text: string) => lines.some((l) => l.message.includes(text));

// ── admission: is this issue Sunday's to work? Pure, and its ORDER is load-bearing —
//    a claimed issue and a spec are rejected BEFORE the trigger labels are even looked
//    at, so a mis-labelled spec is never admitted (and, in #35, relabelled and run) ──
{
  ok(
    "admit: an issue in a routed repo carrying all of its trigger labels",
    admitIssue("acme/finance", ["sunday", "ready-for-agent"], TABLE).admit,
    JSON.stringify(admitIssue("acme/finance", ["sunday", "ready-for-agent"], TABLE)),
  );

  const missing = admitIssue("acme/finance", ["sunday"], TABLE);
  ok(
    "reject: one trigger label short — ALL of them are required, and the reason names it",
    !missing.admit && missing.reason.includes("ready-for-agent"),
    JSON.stringify(missing),
  );

  const claimed = admitIssue("acme/finance", ["sunday", "ready-for-agent", "agent-working"], TABLE);
  ok(
    "reject: already claimed — the claim is the durable guard, so it outranks the labels",
    !claimed.admit && claimed.reason.includes("agent-working"),
    JSON.stringify(claimed),
  );

  const agentFailed = admitIssue("acme/finance", ["sunday", "ready-for-agent", "agent-failed"], TABLE);
  ok(
    "reject: the agent's OWN verdict — a run that already happened is nobody's to re-run, and the reason names the label a human takes off",
    !agentFailed.admit && agentFailed.reason.includes("agent-failed"),
    JSON.stringify(agentFailed),
  );

  const spec = admitIssue("acme/finance", ["sunday", "ready-for-agent", "spec"], TABLE);
  ok(
    "reject: a spec is a manifest, whatever else is on it — checked BEFORE the triggers",
    !spec.admit && spec.reason.includes("spec"),
    JSON.stringify(spec),
  );

  const unrouted = admitIssue("acme/unknown", ["sunday", "ready-for-agent"], TABLE);
  ok(
    "reject: a repo Sunday does not route is not Sunday's work",
    !unrouted.admit && unrouted.reason.includes("acme/unknown"),
    JSON.stringify(unrouted),
  );
}

// ── the work-item key, both ways round (#44). A comment run on PR 57 and an issue run on
//    issue 57 are DIFFERENT work items: they share a number and nothing else, and a key
//    that conflated them would share a state entry, a PID lock and a result file ──
{
  const pr = parseWorkItemKey("acme/finance#pr57", TABLE);
  ok(
    "key: `#pr<n>` round trips as a pull-request item, carrying the number the PR lane runs on",
    pr?.key === "acme/finance#pr57" && pr.repo === "acme/finance" && pr.issue === 57 && pr.kind === "pr",
    JSON.stringify(pr),
  );

  const issue = parseWorkItemKey("acme/finance#57", TABLE);
  ok(
    "key: `#<n>` still round trips, and says which lane it is — the kind is what settling reads to know whether a claim was ever taken",
    issue?.key === "acme/finance#57" && issue.issue === 57 && issue.kind === "issue",
    JSON.stringify(issue),
  );

  ok(
    "key: a `#pr` with no number behind it is not a work item — it would name a path segment and a pull request Sunday writes to",
    parseWorkItemKey("acme/finance#pr", TABLE) === undefined &&
      parseWorkItemKey("acme/finance#pr0", TABLE) === undefined &&
      parseWorkItemKey("acme/finance#pr057", TABLE) === undefined,
    JSON.stringify([parseWorkItemKey("acme/finance#pr", TABLE), parseWorkItemKey("acme/finance#pr057", TABLE)]),
  );
}

try {
  // ── routing: the spine acts on an issue labelled and a comment created. Everything
  //    else — the ones #42/#43/#44 fill in and the ones nothing will ever want — is
  //    RECORDED and does nothing. A delivery that vanishes with no line anywhere is the
  //    defect this rewrite exists to kill (constraint 10) ──
  {
    const h = harness();
    h.assignor.handle(delivery({ event: "issue_comment", action: "deleted" }));
    h.assignor.handle(delivery({ event: "pull_request", action: "closed" }));
    h.assignor.handle(delivery({ event: "pull_request_review_comment", action: "created" }));
    h.assignor.handle(delivery({ event: "push", action: "" }));
    h.assignor.handle(delivery({ action: "unlabeled" })); // an `issues` action we must NOT admit on
    await tick();

    ok("route: nothing the spine does not handle is forked", h.forked.length === 0, JSON.stringify(h.forked.map((j) => j.key)));
    ok("route: nor claimed — an unhandled delivery leaves the issue exactly as it was", h.claimed.length === 0, h.claimed.join(","));
    for (const event of ["issue_comment", "pull_request", "pull_request_review_comment", "push"]) {
      ok(`route: the ${event} delivery is accounted for by a line`, said(h.lines, event), JSON.stringify(h.lines.map((l) => l.message)));
    }
    ok(
      "route: `unlabeled` is not admitted — it fires when WE take the claim off, and admitting on it re-runs a finished issue",
      said(h.lines, "issues.unlabeled"),
      JSON.stringify(h.lines.map((l) => l.message)),
    );
    ok("route: nothing unhandled is worth a comment on the issue", h.comments.length === 0, JSON.stringify(h.comments));
  }

  // ── the admitted path: claim it, record it, fork it — ONCE. GitHub redelivers, humans
  //    re-label, and both lanes of the guard have to hold: the queue's own dedup while
  //    it is in-flight, and durable state across the restart the queue does not survive ──
  {
    const h = harness();
    h.assignor.handle(delivery());
    await tick();
    h.assignor.handle(delivery()); // the same label landing again
    await tick();

    ok("admit: the issue is claimed, which is what tells the NEXT delivery it is taken", h.claimed.join(",") === "acme/finance#57", h.claimed.join(","));
    ok("admit: claimed once, not once per delivery", h.claimed.length === 1, h.claimed.join(","));
    ok("admit: forked exactly once", h.forked.length === 1, JSON.stringify(h.forked.map((j) => j.key)));
    ok("admit: recorded in-flight, so a parent that comes back up knows someone is on it", h.state.get("acme/finance#57")?.status === "in-flight", JSON.stringify(h.state.get("acme/finance#57")));

    const job = h.forked[0];
    ok(
      "fork: the job names the work item and the routed repo, never the raw payload's spelling",
      job?.key === "acme/finance#57" && job.repo === "acme/finance" && job.issue === 57,
      JSON.stringify(job),
    );
    ok(
      "fork: and the base the Assignor chose for it — an issue nothing blocks runs on main",
      job?.base === "main",
      JSON.stringify(job?.base),
    );
    ok(
      "fork: it carries how the repo is run, resolved from the table the delivery routed against",
      job?.config.imageName === "sunday-finance",
      JSON.stringify(job?.config),
    );
    ok(
      "fork: and every path the child writes, resolved by the PARENT (the child derives none)",
      job?.resultPath === h.paths.resultPath("acme/finance#57") &&
        job.pidPath === h.paths.pidPath("acme/finance#57") &&
        job.runLogPath === h.paths.runLogPath("acme/finance", "57") &&
        job.eventLogPath === h.paths.eventLogPath,
      JSON.stringify(job),
    );

    ok("milestone: starting the work is worth telling the humans watching the issue", h.comments.length === 1, JSON.stringify(h.comments.map((l) => l.message)));
    ok(
      "milestone: addressed at the issue it is about, or it would reach nobody",
      h.comments[0]?.level === "milestone" && h.comments[0].context.repo === "acme/finance" && h.comments[0].context.target === 57,
      JSON.stringify(h.comments[0]),
    );
  }

  // ── two deliveries for one issue can now BOTH cross admission's blocker read, which
  //    is an `await` where there was none (#42 constraint 13). Nothing new guards it: the
  //    scheduler's key dedup is what makes it one run, and the second claim is the same
  //    label applied to the same issue twice ──
  {
    const h = harness();
    h.assignor.handle(delivery());
    h.assignor.handle(delivery()); // in the same tick, before the first can claim
    await tick();

    ok("race: one child for the item, whichever delivery got there first", h.forked.length === 1, JSON.stringify(h.forked.map((j) => j.key)));
    ok("race: and one work item recorded, not two", h.state.get(KEY)?.status === "in-flight", JSON.stringify(h.state.get(KEY)));
  }

  // ── #42: an issue whose blocker has not landed is admitted in principle and HELD.
  //    Deferred is not a durable status (constraint 6): a claim says a run is on it, and
  //    a state entry the machine does not know would make the prior-state guard skip the
  //    item forever. GitHub is the truth, and reconcile rebuilds the map ──
  {
    const h = harness({ blockedBy: async () => [{ number: 9, state: "open" }] });
    h.assignor.handle(delivery());
    await tick();

    ok("defer: no child is forked for an issue whose blocker is still open", h.forked.length === 0, JSON.stringify(h.forked.map((j) => j.key)));
    ok("defer: the issue is not claimed — `agent-working` means a run is on it, and none is", h.claimed.length === 0, h.claimed.join(","));
    ok("defer: nothing durable is written, so the item stays admissible", h.state.get(KEY) === undefined, JSON.stringify(h.state.get(KEY)));
    ok("defer: the reason names the blocker being waited on", said(h.lines, "#9"), JSON.stringify(h.lines.map((l) => l.message)));
    ok("defer: and it costs the issue no comment — a deferred item has not started", h.comments.length === 0, JSON.stringify(h.comments.map((l) => l.message)));
  }

  // ── …and the other half: a blocker with a PR already open has a branch worth forking
  //    from, so the dependent starts NOW, stacked on it (ADR-0003 — human review latency
  //    stays off the critical path). The Assignor decides the base; the child never
  //    recomputes it (constraint 8), so it travels in the job ──
  {
    const h = harness({
      blockedBy: async () => [{ number: 9, state: "open" }],
      openPrForHead: async () => "https://github.com/acme/finance/pull/12",
    });
    h.assignor.handle(delivery());
    await tick();

    ok("stack: the item runs rather than waiting for its blocker to merge", h.forked.length === 1, JSON.stringify(h.forked.map((j) => j.key)));
    ok("stack: on the blocker's own branch, which is what the job carries", h.forked[0]?.base === "feat/9", JSON.stringify(h.forked[0]?.base));
    ok("stack: and it is claimed and recorded like any other admitted item", h.claimed.join(",") === KEY && h.state.get(KEY)?.status === "in-flight", h.claimed.join(","));
  }

  // ── …and a stacked item that GATES has to come back onto the same base. The branch is
  //    already there, so a resume decides nothing — but the PR it finally opens targets
  //    the base the job names, and `main` there would ship the blocker's commits as this
  //    item's own. The base rides durable state exactly as the session handle does,
  //    because the human may answer weeks and one restart later ──
  {
    const h = harness({
      blockedBy: async () => [{ number: 9, state: "open" }],
      openPrForHead: async () => "https://github.com/acme/finance/pull/12",
    });
    h.assignor.handle(delivery());
    await tick();
    await h.finish(KEY, { key: KEY, status: "awaiting-human", summary: QUESTION, finishedAt: "2026-07-25T00:00:00.000Z", sessionId: SESSION });

    h.assignor.handle(reply("Use the OAuth flow — the SAML one is being retired."));
    await tick();

    ok("stacked resume: the run picks up where it left off", h.forked.length === 2 && h.forked[1]?.resume?.sessionId === SESSION, JSON.stringify(h.forked.map((j) => j.resume)));
    ok("stacked resume: on the base the item was admitted on, not on main", h.forked[1]?.base === "feat/9", JSON.stringify(h.forked[1]?.base));
  }

  // ── a blocker read that FAILED is the defect this issue exists to kill: v1 swallowed
  //    it into an empty list, which reads as "nothing blocks this" and starts a real
  //    agent run on main. It defers instead — and loudly, because only an operator can
  //    do anything about somebody else's 502 (constraint 5) ──
  {
    const h = harness({
      blockedBy: async () => {
        throw new Error("gh: Server Error (HTTP 502)");
      },
    });
    h.assignor.handle(delivery());
    await tick();

    ok("read failure: the issue is not admitted onto main on the strength of a read that never happened", h.forked.length === 0 && h.claimed.length === 0, JSON.stringify(h.forked.map((j) => j.key)));
    const about502 = h.lines.filter((l) => l.message.includes("HTTP 502"));
    ok("read failure: it is an ERROR — a wait nobody can end by working is an operator's problem", about502.some((l) => l.level === "error"), JSON.stringify(about502));
    ok(
      "read failure: addressed at the repo and NOT at the issue, so it reaches the operator and never the thread",
      about502.length > 0 && about502.every((l) => l.context.repo === "acme/finance" && l.context.target === undefined),
      JSON.stringify(about502.map((l) => l.context)),
    );
    ok("read failure: so the issue gets no comment — a deferred item has not started", h.comments.length === 0, JSON.stringify(h.comments.map((l) => l.message)));

    // The same outage, re-read once per PR event in a busy repo.
    for (const number of [12, 13, 14]) {
      h.assignor.handle(delivery({ event: "pull_request", action: "opened", number, labels: [] }));
      await tick();
    }
    ok(
      "read failure: the same reason repeating drops to info — one outage must not page the operator once per event",
      h.lines.filter((l) => l.level === "error").length === 1,
      JSON.stringify(h.lines.filter((l) => l.level === "error").map((l) => l.message)),
    );
    ok("read failure: and it is still being retried, so nothing is lost when the API comes back", h.lines.filter((l) => l.message.includes("HTTP 502")).length === 4, String(about502.length));
  }

  // ── a deferred item is re-evaluated when a blocker's state COULD have changed: its
  //    PR opening is exactly what a dependent with nothing to stack on was waiting for.
  //    Forward edge only — GitHub's `dependencies/blocks` 404s, so nobody can ask "who
  //    does this unblock?"; each deferred item re-asks its own blockers ──
  {
    let prOpen = false;
    const h = harness({
      blockedBy: async () => [{ number: 9, state: "open" }],
      openPrForHead: async () => (prOpen ? "https://github.com/acme/finance/pull/12" : undefined),
    });
    h.assignor.handle(delivery());
    await tick();
    ok("promote: nothing starts while the blocker has no branch to stack on", h.forked.length === 0, JSON.stringify(h.forked.map((j) => j.key)));

    prOpen = true;
    h.assignor.handle(delivery({ event: "pull_request", action: "opened", number: 12, labels: [] }));
    await tick();

    ok("promote: the blocker's PR opening starts the dependent that was waiting on it", h.forked.length === 1, JSON.stringify(h.forked.map((j) => j.key)));
    ok("promote: stacked on the branch that just got its PR", h.forked[0]?.base === "feat/9", JSON.stringify(h.forked[0]?.base));
    ok("promote: and it is claimed now, at the moment it actually starts", h.claimed.join(",") === KEY, h.claimed.join(","));
  }

  // ── the other trigger: the blocker CLOSING. Its work is on main, so the dependent no
  //    longer stacks on anything ──
  {
    let blockerState = "open";
    const h = harness({ blockedBy: async () => [{ number: 9, state: blockerState }] });
    h.assignor.handle(delivery());
    await tick();
    ok("promote: held while the blocker is open with no PR", h.forked.length === 0, JSON.stringify(h.forked.map((j) => j.key)));

    blockerState = "closed";
    h.assignor.handle(delivery({ action: "closed", number: 9, labels: [] }));
    await tick();

    ok("promote: a blocker closing releases the dependent", h.forked.length === 1, JSON.stringify(h.forked.map((j) => j.key)));
    ok("promote: onto main — there is nothing left to stack on", h.forked[0]?.base === "main", JSON.stringify(h.forked[0]?.base));
  }

  // ── a re-evaluation is per REPO: another repo's PR events say nothing about this
  //    repo's dependencies, and re-reading every deferred item on each one spends a rate
  //    limit on a question nobody asked ──
  {
    let prOpen = false;
    const h = harness({
      blockedBy: async () => [{ number: 9, state: "open" }],
      openPrForHead: async () => (prOpen ? "https://github.com/acme/finance/pull/12" : undefined),
    });
    h.assignor.handle(delivery());
    await tick();

    prOpen = true;
    h.assignor.handle(delivery({ event: "pull_request", action: "opened", repo: "acme/other", number: 12, labels: [] }));
    await tick();

    ok("promote: a PR in another repo does not re-evaluate this one's deferred items", h.forked.length === 0, JSON.stringify(h.forked.map((j) => j.key)));
  }

  // ── #43: a blocker MERGING is what moves everything stacked on it. The seed is the
  //    Assignor's only decision about a restack — which repo, and which ISSUE landed —
  //    and the issue is read off the HEAD BRANCH, because the delivery's own number is
  //    the pull request's and a restack aimed at that moves somebody else's branches ──
  {
    const h = harness();
    h.assignor.handle(delivery({ event: "pull_request", action: "closed", number: 61, labels: [], merged: true, head: "feat/9" }));
    await tick();

    ok("merge: the branch that merged seeds the restack lane, named by its ISSUE and not its PR", h.restacked.join(",") === "acme/finance#9", h.restacked.join(","));
    ok("merge: and the deferred items still get their re-evaluation — a merge is also a blocker closing", h.forked.length === 0 && said(h.lines, "pull_request.closed"), JSON.stringify(h.lines.map((l) => l.message)));
  }

  // ── everything that is NOT a merge (AC9). A PR closed unmerged shipped nothing, and a
  //    `synchronize` is a push to a branch that is still open — restacking on either
  //    force-pushes every dependent onto a base that never landed ──
  {
    const h = harness();
    h.assignor.handle(delivery({ event: "pull_request", action: "closed", number: 61, labels: [], merged: false, head: "feat/9" }));
    h.assignor.handle(delivery({ event: "pull_request", action: "opened", number: 62, labels: [], merged: false, head: "feat/9" }));
    h.assignor.handle(delivery({ event: "pull_request", action: "synchronize", number: 63, labels: [], merged: true, head: "feat/9" }));
    await tick();

    ok("merge: a PR closed unmerged moves nothing — nothing landed for anything to stack on", h.restacked.length === 0, h.restacked.join(","));
    ok("merge: nor does a PR opening, or a push to one still open", h.restacked.length === 0, h.restacked.join(","));
  }

  // ── a merged PR whose head is not one of ours. Sunday only ever restacks `feat/<n>`
  //    branches, and a human's `hotfix/…` merging says nothing about what is stacked on
  //    what — there is no issue number in it to key a work item off ──
  {
    const h = harness();
    h.assignor.handle(delivery({ event: "pull_request", action: "closed", number: 61, labels: [], merged: true, head: "hotfix/auth" }));
    h.assignor.handle(delivery({ event: "pull_request", action: "closed", number: 62, labels: [], merged: true }));
    await tick();

    ok("merge: a branch that is not ours seeds nothing", h.restacked.length === 0, h.restacked.join(","));
    ok("merge: and it is still accounted for by a line, like every other delivery", said(h.lines, "pull_request.closed"), JSON.stringify(h.lines.map((l) => l.message)));
  }

  // ── the seed reaches the world (it force-pushes), so it is fired and not awaited — and
  //    a rejection from it must be caught HERE. Unhandled, it takes the parent down with
  //    it (ADR-0001), because `handle` is called synchronously inside the receiver's own
  //    try/catch which cannot see a rejection ──
  {
    const h = harness({}, "gh: HTTP 403");
    h.assignor.handle(delivery({ event: "pull_request", action: "closed", number: 61, labels: [], merged: true, head: "feat/9" }));
    await tick();

    ok(
      "merge: a restack that rejects is caught and recorded here, not left to take the parent down",
      said(h.lines, "gh: HTTP 403") && said(h.lines, "#9"),
      JSON.stringify(h.lines.map((l) => l.message)),
    );
  }

  // ── the work-item key and the paths built from it become FILENAMES, so the number
  //    they are built from has to be one. The repo name is proved by admission (an exact
  //    match against the routing table); nothing else off the wire is trusted ──
  {
    const h = harness();
    h.assignor.handle(delivery({ number: Number.NaN })); // an `issues` payload with no issue in it
    h.assignor.handle(delivery({ number: "57/../../etc" as unknown as number })); // the wire is untyped
    await tick();

    ok("number: a delivery whose number is not one forks nothing", h.forked.length === 0, JSON.stringify(h.forked.map((j) => j.key)));
    ok("number: nor is an issue claimed on the strength of it", h.claimed.length === 0, h.claimed.join(","));
    ok("number: and it is recorded, like every other delivery", said(h.lines, "not an issue number"), JSON.stringify(h.lines.map((l) => l.message)));
  }

  // ── the cross-restart guard the in-memory queue cannot be. This parent has never seen
  //    the item — its queue is empty and its state file says nothing — but a child from
  //    the parent that died is still working it (ADR-0001). Only the lock on disk knows ──
  {
    const h = harness();
    acquireLock(h.paths.pidPath("acme/finance#57"), process.pid); // a live holder
    h.assignor.handle(delivery());
    await tick();

    ok("lock: a live holder suppresses the fork the empty queue would have allowed", h.forked.length === 0, JSON.stringify(h.forked.map((j) => j.key)));
    ok("lock: and the claim, which is already on the issue from the run in progress", h.claimed.length === 0, h.claimed.join(","));
    ok("lock: the item's state is left to the process that owns it", h.state.get("acme/finance#57") === undefined, JSON.stringify(h.state.get("acme/finance#57")));
    ok("lock: the reason names the process holding it", said(h.lines, `pid ${process.pid}`), JSON.stringify(h.lines.map((l) => l.message)));
  }

  // ── the other half: a lock is not a wedge. A child killed before it could release
  //    leaves the file behind, and an item whose holder is GONE has to be startable
  //    again or it is stuck until a human deletes a file ──
  {
    const h = harness();
    const corpse = spawnSync(process.execPath, ["-e", ""]); // a pid that has certainly exited
    acquireLock(h.paths.pidPath("acme/finance#57"), corpse.pid!);
    h.assignor.handle(delivery());
    await tick();

    ok("lock: a stale lock from a dead child does not wedge the item", h.forked.length === 1, JSON.stringify(h.lines.map((l) => l.message)));
  }

  // ── applying the outcome, FROM THE FILE the child left (constraint 4) — never from
  //    what it said over IPC. #35's boot sweep applies through this same path, which is
  //    what stops the live and recovery paths drifting the way v1's did ──
  {
    const key = "acme/finance#57";
    const h = harness();
    h.assignor.handle(delivery());
    await tick();
    const started = h.comments.length;
    await h.finish(key, {
      key,
      status: "done",
      summary: "spine only — no agent ran",
      finishedAt: "2026-07-25T00:00:00.000Z",
    });

    ok("apply: durable state records how the item finished", h.state.get(key)?.status === "done", JSON.stringify(h.state.get(key)));
    ok("apply: exactly one comment for the outcome", h.comments.length - started === 1, JSON.stringify(h.comments.map((l) => l.message)));

    const applied = h.comments.at(-1);
    ok(
      "apply: it is a milestone on the issue it is about, carrying what the CHILD said it did",
      applied?.level === "milestone" && applied.context.repo === "acme/finance" && applied.context.target === 57 && applied.message.includes("spine only — no agent ran"),
      JSON.stringify(applied),
    );
    ok(
      "apply: the comment goes out marked, so Sunday cannot read it back as a summon",
      applied !== undefined && commentBody(applied).includes(SUNDAY_MARKER),
      applied && commentBody(applied),
    );
    ok("apply: the result file is cleared — its presence is what stops a second apply", !existsSync(h.paths.resultPath(key)), h.paths.resultPath(key));
    ok("apply: the lock is cleared, whether or not the child got to release it itself", readLock(h.paths.pidPath(key)) === undefined, JSON.stringify(readLock(h.paths.pidPath(key))));
    ok("apply: the claim comes off LAST, so nothing reads the issue as free while it is not", h.released.join(",") === key, h.released.join(","));
    ok(
      "milestone: exactly two per work item — started and finished. A third is thread spam",
      h.comments.length === 2,
      JSON.stringify(h.comments.map((l) => l.message)),
    );
  }

  // ── the fork point (#42): the commit the child created its branch at, reported on the
  //    outcome and kept in durable state. It is what #43 rebases a dependent's own
  //    commits off, and it has to survive everything that happens between the two —
  //    including a gate that is answered weeks and one restart later (ADR-0003) ──
  {
    const h = harness();
    h.assignor.handle(delivery());
    await tick();
    await h.finish(KEY, {
      key: KEY,
      status: "awaiting-human",
      summary: QUESTION,
      finishedAt: "2026-07-25T00:00:00.000Z",
      sessionId: SESSION,
      forkPoint: FORK_POINT,
    });

    ok("fork point: what the child reported is what the parent records", h.state.get(KEY)?.forkPoint === FORK_POINT, JSON.stringify(h.state.get(KEY)));

    h.assignor.handle(reply("Use the OAuth flow — the SAML one is being retired."));
    await tick();
    ok(
      "fork point: a resume keeps it — the whole record is replaced, and the branch being resumed is still the one that forked there",
      h.state.get(KEY)?.forkPoint === FORK_POINT,
      JSON.stringify(h.state.get(KEY)),
    );

    // A resumed child that dies leaves no outcome AT ALL, and a resume forks from
    // nothing — so there is no second fork point to record and the first one stands.
    // Through the failure AND through the retry the policy starts on it (#39): both
    // replace the whole record, so both have to carry it.
    await h.finish(KEY, undefined, { code: 1, signal: null });
    ok(
      "fork point: a resumed child that leaves no outcome does not erase it",
      h.state.get(KEY)?.forkPoint === FORK_POINT,
      JSON.stringify(h.state.get(KEY)),
    );

    // …but a FRESH run is a new branch, created wherever the base is now. Yesterday's
    // fork point is not where, and a restack aimed at it would replay commits that are
    // already in this branch's ancestry. (The retry has to end first — its own failure is
    // the agent's OWN verdict, which is nobody's to retry again, so the item settles at
    // `failed` and a human re-labelling it is what starts the next attempt.)
    await tick();
    await tick();
    await h.finish(KEY, {
      key: KEY,
      status: "failed",
      summary: "I could not make this work.",
      finishedAt: "2026-07-25T00:00:00.000Z",
      agentFailed: true,
    });
    h.assignor.handle(delivery());
    await tick();
    ok(
      "fork point: a fresh re-admission clears it — the run that starts now has not created its branch yet",
      h.state.get(KEY)?.status === "in-flight" && h.state.get(KEY)?.forkPoint === undefined,
      JSON.stringify(h.state.get(KEY)),
    );
  }

  // ── the durable failure state (#39): the one retry an unrecognised failure gets, and
  //    the quarantine it lands in when that retry fails too. Both live in the state file
  //    (constraint 7) — an in-memory retry flag hands every restart a fresh agent run on
  //    real quota, and a quarantine that reads as `failed` is re-admitted by the next
  //    reconcile, which is the loop this issue exists to stop ──
  {
    const h = harness();
    h.assignor.handle(delivery());
    await tick();
    // What #39's policy leaves behind when it spends the retry: the flag written durably,
    // and the item restarted carrying it.
    h.state.set(KEY, { ...h.state.get(KEY)!, retried: true });
    await h.finish(KEY, { key: KEY, status: "failed", summary: "boom", finishedAt: "2026-07-25T00:00:00.000Z" });

    ok(
      "retry budget: applying the second failure keeps the retry SPENT — `set` replaces the whole record, and dropping it here is a run that retries forever",
      h.state.get(KEY)?.retried === true,
      JSON.stringify(h.state.get(KEY)),
    );

    h.assignor.handle(delivery()); // the label is still on, and the quarantine label is not
    await tick();
    ok(
      "retry budget: a fresh admission drops it — an item started again has its retry back, or it quarantines on its first failure ever",
      h.state.get(KEY)?.status === "in-flight" && h.state.get(KEY)?.retried === undefined,
      JSON.stringify(h.state.get(KEY)),
    );

    // …and quarantine is where that ladder ends: a state DISTINCT from `failed`, because a
    // failed item is exactly what admission and reconcile pick back up. What lifts it is
    // the LABEL coming off — the one signal both a live `labeled` delivery and a reconcile
    // carry, since each hands admission the issue's current labels.
    // A second item, so the guards below are driven on a work item with no child of its
    // own on it — what is being tested is admission, not the PID lock beneath it.
    const other = "acme/finance#58";
    const before = h.forked.length;
    h.state.set(other, { status: "quarantined", retried: true });
    h.assignor.handle(delivery({ number: 58, labels: ["sunday", "ready-for-agent", "quarantined"] }));
    await tick();

    ok(
      "quarantine: a quarantined item wearing the label is NOT re-admitted, where the same delivery re-admits a failed one",
      h.forked.length === before && h.state.get(other)?.status === "quarantined",
      `${h.forked.length} forks, state ${JSON.stringify(h.state.get(other))}`,
    );
    ok("quarantine: and the skip says so, naming the label a human takes off to end it", said(h.lines, "state=quarantined") && said(h.lines, "quarantined` label"), JSON.stringify(h.lines.map((l) => l.message)));

    h.assignor.handle(delivery({ number: 58 })); // the human took the label off and re-labelled it
    await tick();
    ok(
      "release: the label gone, the item is admitted like any other — with its retry budget back",
      h.forked.length === before + 1 && h.state.get(other)?.status === "in-flight" && h.state.get(other)?.retried === undefined,
      `${h.forked.length} forks, state ${JSON.stringify(h.state.get(other))}`,
    );

    // …and the OTHER park-until-a-human state (#68): it settles at plain `failed`, so the
    // label is the only record. The delivery is the sharp one — `labeled` is in
    // `ADMIT_ACTIONS`, so Sunday's own `agent-failed` write fires it. The claim says
    // "admitted" here rather than the fork count: it is taken before the queue.
    const failed = "acme/finance#59";
    h.state.set(failed, { status: "failed" });
    h.assignor.handle(delivery({ number: 59, labels: ["sunday", "ready-for-agent", "agent-failed"] }));
    await tick();

    ok(
      "agent-failed: the label refuses the item, where the same delivery without it re-admits a failed one",
      !h.claimed.includes(failed) && h.state.get(failed)?.status === "failed",
      `claimed=${h.claimed.join(",")}, state ${JSON.stringify(h.state.get(failed))}`,
    );
    ok(
      "agent-failed: and the skip names the label and the hand-back, since nothing but a human ever moves it again",
      said(h.lines, "agent-failed") && said(h.lines, "hand it back"),
      JSON.stringify(h.lines.map((l) => l.message)),
    );

    h.assignor.handle(delivery({ number: 59 })); // the human took the label off and re-labelled it
    await tick();
    ok(
      "agent-failed: the label gone, the item is handed back through the ordinary admission — nothing removes it but a human",
      h.claimed.includes(failed) && h.state.get(failed)?.status === "in-flight",
      `claimed=${h.claimed.join(",")}, state ${JSON.stringify(h.state.get(failed))}`,
    );
  }

  // ── the retry (#39): a failed item the policy decides is worth one more run is started
  //    through the Assignor's own claim-and-enqueue, not around it. A restart that skipped
  //    the claim would leave an issue that reads as free while an agent is on it ──
  {
    const h = harness();
    h.assignor.handle(delivery());
    await tick();
    await h.finish(KEY, { key: KEY, status: "failed", summary: "something entirely unexpected", finishedAt: "2026-07-25T00:00:00.000Z" });
    // The enqueue is deferred by a turn: the apply runs INSIDE the run the scheduler still
    // counts as in-flight, and an enqueue there is deduped away as "already queued".
    await tick();
    await tick();

    ok("retry: the item is forked a second time", h.forked.length === 2, JSON.stringify(h.forked.map((j) => j.key)));
    ok(
      "retry: claimed exactly as an admission claims — `settle` handed the claim back, and an unclaimed retry reads as a free issue",
      h.claimed.join(",") === `${KEY},${KEY}`,
      h.claimed.join(","),
    );
    ok("retry: and recorded in-flight, so a parent that comes back up knows someone is on it", h.state.get(KEY)?.status === "in-flight", JSON.stringify(h.state.get(KEY)));
    ok(
      "retry: the job is the same shape an admission builds — same config, same paths, on the base the item was admitted on",
      h.forked[1]?.base === "main" && h.forked[1]?.config.imageName === "sunday-finance" && h.forked[1]?.resultPath === h.paths.resultPath(KEY),
      JSON.stringify(h.forked[1]),
    );
  }

  // ── the preconditions (#38): a run that refused to start. The reason is TYPED on the
  //    outcome and the parent reacts to THAT, never to the summary beside it — that text
  //    is prose Sunday composed, so the classifier reads it as nothing at all and an issue
  //    whose trigger label a human simply pulled would be run again on real quota and then
  //    set aside. The child says how the item ENDED (constraint 7); what the parent adds
  //    is the reaction ──
  {
    /** The four the parent handles by NOT handling: their condition is a fact about the
     *  issue, and nothing about it changes by running the item again. Worded as
     *  `issue/preconditions.mts` words them, so the classifier is asked the real question. */
    const stops = [
      { reason: "issue-closed", status: "failed", says: "the run did not start: the issue is no longer open — state: closed." },
      {
        reason: "labels-missing",
        status: "failed",
        says: "the run did not start: the trigger label(s) it was admitted on are no longer on the issue — missing: ready-for-agent.",
      },
      {
        reason: "pull-request-open",
        status: "done",
        says: "the run did not start: a pull request for this issue's branch is already open — https://github.com/acme/finance/pull/12.",
      },
      { reason: "base-missing", status: "failed", says: "the base branch is gone from the origin — main, and nothing was started." },
    ] as const;

    for (const { reason, status, says } of stops) {
      const h = harness();
      h.assignor.handle(delivery());
      await tick();
      const started = h.comments.length;
      await h.finish(KEY, { key: KEY, status, summary: says, finishedAt: "2026-07-25T00:00:00.000Z", precondition: reason });
      // The policy's retry is deferred by a turn (see the retry case above), so a run that
      // reached the classifier would have been forked again by here.
      await tick();
      await tick();

      ok(`precondition: ${reason} is recorded exactly as the CHILD reported it`, h.state.get(KEY)?.status === status, JSON.stringify(h.state.get(KEY)));
      ok(
        `precondition: ${reason} is prose the classifier recognises as nothing — which is WHY the parent routes on the typed reason`,
        classify(says).class === "unknown",
        JSON.stringify(classify(says)),
      );
      ok(
        `precondition: ${reason} is not run again — the condition it refused on does not change by spending an agent on it`,
        h.forked.length === 1,
        JSON.stringify(h.forked.map((j) => j.key)),
      );
      ok(`precondition: ${reason} marks nothing on the issue — neither the agent nor the item is at fault`, h.labelled.length === 0, h.labelled.join(","));
      ok(`precondition: ${reason} holds nothing — one item's condition is not the pipeline's`, h.pause.read() === undefined, JSON.stringify(h.pause.read()));
      ok(
        `precondition: ${reason} settles the item like any other finish — the claim back off, the result file and the lock gone`,
        h.released.join(",") === KEY && !existsSync(h.paths.resultPath(KEY)) && readLock(h.paths.pidPath(KEY)) === undefined,
        `released ${h.released.join(",")}`,
      );
      ok(`precondition: ${reason} costs the issue exactly one comment, like any other finish`, h.comments.length - started === 1, JSON.stringify(h.comments.map((l) => l.message)));
    }
  }

  // ── …and the ONE reason that IS handed to the policy (constraint 6): a missing image is
  //    not this item's condition, it is the repo's environment. It goes over as the `setup`
  //    CLASS — never as a wording chosen so a regex matches it — which is the repo stop the
  //    policy already has. Without the hand-over, every item in that repo forks and stops
  //    on the same missing image, one at a time, until somebody notices ──
  {
    const h = harness();
    h.assignor.handle(delivery());
    await tick();
    await h.finish(KEY, {
      key: KEY,
      status: "failed",
      summary: "the run did not start: this repo's sandbox image is not on this host — sunday-finance.",
      finishedAt: "2026-07-25T00:00:00.000Z",
      precondition: "image-missing",
    });
    await tick();
    await tick();

    ok(
      "image-missing: the item is recorded failed and set aside for nothing — it is the repo that is broken, not the issue",
      h.state.get(KEY)?.status === "failed" && h.labelled.length === 0,
      `${JSON.stringify(h.state.get(KEY))} labelled ${h.labelled.join(",")}`,
    );
    ok("image-missing: and it is not started again into the image that is still missing", h.forked.length === 1, JSON.stringify(h.forked.map((j) => j.key)));

    h.assignor.handle(delivery({ number: 58 })); // the next issue in the same repo
    await tick();
    ok(
      "image-missing: the REPO is stopped, so the next item in it is not forked to find the same thing out",
      h.forked.length === 1 && h.claimed.length === 1,
      `forked ${JSON.stringify(h.forked.map((j) => j.key))} claimed ${h.claimed.join(",")}`,
    );
    ok(
      "image-missing: and the skip says what is broken, rather than reading as an issue nobody would run",
      said(h.lines, "is stopped until its sandbox image builds again"),
      JSON.stringify(h.lines.map((l) => l.message)),
    );
    ok("image-missing: one repo's environment holds that repo and NOT the pipeline (ADR-0002)", h.pause.read() === undefined, JSON.stringify(h.pause.read()));
  }

  // ── the gate (#36): the agent stopped to ask a human something. Nothing shipped and
  //    nothing failed — the item is the human's now, and their answer resumes the run
  //    that asked. The question rides the SAME outcome milestone every other finish uses,
  //    so a gated item still costs the issue exactly two comments (constraint 12) ──
  {
    const key = "acme/finance#57";
    const question = "Which of the two auth flows should this use?";
    const session = "9f3c1a7e-2b40-4d61-8c55-0e1d2f3a4b5c";
    const h = harness();
    h.assignor.handle(delivery());
    await tick();
    const started = h.comments.length;
    await h.finish(key, {
      key,
      status: "awaiting-human",
      summary: question,
      finishedAt: "2026-07-25T00:00:00.000Z",
      sessionId: session,
      contextTokens: CONTEXT_TOKENS,
    });

    ok("gate: recorded awaiting-human — neither finished nor failed, and not left in-flight", h.state.get(key)?.status === "awaiting-human", JSON.stringify(h.state.get(key)));
    ok(
      "gate: the session handle is kept, so a reply weeks later resumes the run rather than restarting it",
      h.state.get(key)?.sessionId === session,
      JSON.stringify(h.state.get(key)),
    );
    ok(
      "gate: and how big that session had grown (#67) — the handle alone cannot say whether resuming it is affordable",
      h.state.get(key)?.contextTokens === CONTEXT_TOKENS,
      JSON.stringify(h.state.get(key)),
    );
    ok("gate: exactly one comment for the outcome, like any other finish", h.comments.length - started === 1, JSON.stringify(h.comments.map((l) => l.message)));

    const asked = h.comments.at(-1);
    ok(
      "gate: it is a milestone on the issue, carrying the agent's question as the human will read it",
      asked?.level === "milestone" && asked.context.target === 57 && asked.message.includes(question),
      JSON.stringify(asked),
    );
    ok(
      "gate: and it does not read as a failure — nothing went wrong, someone is being asked",
      asked?.message.includes("✗") === false && asked?.message.includes("awaiting-human") === true,
      JSON.stringify(asked?.message),
    );
    ok("gate: the claim comes off, so the human's reply can be taken up as work again", h.released.join(",") === key, h.released.join(","));
    ok("milestone: two per work item, gated or not — started and the question", h.comments.length === 2, JSON.stringify(h.comments.map((l) => l.message)));
  }

  // ── the resume (#36): the human answers, and the run that asked picks up where it left
  //    off. Same claim-enqueue-fork path an admitted issue takes — what differs is that
  //    the job carries the session to continue and the words to continue it with ──
  {
    const answer = "Use the OAuth flow — the SAML one is being retired.";
    const h = harness();
    await gate(h, SESSION);

    h.assignor.handle(reply(answer));
    await tick();

    ok("resume: the reply is taken up as work — a second child for the same item", h.forked.length === 2, JSON.stringify(h.forked.map((j) => j.key)));

    const job = h.forked[1];
    ok(
      "resume: the job carries the session to continue, so an answer weeks later does not restart the work on fresh quota",
      job?.resume?.sessionId === SESSION,
      JSON.stringify(job),
    );
    ok("resume: and what the human actually said, which is the whole content of a resume", job?.resume?.reply === answer, JSON.stringify(job));
    ok(
      "resume: and how big the session it is continuing had grown (#67) — the child cannot measure a session it has not run yet",
      job?.resume?.contextTokens === CONTEXT_TOKENS,
      JSON.stringify(job),
    );
    ok("resume: the issue is claimed again — from here it is Sunday's work, not the human's", h.claimed.join(",") === `${KEY},${KEY}`, h.claimed.join(","));
    ok(
      "resume: recorded in-flight with the session PRESERVED — the whole record is replaced, and a run that dies mid-resume must still be resumable",
      h.state.get(KEY)?.status === "in-flight" && h.state.get(KEY)?.sessionId === SESSION,
      JSON.stringify(h.state.get(KEY)),
    );
    ok(
      "resume: and the context PRESERVED with it — dropped here, a child that dies mid-resume leaves a session nobody can size again",
      h.state.get(KEY)?.contextTokens === CONTEXT_TOKENS,
      JSON.stringify(h.state.get(KEY)),
    );
  }

  // ── Sunday and the human post under the same account, so the login cannot tell their
  //    comments apart — only the marker can (`lib/markers.mts`). And the gate question is
  //    itself a comment Sunday posts on an issue that is already `awaiting-human`: read
  //    back as an answer, every gate would resume itself with its own question ──
  {
    const h = harness();
    await gate(h, SESSION);
    // The gate question EXACTLY as it went out, which is what GitHub delivers back.
    const ours = commentBody(h.comments.at(-1)!);

    h.assignor.handle(reply(ours));
    await tick();

    ok("own comment: Sunday's own question is not an answer to it", h.forked.length === 1, JSON.stringify(h.forked.map((j) => j.resume)));
    ok(
      "own comment: the item is left waiting on the human, and not re-claimed",
      h.state.get(KEY)?.status === "awaiting-human" && h.claimed.length === 1,
      `${JSON.stringify(h.state.get(KEY))} claimed ${h.claimed.join(",")}`,
    );
  }

  // ── a comment on a PULL REQUEST is the PR lane's work, never an issue run's. GitHub
  //    delivers one as an `issue_comment` like any other, so the subject is the only thing
  //    that separates the two flows — and it is decided on the delivery, not on what state
  //    happens to say about a number ──
  {
    const h = harness();
    await gate(h, SESSION);

    h.assignor.handle(reply("@sunday the rebase dropped a commit", { onPullRequest: true }));
    await tick();

    ok("PR comment: it does not resume an issue run", h.forked.length === 1, JSON.stringify(h.forked.map((j) => j.resume)));
    ok("PR comment: the gated issue is left exactly as it was, waiting on the answer it actually asked for", h.state.get(KEY)?.status === "awaiting-human", JSON.stringify(h.state.get(KEY)));
    ok(
      "PR comment: it is the PR lane that runs, under a key of its own — issue 57 and pull request 57 are different work",
      h.forkedPr.length === 1 && h.forkedPr[0]?.key === PR_KEY,
      JSON.stringify(h.forkedPr.map((j) => j.key)),
    );
  }

  // ── #44: a summon on a pull request is a work item of its own. It is keyed `#pr<n>`
  //    (constraint 1) — issue 57's state entry, PID lock, result file and floor dir are
  //    NOT this run's — and it takes no claim (constraint 3): `agent-working` is an issue
  //    label, and reconcile's orphan-claim sweep walks issues only, so one left on a pull
  //    request is a state nothing releases ──
  {
    const h = harness();
    h.assignor.handle(prComment("@sunday the rebase dropped a commit"));
    await tick();

    ok("PR summon: the PR lane is forked once", h.forkedPr.length === 1, JSON.stringify(h.forkedPr.map((j) => j.key)));
    ok("PR summon: and no issue run is started beside it", h.forked.length === 0, JSON.stringify(h.forked.map((j) => j.key)));

    const job = h.forkedPr[0];
    ok(
      "PR summon: the job names the pull request and the routed repo, never the raw payload's spelling",
      job?.key === PR_KEY && job.repo === "acme/finance" && job.pr === 57,
      JSON.stringify(job),
    );
    ok("PR summon: it carries how the repo is run, resolved from the routing table", job?.config.imageName === "sunday-finance", JSON.stringify(job?.config));
    ok(
      "PR summon: and every path the child writes, under the PR's OWN key — sharing issue 57's would share its lock and its result file",
      job?.resultPath === h.paths.resultPath(PR_KEY) &&
        job.pidPath === h.paths.pidPath(PR_KEY) &&
        job.runLogPath === h.paths.runLogPath("acme/finance", "pr-57") &&
        job.eventLogPath === h.paths.eventLogPath,
      JSON.stringify(job),
    );
    ok("PR summon: nothing is claimed — a claim on a pull request is a label nothing takes off", h.claimed.length === 0, h.claimed.join(","));
    ok("PR summon: recorded in-flight under the PR key, so a parent that comes back up knows someone is on it", h.state.get(PR_KEY)?.status === "in-flight", JSON.stringify(h.state.get(PR_KEY)));
    ok("PR summon: and issue 57 is untouched by it", h.state.get(KEY) === undefined, JSON.stringify(h.state.get(KEY)));
    ok(
      "PR summon: the start milestone is addressed at the pull request it is about",
      h.comments.length === 1 && h.comments[0]?.level === "milestone" && h.comments[0].context.target === 57,
      JSON.stringify(h.comments.map((l) => l.message)),
    );
  }

  // ── the two streams are ONE work item. A summon typed in the conversation and one left
  //    inline on a file line arrive on different events, and answering them as two runs
  //    would put two agents in one checkout on one branch — for a pull request that only
  //    ever needed one pass over everything outstanding ──
  {
    const h = harness();
    h.assignor.handle(inlineComment("@sunday this loop is O(n²)"));
    await tick();

    ok(
      "inline summon: a comment on a file line admits under the SAME key the conversation does",
      h.forkedPr.length === 1 && h.forkedPr[0]?.key === PR_KEY,
      JSON.stringify(h.forkedPr.map((j) => j.key)),
    );

    h.assignor.handle(prComment("@sunday and the null check above it"));
    h.assignor.handle(inlineComment("@sunday this one too"));
    await tick();

    ok(
      "inline summon: more summons while the run is in flight start nothing beside it — the run gathers what is outstanding when it starts, and the next reconcile picks up the rest",
      h.forkedPr.length === 1,
      JSON.stringify(h.forkedPr.map((j) => j.key)),
    );
    ok("inline summon: and the skip says what is holding it", said(h.lines, "state=in-flight"), JSON.stringify(h.lines.map((l) => l.message)));
  }

  // ── …and two summons landing in the SAME tick, before either can record anything. Both
  //    cross the read admission makes (an `await` where the issue lane has one too), so
  //    nothing new guards this: the scheduler's key dedup is what makes it one run ──
  {
    const h = harness();
    h.assignor.handle(prComment("@sunday the rebase dropped a commit"));
    h.assignor.handle(inlineComment("@sunday and this loop is O(n²)"));
    await tick();

    ok("race: one child for the pull request, whichever summon got there first", h.forkedPr.length === 1, JSON.stringify(h.forkedPr.map((j) => j.key)));
    ok("race: and one work item recorded, not two", h.state.get(PR_KEY)?.status === "in-flight", JSON.stringify(h.state.get(PR_KEY)));
  }

  // ── Sunday and the human post under the same account, and a reply QUOTES the summon it
  //    answers — so read back by author, or by the `@sunday` in it, every reply summons
  //    another run, forever, each one real quota (constraint 13). The marker is what tells
  //    them apart, and the two milestones a work item posts carry it too ──
  {
    const h = harness();
    h.assignor.handle(prComment(sundayReply("> @sunday the rebase dropped a commit\n\nRestored it in 9c1f0b2.")));
    h.assignor.handle(prComment(sundayComment("✓ done — answered 1 comment(s)")));
    h.assignor.handle(inlineComment(sundayReply("Fixed — @sunday")));
    await tick();

    ok("own comment: Sunday's own reply is not a summon to answer it", h.forkedPr.length === 0, JSON.stringify(h.forkedPr.map((j) => j.key)));
    ok("own comment: nor is the milestone it posts on the same thread", h.state.get(PR_KEY) === undefined, JSON.stringify(h.state.get(PR_KEY)));

    h.assignor.handle(prComment("thanks, looks good to me"));
    await tick();
    ok("own comment: and a human talking to another human is not one either", h.forkedPr.length === 0, JSON.stringify(h.forkedPr.map((j) => j.key)));
    ok(
      "own comment: each of them still leaves a line — a delivery that vanishes is the defect this rewrite exists to kill",
      h.lines.filter((l) => l.message.includes("not a summon")).length === 4,
      JSON.stringify(h.lines.map((l) => l.message)),
    );
  }

  // ── a PR item that FINISHED is admissible again, where an issue item is not: a trigger
  //    label sits on an issue until a human takes it off, but a summon is written fresh
  //    every time — refusing the next one because this pull request was answered last week
  //    is a human's request dropped in silence ──
  {
    const h = harness();
    h.assignor.handle(prComment("@sunday the rebase dropped a commit"));
    await tick();
    await h.finish(PR_KEY, { key: PR_KEY, status: "done", summary: "answered 1 comment(s)", finishedAt: "2026-07-25T00:00:00.000Z" });

    ok("settle: no claim is handed back, because none was ever taken", h.released.length === 0, h.released.join(","));
    ok("settle: the result file is cleared — its presence is what stops a second apply", !existsSync(h.paths.resultPath(PR_KEY)), h.paths.resultPath(PR_KEY));
    ok("settle: and the lock, whether or not the child got to release it itself", readLock(h.paths.pidPath(PR_KEY)) === undefined, JSON.stringify(readLock(h.paths.pidPath(PR_KEY))));
    ok("settle: two milestones on the pull request, started and finished — the same two every work item posts", h.comments.length === 2, JSON.stringify(h.comments.map((l) => l.message)));

    h.assignor.handle(prComment("@sunday one more thing"));
    await tick();
    ok("settle: a later summon on the same pull request runs again", h.forkedPr.length === 2, JSON.stringify(h.forkedPr.map((j) => j.key)));
  }

  // ── the retry and the quarantine on the PR lane (#39). Same ladder, same durable budget
  //    — what differs is which worker runs again and which `gh` call marks the subject:
  //    `gh issue edit` against a pull request's number labels whatever issue shares it ──
  {
    const h = harness();
    h.assignor.handle(prComment("@sunday fix the flaky test"));
    await tick();
    await h.finish(PR_KEY, { key: PR_KEY, status: "failed", summary: "something entirely unexpected", finishedAt: "2026-07-25T00:00:00.000Z" });
    // The policy's retry is deferred by a turn: the apply runs INSIDE the run the scheduler
    // still counts as in-flight, and an enqueue there is deduped away as "already queued".
    await tick();
    await tick();

    ok("retry: it is the PR lane that runs again, never the issue lane", h.forkedPr.length === 2 && h.forked.length === 0, JSON.stringify(h.forkedPr.map((j) => j.key)));
    ok(
      "retry: carrying what the last attempt died on, which is the only thing this run knows that the last one did not",
      h.forkedPr[1]?.retryError?.includes("something entirely unexpected") === true,
      JSON.stringify(h.forkedPr[1]?.retryError),
    );
    ok(
      "retry: on the head branch admission read once — a failure path re-reads nothing, and the branch lock still has to hold",
      h.state.get(PR_KEY)?.head === "feat/57",
      JSON.stringify(h.state.get(PR_KEY)),
    );
    ok("retry: and still no claim, on the way in or the way out", h.claimed.length === 0 && h.released.length === 0, `${h.claimed.join(",")} / ${h.released.join(",")}`);

    await h.finish(PR_KEY, { key: PR_KEY, status: "failed", summary: "something entirely unexpected", finishedAt: "2026-07-25T00:00:00.000Z" });
    await tick();
    await tick();

    ok("quarantine: the retry spent and the same failure again sets the item aside", h.state.get(PR_KEY)?.status === "quarantined", JSON.stringify(h.state.get(PR_KEY)));
    ok(
      "quarantine: marked through `gh pr edit` — the issue that shares the number is somebody else's work",
      h.labelled.join(",") === `${PR_KEY} +quarantined`,
      h.labelled.join(","),
    );
    ok("quarantine: and it is not run a third time", h.forkedPr.length === 2, JSON.stringify(h.forkedPr.map((j) => j.key)));

    h.assignor.handle(prComment("@sunday please try again", { labels: ["quarantined"] }));
    await tick();
    ok(
      "quarantine: a summon while the label is still on it is refused — a human takes the label off to hand it back",
      h.forkedPr.length === 2 && h.state.get(PR_KEY)?.status === "quarantined",
      `${h.forkedPr.length} forks, state ${JSON.stringify(h.state.get(PR_KEY))}`,
    );
    ok("quarantine: and the refusal names the label that ends it", said(h.lines, "quarantined` label"), JSON.stringify(h.lines.map((l) => l.message)));

    h.assignor.handle(prComment("@sunday please try again"));
    await tick();
    ok(
      "release: the label gone, the next summon runs like any other — with its retry budget back",
      h.forkedPr.length === 3 && h.state.get(PR_KEY)?.status === "in-flight" && h.state.get(PR_KEY)?.retried === undefined,
      `${h.forkedPr.length} forks, state ${JSON.stringify(h.state.get(PR_KEY))}`,
    );
  }

  // ── gated with nothing to resume FROM: the outcome carried no session handle. A run
  //    started fresh here would spend a whole new quota re-deciding what the human was
  //    answering, so it is refused — and refused out loud, because a human waiting on a
  //    reply that never comes has no other way to find out why ──
  {
    const h = harness();
    await gate(h); // gated, no session handle

    h.assignor.handle(reply("Use the OAuth flow."));
    await tick();

    ok("no session: nothing is forked — a resume with no session is a restart wearing its name", h.forked.length === 1, JSON.stringify(h.forked.map((j) => j.resume)));
    ok("no session: nor is the issue claimed on the strength of it", h.claimed.length === 1, h.claimed.join(","));
    ok("no session: and the reason is recorded, naming the item it is about", said(h.lines, "no session") && said(h.lines, KEY), JSON.stringify(h.lines.map((l) => l.message)));
  }

  // ── a gated item whose repo has since left the routing table — a human edits
  //    `config/repos.json` between the question and the answer. Every path a resume takes
  //    needs that repo's config (which image, which checkout), so an item Sunday no longer
  //    routes is refused rather than forked with nothing to run against ──
  {
    const h = harness();
    h.state.set("acme/gone#57", { status: "awaiting-human", sessionId: SESSION });

    h.assignor.handle(reply("Use the OAuth flow.", { repo: "acme/gone" }));
    await tick();

    ok("unrouted: a repo Sunday no longer routes forks nothing, whatever its state file still says", h.forked.length === 0, JSON.stringify(h.forked.map((j) => j.key)));
    ok("unrouted: nor is its issue claimed", h.claimed.length === 0, h.claimed.join(","));
    ok("unrouted: and the reason names the table it is missing from", said(h.lines, "config/repos.json"), JSON.stringify(h.lines.map((l) => l.message)));
  }

  // ── a comment on an issue nothing is waiting on, which is what most comments are. An
  //    `@sunday` summon is not served live either (#44 for PRs, and the next boot's
  //    reconcile replays a missed one as labels), so the line has to say what becomes of
  //    it rather than read as a dead end ──
  {
    const h = harness();
    h.assignor.handle(reply("@sunday can you take this one?"));
    await tick();

    ok("no gate: a comment on an issue nothing is waiting on forks nothing", h.forked.length === 0, JSON.stringify(h.forked.map((j) => j.key)));
    ok("no gate: nor claims the issue", h.claimed.length === 0, h.claimed.join(","));
    ok("no gate: and the line says what becomes of a summon, rather than leaving a human to guess", said(h.lines, "reconcile"), JSON.stringify(h.lines.map((l) => l.message)));
  }

  // ── applied once, whoever asks. #35's boot sweep will call this on every result file
  //    it finds, and a parent that died mid-apply re-applies on its next boot — so apply
  //    has to be safe to call again. The FILE is the guard: gone means done ──
  {
    const key = "acme/finance#57";
    const item: WorkItemRef = { key, repo: "acme/finance", issue: 57, kind: "issue" };
    const h = harness();
    h.assignor.handle(delivery());
    await tick();
    await h.finish(key, { key, status: "done", summary: "spine only — no agent ran", finishedAt: "2026-07-25T00:00:00.000Z" });
    const settled = { comments: h.comments.length, released: h.released.length };

    h.assignor.applyOutcome(item);
    ok("re-apply: the second finds no file and comments nothing", h.comments.length === settled.comments, JSON.stringify(h.comments.map((l) => l.message)));
    ok("re-apply: nor does it touch the claim a second time", h.released.length === settled.released, h.released.join(","));
    ok("re-apply: the recorded outcome stands", h.state.get(key)?.status === "done", JSON.stringify(h.state.get(key)));

    h.assignor.handle(delivery()); // the label is still on the issue; GitHub redelivers
    await tick();
    ok("done: a later delivery does not run a finished item again", h.forked.length === 1, JSON.stringify(h.forked.map((j) => j.key)));
  }

  // ── the gate's interrupted apply, which is exactly what #35's boot sweep finds: the
  //    state already says awaiting-human and the result file is STILL there, because the
  //    parent died between the milestone and the clear. Recording it again asks the human
  //    the same question twice and re-arms an item they are already answering ──
  {
    const key = "acme/finance#57";
    const item: WorkItemRef = { key, repo: "acme/finance", issue: 57, kind: "issue" };
    const session = "9f3c1a7e-2b40-4d61-8c55-0e1d2f3a4b5c";
    const gate: Outcome = {
      key,
      status: "awaiting-human",
      summary: "Which of the two auth flows should this use?",
      finishedAt: "2026-07-25T00:00:00.000Z",
      sessionId: session,
    };
    const h = harness();
    h.assignor.handle(delivery());
    await tick();
    await h.finish(key, gate);
    const settled = h.comments.length;

    writeOutcome(h.paths.resultPath(key), gate); // what the killed apply left on disk
    h.assignor.applyOutcome(item);

    ok("interrupted gate: the question is not asked a second time", h.comments.length === settled, JSON.stringify(h.comments.map((l) => l.message)));
    ok("interrupted gate: the file the killed apply left behind is cleared, so nothing keeps finding it", !existsSync(h.paths.resultPath(key)), h.paths.resultPath(key));
    ok(
      "interrupted gate: the recorded gate and the session the reply resumes both stand",
      h.state.get(key)?.status === "awaiting-human" && h.state.get(key)?.sessionId === session,
      JSON.stringify(h.state.get(key)),
    );
  }

  // ── a child that dies is an exit code, not a dead pipeline (constraint 6). It left no
  //    outcome, so there is nothing to apply — but the item must not sit in-flight
  //    holding a claim nobody will ever release ──
  {
    const key = "acme/finance#57";
    const h = harness();
    h.assignor.handle(delivery());
    await tick();
    await h.finish(key, undefined, { code: 3, signal: null }); // exited, wrote nothing

    ok(
      "dead child: the item is not left in-flight with a claim nobody will release — it is recorded, and handed its one retry (#39)",
      h.state.get(key)?.retried === true,
      JSON.stringify(h.state.get(key)),
    );
    ok("dead child: the comment carries the exit code — the only thing known about it", h.comments.at(-1)?.message.includes("3") === true, JSON.stringify(h.comments.at(-1)));
    ok("dead child: the claim is released, so a human re-labelling it can retry", h.released.join(",") === key, h.released.join(","));
    ok("dead child: and the lock it died holding is cleared", readLock(h.paths.pidPath(key)) === undefined, JSON.stringify(readLock(h.paths.pidPath(key))));

    h.assignor.handle(delivery()); // the label is still on the issue; GitHub redelivers
    await tick();
    ok(
      "dead child: the retry is the one run on it — a redelivery while it is in-flight starts nothing beside it",
      h.forked.length === 2,
      JSON.stringify(h.forked.map((j) => j.key)),
    );
  }

  // ── a child killed by a signal has no exit code at all, and "code null" tells a human
  //    nothing. What killed it is the whole content of the report ──
  {
    const key = "acme/finance#57";
    const h = harness();
    h.assignor.handle(delivery());
    await tick();
    await h.finish(key, undefined, { code: null, signal: "SIGKILL" });

    ok("killed child: the comment names the signal, not a null exit code", h.comments.at(-1)?.message.includes("SIGKILL") === true, JSON.stringify(h.comments.at(-1)));
  }

  // ── a child that never STARTED (no node binary, no file descriptors left, EACCES) has
  //    neither a code nor a signal, and "exited with code null" reads as a clean finish.
  //    What stopped it IS the report — and the work item is still one failed item, not a
  //    dead pipeline ──
  {
    const key = "acme/finance#57";
    const h = harness();
    h.assignor.handle(delivery());
    await tick();
    await h.finish(key, undefined, { code: null, signal: null, error: "spawn /nonexistent/node-binary ENOENT" });

    ok(
      "unstarted child: the item is not left in-flight either — recorded, and handed its one retry",
      h.state.get(key)?.retried === true,
      JSON.stringify(h.state.get(key)),
    );
    ok(
      "unstarted child: the comment carries what stopped it, and claims no exit code it never had",
      h.comments.at(-1)?.message.includes("ENOENT") === true && h.comments.at(-1)?.message.includes("null") === false,
      JSON.stringify(h.comments.at(-1)),
    );
    ok("unstarted child: the claim is released, so a human re-labelling it can retry", h.released.join(",") === key, h.released.join(","));
  }

  // ── the cap counts CHILDREN, not fork calls: a work item occupies its slot until the
  //    process exits, which is the whole reason the Assignor hands the scheduler a run
  //    that settles on the exit rather than on the fork ──
  {
    const h = harness(); // cap 2
    for (const number of [57, 58, 59]) h.assignor.handle(delivery({ number }));
    await tick();
    ok("cap: only two of three admitted items have a child, and all three are claimed", h.forked.length === 2 && h.claimed.length === 3, `forked ${JSON.stringify(h.forked.map((j) => j.key))} claimed ${h.claimed.join(",")}`);

    await h.finish("acme/finance#57", { key: "acme/finance#57", status: "done", summary: "spine only — no agent ran", finishedAt: "2026-07-25T00:00:00.000Z" });
    ok("cap: the third starts only once a child has actually exited", h.forked.length === 3, JSON.stringify(h.forked.map((j) => j.key)));
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
