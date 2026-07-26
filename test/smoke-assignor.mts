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
  type ChildExit,
  type Delivery,
  type ForkWorkItem,
  type Paths,
} from "../assignor/index.mts";
import { createScheduler } from "../assignor/scheduler.mts";
import { StateStore } from "../assignor/state.mts";
import type { Job } from "../issue/run.mts";
import { acquireLock, readLock } from "../lib/lock.mts";
import { SUNDAY_MARKER } from "../lib/markers.mts";
import { writeOutcome, type Outcome } from "../lib/outcome.mts";
import { commentBody } from "../services/destinations.mts";
import type { GitHub } from "../services/github/index.mts";
import { Logger, type Destinations, type LogLine } from "../services/logger.mts";

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
    ...over,
  };
}

/** A human's comment on the issue, as the receiver hands one over. */
function reply(body: string, over: Partial<Delivery> = {}): Delivery {
  return delivery({ event: "issue_comment", action: "created", comment: body, ...over });
}

/** A real Assignor over the real scheduler, state store and Logger, with the two things
 *  that reach the world substituted: GitHub (every method is a real write to a real
 *  repo) and the fork (a child process). Every path it uses points into this case's own
 *  dir, so the real `var/` is never touched. */
function harness() {
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
  const github: GitHub = {
    claim: (repo, issue) => void claimed.push(`${repo}#${issue}`),
    release: (repo, issue) => void released.push(`${repo}#${issue}`),
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
  const exits = new Map<string, (exit: ChildExit) => void>();
  const fork: ForkWorkItem = (job) => {
    forked.push(job);
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

  const logger = new Logger(dests);
  const state = new StateStore(resolve(caseDir, "state.json"));
  const assignor = new Assignor({
    repos: TABLE,
    github,
    log: logger.child("assignor"),
    scheduler: createScheduler(2, logger.child("scheduler")),
    state,
    fork,
    paths,
  });

  return { assignor, state, lines, comments, claimed, released, forked, finish, paths };
}

/** The work item every case below is about, and the run that gated on it. */
const KEY = "acme/finance#57";
const QUESTION = "Which of the two auth flows should this use?";
const SESSION = "9f3c1a7e-2b40-4d61-8c55-0e1d2f3a4b5c";

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
    await h.finish(key, { key, status: "awaiting-human", summary: question, finishedAt: "2026-07-25T00:00:00.000Z", sessionId: session });

    ok("gate: recorded awaiting-human — neither finished nor failed, and not left in-flight", h.state.get(key)?.status === "awaiting-human", JSON.stringify(h.state.get(key)));
    ok(
      "gate: the session handle is kept, so a reply weeks later resumes the run rather than restarting it",
      h.state.get(key)?.sessionId === session,
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
    ok("resume: the issue is claimed again — from here it is Sunday's work, not the human's", h.claimed.join(",") === `${KEY},${KEY}`, h.claimed.join(","));
    ok(
      "resume: recorded in-flight with the session PRESERVED — the whole record is replaced, and a run that dies mid-resume must still be resumable",
      h.state.get(KEY)?.status === "in-flight" && h.state.get(KEY)?.sessionId === SESSION,
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

  // ── a comment on a PULL REQUEST is #44's work, never an issue run's. GitHub delivers
  //    one as an `issue_comment` like any other, so the subject is the only thing that
  //    separates the two flows — and it is decided on the delivery, not on what state
  //    happens to say about a number ──
  {
    const h = harness();
    await gate(h, SESSION);

    h.assignor.handle(reply("@sunday the rebase dropped a commit", { onPullRequest: true }));
    await tick();

    ok("PR comment: it does not resume an issue run", h.forked.length === 1, JSON.stringify(h.forked.map((j) => j.resume)));
    ok("PR comment: the item stays the human's, waiting on the answer it actually asked for", h.state.get(KEY)?.status === "awaiting-human", JSON.stringify(h.state.get(KEY)));
    ok("PR comment: and the line says whose work it is, rather than reading as a dead end", said(h.lines, "#44"), JSON.stringify(h.lines.map((l) => l.message)));
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
    const item = { key, repo: "acme/finance", issue: 57 };
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
    const item = { key, repo: "acme/finance", issue: 57 };
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

    ok("dead child: the item is recorded failed rather than left in-flight", h.state.get(key)?.status === "failed", JSON.stringify(h.state.get(key)));
    ok("dead child: the comment carries the exit code — the only thing known about it", h.comments.at(-1)?.message.includes("3") === true, JSON.stringify(h.comments.at(-1)));
    ok("dead child: the claim is released, so a human re-labelling it can retry", h.released.join(",") === key, h.released.join(","));
    ok("dead child: and the lock it died holding is cleared", readLock(h.paths.pidPath(key)) === undefined, JSON.stringify(readLock(h.paths.pidPath(key))));

    h.assignor.handle(delivery());
    await tick();
    ok("dead child: a failed item is retried on a re-label, unlike a finished one", h.forked.length === 2, JSON.stringify(h.forked.map((j) => j.key)));
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

    ok("unstarted child: the item is recorded failed rather than left in-flight", h.state.get(key)?.status === "failed", JSON.stringify(h.state.get(key)));
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
