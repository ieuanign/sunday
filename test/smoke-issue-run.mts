// test/smoke-issue-run.mts — hermetic smoke for the thing one issue run DECIDES
// (issue #36). It drives the real IssueModule over the real Logger with the four things
// that reach the world substituted — the agent (quota), GitHub (real writes to a real
// repo), git (a checkout on disk) and the image probe (docker) — so what is asserted is
// what a run decides from an agent's signal and from what it asserts around it (#38),
// not how the commands are built.
//   devbox run node test/smoke-issue-run.mts
// The module touches no filesystem of its own, so this case needs no temp dir at all.
// $0, offline, no docker, no network, no tokens.

import { IssueModule, type IssueRunInput } from "#issue/index.mts";
import type { ImagePresent } from "#issue/preconditions.mts";
import { HANDOFF_TAG, RESULT_TAG, type IssueResult } from "#issue/prompt.mts";
import type { Agent, AgentRunRequest, AgentRunResult, AgentUsage } from "#services/agent/index.mts";
import type { Git } from "#services/git.mts";
import type { GitHubRun, NewPullRequest } from "#services/github/index.mts";
import { Logger, type Destinations, type LogLine } from "#services/logger.mts";

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : `\n    ${detail}`}`);
};

/** A baseline prompt with both placeholders the composer must substitute. */
const BASELINE = `Work {{REPO}} issue #{{ISSUE}}. Finish with one <${RESULT_TAG}> result.`;
const TITLE = "Stop losing the closing keyword";
const BODY = "Merged fail-PRs leave their issue open forever.";
const PR_URL = "https://github.com/acme/finance/pull/99";
/** What the base resolves to in this case's checkout — the commit the agent is handed
 *  as its start point, and therefore the fork point the run reports (#42). */
const FORK_POINT = "9c1f0b2e4d6a8c0e2f4a6b8d0c2e4f6a8b0d2c4e";

/** The labels this repo admits an issue on, and what the fake issue wears by default —
 *  the before-work set asserts the second still contains the first (#38). */
const TRIGGER_LABELS = ["sunday", "ready-for-agent"];

/** The handoff threshold every run here is handed (#67), so the cases say which side of
 *  the boundary they are on without depending on whatever `.env` defaults to. */
const THRESHOLD = 120_000;

/** What the handoff turn answers with, when a case does not say otherwise. */
const NOTE = "## Where this got to\n\nThe migration is written; the backfill is not.";

/** What this case's fakes answer with. Everything else is the ordinary happy path: an
 *  agent that says `ready`, a branch one commit ahead, and no PR open yet. */
interface Scenario {
  /** The base the Assignor chose for this item — `feat/<blocker>` when it stacked it. */
  base?: string;
  /** The issue's state as the run reads it back, lowercased. Anything but `open` is a
   *  run that must not start (#38). */
  state?: string;
  /** The labels the issue wears NOW — the trigger labels by default. */
  labels?: string[];
  result?: IssueResult;
  /** The agent fails instead of answering. */
  agentError?: string;
  /** Reading the issue fails — a seam throwing before there is any signal to act on. */
  readIssueError?: string;
  /** Commits on the run's branch that the base does not have. */
  ahead?: number;
  /** SHAs the agent says IT committed — on a resume, only the resuming session's. */
  agentCommits?: string[];
  /** What the agent adapter resolved and how long the run took, for the footer. */
  model?: string;
  durationMs?: number;
  /** A PR already open for this head BEFORE the run starts — a run that must not start
   *  (#38): that PR is already serving the issue. */
  openPr?: string;
  /** A PR that appears for this head only AFTER the agent ran — the create RACING (#36),
   *  which is what the ship-time adoption is for. */
  openPrAtShip?: string;
  sessionId?: string;
  /** What the session had consumed when the agent stopped — the gate outcome carries it
   *  out for the resume to weigh (#67). */
  usage?: AgentUsage;
  preservedWorktreePath?: string;
  resume?: { sessionId: string; reply: string; contextTokens?: number };
  /** What the bounded handoff turn emits inside its tag (#67). */
  handoffNote?: string;
  /** The COMPACTION turn left the worktree dirty and the work turn after it left none. */
  handoffPreservedWorktreePath?: string;
  /** Keeping the note on disk blows up (a full disk, a read-only `var/`). */
  noteWriteError?: string;
  /** Dropping the spent note blows up — AFTER the pull request is already open. */
  noteClearError?: string;
  /** Cleanup blows up (a `git` that threw with its own stderr). */
  cleanupError?: string;
  /** The footer's file-stat read blows up — a `git` blip AFTER the push. */
  diffStatError?: string;
  /** The base does not resolve — a blocker's branch deleted between admission and the
   *  run. */
  resolveRefError?: string;
  /** The origin does not have the base at all — a blocker that merged and had its head
   *  branch deleted while this item waited in the queue. */
  baseGone?: boolean;
  /** The origin has the base when the run starts and not when it goes to ship: the
   *  blocker's PR merged during the agent run (the captured finance#57 race). */
  baseGoneAtShip?: boolean;
  /** This repo's sandbox image is not on the host — pruned since boot built it. */
  imageMissing?: boolean;
  /** Docker cannot answer at all: a dead daemon, which is every repo's problem. */
  imageProbeError?: string;
  /** This run is #39's one retry, carrying what the previous attempt died on. */
  retryError?: string;
  /** The steer a human typed when they released this parked item (#66). */
  hint?: string;
}

/** A real IssueModule over the real Logger, with the three world-reaching services stood
 *  in for. Returns the call trace (order is load-bearing) alongside what each fake was
 *  handed. */
function harness(s: Scenario = {}) {
  /** Every service call, in the order it happened. */
  const trace: string[] = [];
  /** Every line the run emits, at any level — the run log is where they all land. */
  const lines: LogLine[] = [];
  /** What would reach the issue as a COMMENT. The child posts none of its own: the two
   *  milestones per work item are the parent's. */
  const comments: LogLine[] = [];
  const dests: Destinations = {
    console: () => {},
    runLog: (line) => void lines.push(line),
    eventLog: () => {},
    github: (line) => void comments.push(line),
    phone: () => {},
  };

  const requests: AgentRunRequest<IssueResult>[] = [];
  /** Which side of the agent run a seam is being asked on — the whole point of asking
   *  twice is that the world can change in between. */
  let agentRan = false;
  const agent: Agent = {
    // The trailing comma is not a typo: `<T>` alone is reserved syntax in a `.mts` file.
    run: async <T,>(request: AgentRunRequest<T>): Promise<AgentRunResult<T>> => {
      trace.push("agent");
      agentRan = true;
      requests.push(request as unknown as AgentRunRequest<IssueResult>);
      if (s.agentError) throw new Error(s.agentError);
      return {
        // BY THE TAG: a handed-off run makes two calls, and the compaction turn wants prose
        // where the work run wants a result object.
        output: (request.output.tag === HANDOFF_TAG
          ? (s.handoffNote ?? NOTE)
          : (s.result ?? { signal: "ready", description: "shipped it" })) as unknown as T,
        sessionId: s.sessionId,
        usage: s.usage,
        commits: s.agentCommits ?? [],
        preservedWorktreePath:
          request.output.tag === HANDOFF_TAG ? s.handoffPreservedWorktreePath : s.preservedWorktreePath,
        model: s.model,
        durationMs: s.durationMs ?? 1,
        logPath: request.logPath,
      };
    },
  };

  const labelsAdded: string[] = [];
  const labelsRemoved: string[] = [];
  const created: NewPullRequest[] = [];
  const github: GitHubRun = {
    readIssue: async () => {
      if (s.readIssueError) throw new Error(s.readIssueError);
      return { title: TITLE, body: BODY, state: s.state ?? "open", labels: s.labels ?? TRIGGER_LABELS };
    },
    addLabels: async (_repo, _issue, labels) => {
      trace.push("addLabels");
      labelsAdded.push(...labels);
    },
    removeLabels: async (_repo, _issue, labels) => {
      trace.push("removeLabels");
      labelsRemoved.push(...labels);
    },
    openPrForHead: async () => {
      trace.push("openPrForHead");
      return agentRan ? (s.openPr ?? s.openPrAtShip) : s.openPr;
    },
    createPr: async (pr) => {
      trace.push("createPr");
      created.push(pr);
      return PR_URL;
    },
  };

  const pushed: string[] = [];
  const deleted: string[] = [];
  const removedWorktrees: string[] = [];
  const counted: string[] = [];
  const statted: string[] = [];
  const resolved: string[] = [];
  /** Every branch the ORIGIN was asked about, in order — one before the run starts and
   *  one immediately before the push. */
  const remoteChecked: string[] = [];
  const git: Git = {
    remoteBranchExists: async (_dir, branch) => {
      trace.push("remoteBranchExists");
      remoteChecked.push(branch);
      if (s.baseGone) return false;
      return !(s.baseGoneAtShip && agentRan);
    },
    excludeScratch: async () => void trace.push("exclude"),
    fetchPrune: async () => void trace.push("fetch"),
    resolveRef: async (_dir, ref) => {
      trace.push("resolveRef");
      resolved.push(ref);
      if (s.resolveRefError) throw new Error(s.resolveRefError);
      return FORK_POINT;
    },
    push: async (_dir, branch) => {
      trace.push("push");
      pushed.push(branch);
    },
    aheadCount: async (_dir, baseRef, branch) => {
      counted.push(`${baseRef}..${branch}`);
      return s.ahead ?? 1;
    },
    diffStat: async (_dir, baseRef, branch) => {
      trace.push("diffStat");
      statted.push(`${baseRef}...${branch}`);
      if (s.diffStatError) throw new Error(s.diffStatError);
      return { files: 2, insertions: 40, deletions: 5 };
    },
    removeWorktree: async (_dir, path) => {
      trace.push("removeWorktree");
      removedWorktrees.push(path);
    },
    deleteBranch: async (_dir, branch) => {
      trace.push("deleteBranch");
      if (s.cleanupError) throw new Error(s.cleanupError);
      deleted.push(branch);
    },
  };

  const imagesProbed: string[] = [];
  const imagePresent: ImagePresent = async (imageName) => {
    trace.push("imagePresent");
    imagesProbed.push(imageName);
    if (s.imageProbeError) throw new Error(s.imageProbeError);
    return !s.imageMissing;
  };

  /** The note text this run persisted — the module resolves no path, so the write it is
   *  handed is the whole of what reaches the disk. */
  const notesWritten: string[] = [];
  const writeHandoffNote = (note: string) => {
    trace.push("writeNote");
    if (s.noteWriteError) throw new Error(s.noteWriteError);
    notesWritten.push(note);
  };
  let notesCleared = 0;
  const clearHandoffNote = () => {
    trace.push("clearNote");
    if (s.noteClearError) throw new Error(s.noteClearError);
    notesCleared++;
  };

  const input: IssueRunInput = {
    key: "acme/finance#57",
    repo: "acme/finance",
    issue: 57,
    childDir: "/repos/finance",
    base: s.base ?? "main",
    imageName: "sunday-finance",
    triggerLabels: TRIGGER_LABELS,
    baselinePrompt: BASELINE,
    logPath: "/var/log/acme/finance/57/run.log",
    handoffThreshold: THRESHOLD,
    ...(s.resume ? { resume: s.resume } : {}),
    ...(s.retryError ? { retryError: s.retryError } : {}),
    ...(s.hint ? { hint: s.hint } : {}),
  };

  const module = new IssueModule({
    agent,
    github,
    git,
    imagePresent,
    writeHandoffNote,
    clearHandoffNote,
    log: new Logger(dests).child("issue"),
  });
  return {
    run: () => module.run(input),
    trace,
    lines,
    comments,
    requests,
    labelsAdded,
    labelsRemoved,
    created,
    pushed,
    deleted,
    removedWorktrees,
    counted,
    statted,
    resolved,
    remoteChecked,
    imagesProbed,
    notesWritten,
    clearedNotes: () => notesCleared,
  };
}

// ── ready + commits: the whole point — one push, one PR, and the issue gets closed ──
{
  const h = harness({ result: { signal: "ready", description: "Added the guard and a test." } });
  const outcome = await h.run();

  ok("ready: the branch is pushed exactly once", h.pushed.length === 1 && h.pushed[0] === "feat/57", h.pushed.join(", "));
  ok("ready: one PR is opened", h.created.length === 1, String(h.created.length));
  ok("ready: it is titled from the issue", h.created[0]?.title === TITLE, h.created[0]?.title ?? "");
  ok("ready: `ready` is the one signal that is NOT a draft", h.created[0]?.draft === false, String(h.created[0]?.draft));
  ok(
    "ready: the body carries the closing keyword — a merged PR must close its issue (AC7)",
    h.created[0]?.body.includes("Closes #57") === true,
    h.created[0]?.body ?? "",
  );
  ok("ready: the body carries the agent's own description", h.created[0]?.body.includes("Added the guard and a test.") === true, h.created[0]?.body ?? "");
  ok("ready: the PR bases on main, not on the resolved ref the agent started from", h.created[0]?.base === "main", h.created[0]?.base ?? "");
  ok("ready: the outcome is done and carries the PR url", outcome.status === "done" && outcome.summary.includes(PR_URL), JSON.stringify(outcome));
  ok("ready: the outcome is named back with the work-item key", outcome.key === "acme/finance#57", outcome.key);
}

// ── the body the PR ships is the COMPOSED one: every section the agent answered, and a
//    footer of facts the agent was never asked for (#37) ──
{
  const h = harness({
    result: {
      signal: "ready",
      description: "Composed the body in code.",
      context: "A template file would drift from the sections.",
      risk: "medium",
      review: { verdict: "CHANGES_REQUESTED", body: "The defuser missed `GH-`." },
    },
    // What the agent says it committed is NOT what the footer counts: on a gate resume
    // this list names only the resuming session's commits.
    agentCommits: ["a1", "b2", "c3", "d4", "e5", "f6", "g7"],
    ahead: 3,
  });
  await h.run();
  const body = h.created[0]?.body ?? "";

  ok(
    "body: the run ships the composed sections, not one line of agent prose",
    ["## Description", "## Related issue", "## Context", "## Type of change", "## Risk", "## Verification", "## Review findings"].every((h2) => body.includes(h2)),
    body,
  );
  ok("body: the whole result reaches the composer, not just the description", body.includes("CHANGES_REQUESTED") && body.includes("The defuser missed") && body.includes("- [x] Medium"), body);
  ok(
    "footer: the commit count is the one git measured, never the agent's own list",
    body.includes("3 commits") && !body.includes("7 commits"),
    body,
  );
}

// ── the file stats are read from git, AFTER the push, and are best-effort: a `git` blip
//    there must degrade the footer, never turn a shipped PR into a failed work item
//    (ADR-0001 — the child leaves exactly one honest outcome) ──
{
  const h = harness();
  await h.run();

  ok(
    "stat: measured from where the branch diverged from the freshly-fetched base",
    h.statted.length === 1 && h.statted[0] === "origin/main...feat/57",
    h.statted.join(", "),
  );
  ok(
    "stat: read AFTER the push — the branch it describes is the one the PR shows",
    h.trace.indexOf("push") < h.trace.indexOf("diffStat"),
    h.trace.join(" → "),
  );
  ok("stat: and its numbers are what the footer states", h.created[0]?.body.includes("2 files, +40/−5") === true, h.created[0]?.body ?? "");
}
{
  const h = harness({ diffStatError: "fatal: bad revision 'origin/main...feat/57'" });
  const outcome = await h.run();

  ok("stat: a read that throws still opens the PR", h.created.length === 1, String(h.created.length));
  ok("stat: and still leaves a done work item", outcome.status === "done", JSON.stringify(outcome));
  ok("stat: the footer degrades that one fact rather than fabricating a zero", h.created[0]?.body.includes("file stats unavailable") === true, h.created[0]?.body ?? "");
  ok(
    "stat: and the blip is not silent",
    h.lines.some((l) => l.message.includes("bad revision")),
    h.lines.map((l) => l.message).join(" | "),
  );
}
{
  const h = harness({ openPrAtShip: "https://github.com/acme/finance/pull/12" });
  await h.run();
  ok("stat: an adopted PR keeps the body it was opened with, so nothing is measured for it", h.statted.length === 0, h.statted.join(", "));
}

// ── the footer states the facts THIS run was handed, not defaults ──
{
  const h = harness({ model: "claude-opus-4-6", durationMs: 7 * 60_000 + 9_000 });
  await h.run();
  const body = h.created[0]?.body ?? "";

  ok("footer: the model the agent adapter resolved", body.includes("claude-opus-4-6"), body);
  ok("footer: the duration the run took", body.includes("7m 09s"), body);
  ok("footer: this run's own log path, verbatim", body.includes("/var/log/acme/finance/57/run.log"), body);
  ok("footer: the base the PR targets", body.includes("base `main`"), body);
}
{
  const h = harness();
  await h.run();
  ok(
    "footer: an agent that reports no model degrades that one fact, and ships anyway",
    h.created[0]?.body.includes("model unknown") === true,
    h.created[0]?.body ?? "",
  );
}

// ── draft and fail ship too — as a DRAFT, and still closing the issue ──
{
  const h = harness({ result: { signal: "draft", description: "Works, but the migration wants eyes." } });
  const outcome = await h.run();

  ok("draft: opens a draft PR", h.created[0]?.draft === true, String(h.created[0]?.draft));
  ok("draft: the body still carries the closing keyword", h.created[0]?.body.includes("Closes #57") === true, h.created[0]?.body ?? "");
  ok("draft: a shipped draft is a done work item", outcome.status === "done", JSON.stringify(outcome));
}
{
  const h = harness({ result: { signal: "fail", description: "Could not make the integration test pass." } });
  const outcome = await h.run();

  ok("fail: opens a draft PR rather than shipping nothing", h.created[0]?.draft === true, String(h.created[0]?.draft));
  ok(
    "fail: the body carries the closing keyword TOO — v1 omitted it here and left every merged fail-PR's issue open",
    h.created[0]?.body.includes("Closes #57") === true,
    h.created[0]?.body ?? "",
  );
  ok("fail: the work item is recorded failed, PR or no PR", outcome.status === "failed", JSON.stringify(outcome));
  ok("fail: the outcome carries the agent's own words", outcome.summary.includes("Could not make the integration test pass."), outcome.summary);
  ok(
    "fail: it says the AGENT reported this — a typed fact (#39), because the summary around it is Sunday's own prose",
    outcome.agentFailed === true,
    JSON.stringify(outcome),
  );
}
{
  const h = harness({ result: { signal: "draft", description: "Works, but the migration wants eyes." } });
  const outcome = await h.run();
  ok(
    "draft: a run that SHIPPED carries no agent-reported flag — nothing failed for anyone to classify",
    outcome.agentFailed === undefined,
    JSON.stringify(outcome),
  );
}

// ── an agent that committed nothing: say so, ship nothing, and do not read as a crash ──
{
  const h = harness({ result: { signal: "ready", description: "Nothing needed changing." }, ahead: 0 });
  const outcome = await h.run();

  ok("nothing to ship: the branch is never pushed", h.pushed.length === 0, h.pushed.join(", "));
  ok("nothing to ship: no PR is opened", h.created.length === 0, String(h.created.length));
  ok("nothing to ship: the work item fails rather than quietly claiming success", outcome.status === "failed", JSON.stringify(outcome));
  ok("nothing to ship: the outcome says WHY", outcome.summary.includes("no commits"), outcome.summary);
  ok(
    "nothing to ship: the agent RAN and this is its own verdict, so it is flagged as one (#39) — not retried as an unknown failure",
    outcome.agentFailed === true,
    JSON.stringify(outcome),
  );
  ok(
    "nothing to ship: counted against the freshly-fetched remote ref, not a stale local one",
    h.counted.length === 1 && h.counted[0] === "origin/main..feat/57",
    h.counted.join(", "),
  );
}

// ── a PR that appeared for this head WHILE the agent worked is adopted (AC6): the
//    create is what races, and `gh pr create` dies on "a pull request already exists".
//    A PR that was already open before the run started is a different thing entirely —
//    the run never begins (#38, below) ──
{
  const already = "https://github.com/acme/finance/pull/12";
  const h = harness({ openPrAtShip: already });
  const outcome = await h.run();

  ok("adopt: no second PR is created — `gh pr create` would have died on the first", h.created.length === 0, String(h.created.length));
  ok("adopt: the outcome carries the PR that already exists", outcome.summary.includes(already), outcome.summary);
  ok("adopt: the branch is still pushed — the retry's commits have to reach the open PR", h.pushed.length === 1, h.pushed.join(", "));
}

// ── cleanup: origin holds the history, so the local branch goes — worktree first ──
{
  const h = harness({ preservedWorktreePath: "/repos/finance/.worktrees/feat-57" });
  await h.run();

  ok("cleanup: the local branch is deleted once its history is on the origin", h.deleted.includes("feat/57"), h.deleted.join(", "));
  ok(
    "cleanup: a preserved worktree is force-removed FIRST — it holds the branch checked out, which blocks the delete",
    h.trace.indexOf("removeWorktree") < h.trace.indexOf("deleteBranch") && h.removedWorktrees.length === 1,
    h.trace.join(" → "),
  );
}
{
  const h = harness({ ahead: 0 });
  await h.run();
  ok("cleanup: a run that shipped nothing still cleans up after itself", h.deleted.includes("feat/57"), h.deleted.join(", "));
}
{
  // The cleanup is a `finally`, and a `finally` that throws REPLACES the return — so a
  // git failure here would swallow a PR that really was opened.
  const h = harness({ cleanupError: "error: branch 'feat/57' not found" });
  const outcome = await h.run();

  ok("cleanup: a git failure during cleanup does not lose the outcome", outcome.status === "done", JSON.stringify(outcome));
  ok(
    "cleanup: and it is not silent either",
    h.lines.some((l) => l.message.includes("branch 'feat/57' not found")),
    h.lines.map((l) => l.message).join(" | "),
  );
}

// ── gate: ask the human, ship nothing, and keep the only copy of the commits (AC3) ──
{
  const h = harness({
    result: { signal: "gate", description: "Blocked on a product call.", question: "Should deleted accounts keep their invoices?" },
    sessionId: "sess-abc123",
    usage: { input: 90_000, cacheCreation: 12_000, cacheRead: 41_500, output: 3_000, contextTokens: 143_500 },
    preservedWorktreePath: "/repos/finance/.worktrees/feat-57",
  });
  const outcome = await h.run();

  ok("gate: the issue is labelled awaiting-human", h.labelsAdded.includes("awaiting-human"), h.labelsAdded.join(", "));
  ok("gate: nothing is pushed", h.pushed.length === 0, h.pushed.join(", "));
  ok("gate: no PR is opened", h.created.length === 0, String(h.created.length));
  ok(
    "gate: the local branch is KEPT — it is the only copy of the gated commits",
    h.deleted.length === 0 && h.removedWorktrees.length === 0,
    h.trace.join(" → "),
  );
  ok("gate: the outcome says the run is waiting on a human", outcome.status === "awaiting-human", JSON.stringify(outcome));
  ok(
    "gate: the outcome's summary IS the question — the parent's milestone is what posts it",
    outcome.summary === "Should deleted accounts keep their invoices?",
    outcome.summary,
  );
  ok("gate: the session handle rides along so the reply resumes rather than restarts", outcome.sessionId === "sess-abc123", String(outcome.sessionId));
  ok(
    "gate: and how big that session is, so the run that answers can weigh resuming it (#67) — this child is gone before anyone reads the question",
    outcome.contextTokens === 143_500,
    String(outcome.contextTokens),
  );
  ok("gate: the child posts no comment of its own", h.comments.length === 0, h.comments.map((c) => c.message).join(" | "));
}
{
  // An agent that gated without filling in `question` still has to ask something.
  const h = harness({ result: { signal: "gate", description: "Which of the two schemas should win?" } });
  const outcome = await h.run();
  ok("gate: with no question field, the description is what the human is asked", outcome.summary === "Which of the two schemas should win?", outcome.summary);
}

// ── resume: the human answered, so continue the same session rather than start over ──
{
  const h = harness({ resume: { sessionId: "sess-abc123", reply: "Keep the invoices, anonymise the account." } });
  const outcome = await h.run();
  const request = h.requests[0];

  ok("resume: the issue stops being awaiting-human — it is working again", h.labelsRemoved.includes("awaiting-human"), h.labelsRemoved.join(", "));
  ok(
    "resume: and it stops being so BEFORE the agent runs, not minutes later",
    h.trace.indexOf("removeLabels") < h.trace.indexOf("agent"),
    h.trace.join(" → "),
  );
  ok("resume: the stored session is what the agent continues", request?.resumeSession === "sess-abc123", String(request?.resumeSession));
  ok("resume: the prompt is the human's reply", request?.prompt.includes("Keep the invoices, anonymise the account.") === true, request?.prompt ?? "");
  ok(
    "resume: with the reminder that carries the tag literal — the library extracts the result BY it",
    request?.prompt.includes(`<${RESULT_TAG}>`) === true,
    request?.prompt ?? "",
  );
  ok(
    "resume: and NOT the baseline again — the session being continued already has it",
    request?.prompt.includes("Work acme/finance issue") === false,
    request?.prompt ?? "",
  );
  ok("resume: a resume that finishes ships the PR the gate never opened", h.created[0]?.title === TITLE, JSON.stringify(h.created[0] ?? {}));
  ok("resume: and it is a done work item", outcome.status === "done", JSON.stringify(outcome));
}
{
  const h = harness();
  await h.run();
  ok("fresh: a fresh run touches no label at all", h.labelsRemoved.length === 0 && h.labelsAdded.length === 0, h.trace.join(" → "));
}

// ── the handoff (#67): at or past the threshold the reply seeds a FRESH session instead of
//    the bloated one. Asserted AT the threshold — `>` would hand off one turn later ──
{
  const h = harness({
    resume: { sessionId: "sess-abc123", reply: "Keep the invoices, anonymise the account.", contextTokens: THRESHOLD },
    preservedWorktreePath: "/repos/finance/.worktrees/feat-57",
  });
  const outcome = await h.run();
  const [compaction, work] = h.requests;

  ok("handoff: exactly two agent turns — the compaction, then the work", h.requests.length === 2, String(h.requests.length));
  ok(
    "handoff: the first turn continues the OLD session — it is the only thing that can compact it",
    compaction?.resumeSession === "sess-abc123" && compaction?.output.tag === HANDOFF_TAG,
    JSON.stringify({ resume: compaction?.resumeSession, tag: compaction?.output.tag }),
  );
  ok(
    "handoff: and takes the note as raw text — a summary is prose, not a JSON contract",
    compaction?.output.schema === undefined,
    String(compaction?.output.schema),
  );
  ok(
    "handoff: the compaction turn is told to write nothing — it runs in a sandbox with no credentials, and a file it wrote would dirty the worktree",
    /write no|no file|do not write/i.test(compaction?.prompt ?? "") && compaction?.prompt.includes(`<${HANDOFF_TAG}>`) === true,
    compaction?.prompt ?? "",
  );
  ok(
    "handoff: the work turn resumes NOTHING — the whole point is that the old session is retired",
    work?.resumeSession === undefined,
    String(work?.resumeSession),
  );
  ok(
    "handoff: it is seeded with the note, so the fresh session knows what the retired one did",
    work?.prompt.includes(NOTE) === true,
    work?.prompt ?? "",
  );
  ok(
    "handoff: and with the human's reply — the answer the whole resume exists for",
    work?.prompt.includes("Keep the invoices, anonymise the account.") === true,
    work?.prompt ?? "",
  );
  ok(
    "handoff: carrying the result tag literal — a fresh session was never told how to finish",
    work?.prompt.includes(`<${RESULT_TAG}>`) === true,
    work?.prompt ?? "",
  );
  ok(
    "handoff: the note is kept on disk — the run log has the raw turn, this is the readable record",
    h.notesWritten.length === 1 && h.notesWritten[0] === NOTE,
    h.notesWritten.join(" | "),
  );
  ok(
    "handoff: and dropped once the PR exists — the note has done its job the moment the work ships",
    h.clearedNotes() === 1 && h.trace.indexOf("createPr") < h.trace.indexOf("clearNote"),
    h.trace.join(" → "),
  );
  ok("handoff: the handed-off run ships its PR like any other", outcome.status === "done" && h.created.length === 1, JSON.stringify(outcome));
}

{
  // One token under: a session that still fits is cheaper to continue than to compact.
  const h = harness({ resume: { sessionId: "sess-abc123", reply: "Keep the invoices.", contextTokens: THRESHOLD - 1 } });
  const outcome = await h.run();

  ok("below: one agent turn only — nothing is compacted", h.requests.length === 1, String(h.requests.length));
  ok("below: and it continues the session it was handed", h.requests[0]?.resumeSession === "sess-abc123", String(h.requests[0]?.resumeSession));
  ok("below: no note is written", h.notesWritten.length === 0, h.notesWritten.join(" | "));
  ok("below: the resume ships as it always did", outcome.status === "done", JSON.stringify(outcome));
}
{
  // No number: an outcome recorded before #67, or an agent that reported no usage. Unknown
  // resumes — guessing "big" costs a whole handoff on a session that may be tiny.
  const h = harness({ resume: { sessionId: "sess-abc123", reply: "Keep the invoices." } });
  await h.run();

  ok(
    "unknown context: the run resumes rather than handing off — absent is unknown, not oversized",
    h.requests.length === 1 && h.requests[0]?.resumeSession === "sess-abc123",
    String(h.requests.length),
  );
}

// ── a compaction turn that came back with nothing: the ONE thing that must not happen is
//    falling back to the session it just refused to resume ──
{
  const h = harness({
    resume: { sessionId: "sess-abc123", reply: "Keep the invoices.", contextTokens: 250_000 },
    handoffNote: "   \n  ",
    handoffPreservedWorktreePath: "/repos/finance/.worktrees/feat-57",
  });
  const outcome = await h.run();

  ok("no note: the bloated session is never run again — the compaction turn is the only one", h.requests.length === 1, String(h.requests.length));
  ok("no note: nothing is written, pushed or opened", h.pushed.length === 0 && h.created.length === 0, h.trace.join(" → "));
  ok("no note: a blank note is not kept either", h.notesWritten.length === 0, h.notesWritten.join(" | "));
  ok(
    "no note: the work item FAILS — `awaiting-human` would send the reply straight back to the session that could not be compacted",
    outcome.status === "failed",
    JSON.stringify(outcome),
  );
  ok(
    "no note: flagged as the agent's own (#39), so it parks for a human instead of spending another run being classified",
    outcome.agentFailed === true,
    JSON.stringify(outcome),
  );
  ok(
    "no note: and the summary is written for the human's phone — what happened, and that a hand-back starts over",
    outcome.summary.includes("250000") && outcome.summary.includes(String(THRESHOLD)) && /scratch|again/i.test(outcome.summary),
    outcome.summary,
  );
  ok(
    "no note: the compaction turn's preserved worktree still reaches cleanup — it holds the branch checked out, and the delete cannot run while it is there",
    h.removedWorktrees.length === 1 && h.trace.indexOf("removeWorktree") < h.trace.indexOf("deleteBranch") && h.deleted.includes("feat/57"),
    h.trace.join(" → "),
  );
}

{
  // The COMPACTION turn left the worktree dirty and the work turn after it did not — and a
  // worktree holding the branch checked out is a branch nothing can delete (#33).
  const h = harness({
    resume: { sessionId: "sess-abc123", reply: "Keep the invoices.", contextTokens: THRESHOLD },
    handoffPreservedWorktreePath: "/repos/finance/.worktrees/feat-57",
  });
  await h.run();

  ok(
    "handoff: a worktree the COMPACTION turn left behind is still removed, and the branch after it",
    h.removedWorktrees.join(",") === "/repos/finance/.worktrees/feat-57" && h.deleted.includes("feat/57"),
    h.trace.join(" → "),
  );
}

// ── the note is a RECORD, not the handoff: the fresh session is seeded from the note in
//    memory, so neither keeping it nor dropping it may cost the run (ADR-0001) ──
{
  const h = harness({
    resume: { sessionId: "sess-abc123", reply: "Keep the invoices.", contextTokens: THRESHOLD },
    noteWriteError: "ENOSPC: no space left on device",
  });
  const outcome = await h.run();

  ok("note write: a disk that cannot take the note does not cost the handoff", h.requests.length === 2 && outcome.status === "done", JSON.stringify(outcome));
  ok(
    "note write: and it is not silent",
    h.lines.some((l) => l.message.includes("ENOSPC")),
    h.lines.map((l) => l.message).join(" | "),
  );
}
{
  const h = harness({
    resume: { sessionId: "sess-abc123", reply: "Keep the invoices.", contextTokens: THRESHOLD },
    noteClearError: "EACCES: permission denied",
  });
  const outcome = await h.run();

  ok(
    "note clear: it runs AFTER the push — a throw there would turn a shipped pull request into a failed work item",
    outcome.status === "done" && outcome.summary.includes(PR_URL),
    JSON.stringify(outcome),
  );
}

// ── the one retry (#39): this run is the second attempt at an item that failed once, and
//    the error it died on goes to the agent. That error is the ONLY thing this run knows
//    that the last one did not — without it the retry is the same run again on fresh quota ──
{
  const died = "TypeError: Cannot read properties of undefined (reading 'invoice')";
  const h = harness({ retryError: died });
  const outcome = await h.run();
  const prompt = h.requests[0]?.prompt ?? "";

  ok("retry: the previous run's error is in the prompt the agent is handed", prompt.includes(died), prompt);
  ok(
    "retry: and it is marked as the last attempt's, not as part of the issue — an unlabelled error reads as something the human wrote",
    prompt.includes("previous"),
    prompt,
  );
  ok(
    "retry: the baseline and the issue are still there — a retry is a FRESH run with one extra fact, not a resume",
    prompt.includes("Work acme/finance issue #57") && prompt.includes(TITLE) && prompt.includes(`<${RESULT_TAG}>`),
    prompt,
  );
  ok("retry: it resumes no session — the run that failed is gone", h.requests[0]?.resumeSession === undefined, String(h.requests[0]?.resumeSession));
  ok("retry: and nothing else about the run changes — it ships its PR like any other", outcome.status === "done" && h.created.length === 1, JSON.stringify(outcome));
}
{
  const h = harness();
  await h.run();
  ok(
    "fresh: a run that is nobody's retry says nothing about a previous attempt",
    h.requests[0]?.prompt.includes("previous") === false,
    h.requests[0]?.prompt ?? "",
  );
}

// ── the human's steer (#66): a parked item released with `/fix <key> <hint>` runs again
//    with what the human typed. Nobody types it for it to be dropped ──
{
  const steer = "Take the row lock in the backfill, not in the migration.";
  const h = harness({ hint: steer });
  const outcome = await h.run();
  const prompt = h.requests[0]?.prompt ?? "";

  ok("hint: the steer reaches the agent", prompt.includes(steer), prompt);
  ok(
    "hint: under a heading of its own, after the issue — spliced into the body it reads as something the human wrote there",
    prompt.indexOf(BODY) < prompt.indexOf(steer) &&
      /^#+ .+$/m.test(prompt.slice(prompt.indexOf(BODY) + BODY.length, prompt.indexOf(steer))),
    prompt,
  );
  ok("hint: and nothing else about the run changes — it ships its PR like any other", outcome.status === "done" && h.created.length === 1, JSON.stringify(outcome));
}
{
  const h = harness();
  await h.run();
  ok(
    "hint: a run nobody steered is handed no such section",
    h.requests[0]?.prompt.includes("handed this back") === false,
    h.requests[0]?.prompt ?? "",
  );
}
{
  // Both at once: the retried run of an item a human released with a note. The two sections
  // say OPPOSITE things about how to read them, so one must not swallow the other.
  const steer = "Take the row lock in the backfill, not in the migration.";
  const died = "TypeError: Cannot read properties of undefined (reading 'invoice')";
  const h = harness({ hint: steer, retryError: died });
  await h.run();
  const prompt = h.requests[0]?.prompt ?? "";

  ok("hint + retry: both facts reach the agent", prompt.includes(steer) && prompt.includes(died), prompt);
  ok(
    "hint + retry: the steer sits OUTSIDE the previous-failure section — inside it, the agent is told not to treat it as a requirement",
    prompt.indexOf("do not treat it as a requirement") < prompt.indexOf(steer),
    prompt,
  );
}
{
  // #67's fork REPLACES the whole prompt with the seed. A steer composed before that line
  // is a steer thrown away — which no `/fix` can be allowed to be.
  const steer = "Ship the backfill behind a flag; the migration can wait.";
  const h = harness({
    hint: steer,
    resume: { sessionId: "sess-abc123", reply: "Keep the invoices.", contextTokens: THRESHOLD },
  });
  await h.run();
  const [, work] = h.requests;

  ok(
    "hint: it survives the handoff fork — the seeded prompt carries the note, the reply AND the steer",
    work?.prompt.includes(NOTE) === true && work?.prompt.includes("Keep the invoices.") === true && work?.prompt.includes(steer) === true,
    work?.prompt ?? "",
  );
}

// ── an agent that blows up is one failed work item, never a thrown run ──
{
  const h = harness({ agentError: "Claude Code exited 1: credit balance is too low" });
  const outcome = await h.run();

  ok("agent failure: the run still answers with an outcome — the parent applies a FILE", outcome.status === "failed", JSON.stringify(outcome));
  ok(
    "agent failure: carrying the agent's own message, which is what #39 will classify on",
    outcome.summary.includes("credit balance is too low"),
    outcome.summary,
  );
  ok(
    "agent failure: and NOT flagged as the agent's own verdict — this text is the provider's, and #39 classifies it",
    outcome.agentFailed === undefined,
    JSON.stringify(outcome),
  );
  ok("agent failure: nothing is pushed and no PR is opened", h.pushed.length === 0 && h.created.length === 0, h.trace.join(" → "));
  ok("agent failure: the child still posts no comment — the parent's outcome milestone is the one report", h.comments.length === 0, String(h.comments.length));
  ok("agent failure: the branch is still cleaned up", h.deleted.includes("feat/57"), h.trace.join(" → "));
}
{
  // The seams throw with git's/gh's own stderr, and one of them is the FIRST thing a run
  // does — before there is any signal to act on.
  const h = harness({ readIssueError: "gh: issue 57 not found" });
  const outcome = await h.run();
  ok("read failure: a run that never reached the agent still leaves one outcome", outcome.status === "failed" && outcome.summary.includes("not found"), JSON.stringify(outcome));
}

// ── what the sandbox is handed: a prompt, a resolved ref, and NO credential (AC2) ──
{
  const h = harness();
  await h.run();
  const request = h.requests[0];

  ok("request: the run happens against the child checkout in its own image", request?.repo.childDir === "/repos/finance" && request?.repo.imageName === "sunday-finance", JSON.stringify(request?.repo ?? {}));
  ok("request: on the work item's own branch", request?.branch === "feat/57", request?.branch ?? "");
  ok(
    "request: from an ALREADY-RESOLVED remote ref — handed a bare name the library prefers a stale local branch",
    request?.startPoint === FORK_POINT && h.resolved.join(",") === "origin/main",
    `${request?.startPoint ?? ""} from ${h.resolved.join(",")}`,
  );
  ok("request: the agent's output goes to this run's own log file", request?.logPath === "/var/log/acme/finance/57/run.log", request?.logPath ?? "");
  ok(
    "request: nothing token-shaped is anywhere in it — the sandbox decides, the host pushes",
    !/token|credential|password|secret|ghp_/i.test(JSON.stringify(request)),
    JSON.stringify(request),
  );
  ok("prompt: the baseline's {{REPO}} is substituted", request?.prompt.includes("Work acme/finance issue #57") === true, request?.prompt ?? "");
  ok("prompt: the issue's title and body ride along", request?.prompt.includes(TITLE) === true && request?.prompt.includes(BODY) === true, request?.prompt ?? "");
  ok(
    "prompt: it carries the result tag literal — the library extracts the answer BY it",
    request?.prompt.includes(`<${RESULT_TAG}>`) === true,
    request?.prompt ?? "",
  );
  ok("request: the result is validated against a schema, not read as raw text", request?.output.tag === RESULT_TAG && request?.output.schema !== undefined, JSON.stringify(request?.output.tag));
  ok("request: a fresh run resumes no session", request?.resumeSession === undefined, String(request?.resumeSession));
  ok(
    "order: the scratch exclude and the fetch both happen BEFORE the agent — a dirty worktree blocks cleanup, a stale ref bases on yesterday",
    h.trace.indexOf("exclude") < h.trace.indexOf("fetch") && h.trace.indexOf("fetch") < h.trace.indexOf("agent"),
    h.trace.join(" → "),
  );
  ok(
    "order: and the base is resolved AFTER the fetch — resolved before it, the fork point is yesterday's commit",
    h.trace.indexOf("fetch") < h.trace.indexOf("resolveRef") && h.trace.indexOf("resolveRef") < h.trace.indexOf("agent"),
    h.trace.join(" → "),
  );
  ok(
    "log: every line the child emits is addressed to its issue, and none of them reaches GitHub",
    h.lines.length > 0 && h.lines.every((l) => l.level === "info" && l.context.repo === "acme/finance" && l.context.target === 57),
    h.lines.map((l) => `${l.level} ${JSON.stringify(l.context)}`).join(" | "),
  );
}

// ── a STACKED run (#42): the Assignor decided this item bases on its blocker's branch,
//    so every ref the run measures against follows it — and the run recomputes none of
//    it (constraint 8), because the answer minutes later may not be the same one ──
{
  const h = harness({ base: "feat/9" });
  await h.run();

  ok(
    "stacked: the agent branches off the BLOCKER's branch as the origin has it, not off main",
    h.resolved.join(",") === "origin/feat/9" && h.requests[0]?.startPoint === FORK_POINT,
    `${h.requests[0]?.startPoint ?? ""} from ${h.resolved.join(",")}`,
  );
  ok("stacked: commits are counted from that base — against main they would include the blocker's", h.counted.join(", ") === "origin/feat/9..feat/57", h.counted.join(", "));
  ok("stacked: and the diff the footer states is measured from it too", h.statted.join(", ") === "origin/feat/9...feat/57", h.statted.join(", "));
  ok(
    "stacked: the PR targets the blocker's BRANCH NAME — GitHub resolves it on the remote and knows nothing about a local checkout's refs",
    h.created[0]?.base === "feat/9",
    h.created[0]?.base ?? "",
  );
  ok("stacked: the footer says which base the PR went to", h.created[0]?.body.includes("base `feat/9`") === true, h.created[0]?.body ?? "");
}
{
  const h = harness({ base: "feat/9", ahead: 0 });
  const outcome = await h.run();
  ok(
    "stacked: an empty run says what it is empty against — 'no commits ahead of main' would be a lie",
    outcome.summary.includes("no commits") && h.lines.some((l) => l.message.includes("feat/9")),
    `${outcome.summary} | ${h.lines.map((l) => l.message).join(" | ")}`,
  );
}

// ── the fork point (#42/ADR-0003): the commit the branch was actually created from.
//    The agent library creates the branch AT the start point it is handed, so reporting
//    the SHA that was handed over records it by construction — a re-derivation later
//    would name wherever the base has moved to since ──
{
  const h = harness({ base: "feat/9" });
  const outcome = await h.run();

  ok(
    "fork point: the run reports the commit it handed the agent, not the ref it asked about",
    outcome.forkPoint === FORK_POINT && h.requests[0]?.startPoint === FORK_POINT,
    JSON.stringify(outcome),
  );
}
{
  const h = harness({ result: { signal: "gate", description: "Blocked on a product call." }, sessionId: "sess-abc123" });
  const outcome = await h.run();

  ok(
    "fork point: a gated run reports it too — its branch survives the gate, and is what a restack aims at",
    outcome.forkPoint === FORK_POINT,
    JSON.stringify(outcome),
  );
}
{
  const h = harness({ resume: { sessionId: "sess-abc123", reply: "Keep the invoices." } });
  const outcome = await h.run();

  ok(
    "fork point: a RESUMED run reports none — the branch was already there, so it forked from nothing and the recorded fork point stands",
    outcome.forkPoint === undefined,
    JSON.stringify(outcome),
  );
}
{
  // The blocker merged and GitHub deleted its head branch between admission and the run.
  const h = harness({ base: "feat/9", resolveRefError: "fatal: Needed a single revision" });
  const outcome = await h.run();

  ok(
    "fork point: a base that no longer resolves fails the run rather than starting the agent from nowhere",
    outcome.status === "failed" && outcome.summary.includes("Needed a single revision"),
    JSON.stringify(outcome),
  );
  ok("fork point: and the agent never runs, so no quota is spent on a run that cannot base", h.requests.length === 0, String(h.requests.length));
}

// ── the before-work set (#38): five assertions between the issue read and the run's
//    first write of any kind. A whole queue wait elapses between the Assignor admitting
//    an item and the child's first line, and what it was handed can have gone stale ──

/** Everything a run does that WRITES or COSTS — a label edit, the checkout, the agent,
 *  the push, the PR. A precondition that stops a run must let none of it happen: that is
 *  the whole point of asking before starting rather than failing part-way through. */
const SPENDS = ["removeLabels", "addLabels", "exclude", "fetch", "resolveRef", "agent", "push", "createPr", "deleteBranch", "removeWorktree"];
const spent = (trace: string[]): string[] => trace.filter((call) => SPENDS.includes(call));

{
  // The human closed the issue while it sat in the queue.
  const h = harness({ state: "closed" });
  const outcome = await h.run();

  ok("closed: nothing is written, run or spent — no label, no checkout, no agent", spent(h.trace).length === 0, h.trace.join(" → "));
  ok("closed: the outcome names the assertion that stopped it, typed", outcome.precondition === "issue-closed", JSON.stringify(outcome));
  ok("closed: and the work item is failed", outcome.status === "failed", JSON.stringify(outcome));
  ok("closed: the summary tells the human which condition it was", outcome.summary.includes("closed"), outcome.summary);
  ok("closed: the child posts no comment of its own — the parent's outcome milestone is the one report", h.comments.length === 0, String(h.comments.length));
}

{
  // A human pulled one of the trigger labels while the item waited — taking the issue back.
  const h = harness({ labels: ["sunday"] });
  const outcome = await h.run();

  ok("unlabelled: nothing is written, run or spent", spent(h.trace).length === 0, h.trace.join(" → "));
  ok("unlabelled: the outcome names the assertion, typed", outcome.precondition === "labels-missing", JSON.stringify(outcome));
  ok("unlabelled: and the work item is failed", outcome.status === "failed", JSON.stringify(outcome));
  ok("unlabelled: the summary names the label that came off, not just 'a label'", outcome.summary.includes("ready-for-agent"), outcome.summary);
}
{
  // The Assignor applied the claim to this very item before forking it, so re-running
  // admission here would refuse EVERY run (constraint 2). The child asks two questions
  // only: is the issue open, and are its trigger labels still on.
  const h = harness({ labels: [...TRIGGER_LABELS, "agent-working", "awaiting-human"] });
  const outcome = await h.run();

  ok("claimed: the run's own claim is not a refusal — the child never re-runs admission", outcome.precondition === undefined && outcome.status === "done", JSON.stringify(outcome));
}

{
  // An earlier run shipped and died before its outcome landed, or a human opened the PR.
  // Either way the branch's work is on the table already.
  const already = "https://github.com/acme/finance/pull/12";
  const h = harness({ openPr: already });
  const outcome = await h.run();

  ok("pr open: nothing is written, run or spent", spent(h.trace).length === 0, h.trace.join(" → "));
  ok("pr open: the outcome names the assertion, typed", outcome.precondition === "pull-request-open", JSON.stringify(outcome));
  ok(
    "pr open: the item is DONE — that PR already serves the issue, and `failed` would re-fork it on every reconcile",
    outcome.status === "done",
    JSON.stringify(outcome),
  );
  ok("pr open: the summary carries the PR a human should go and look at", outcome.summary.includes(already), outcome.summary);
}

{
  // The blocker this item was stacked on merged while the item waited, and GitHub deleted
  // its head branch: the base it was admitted onto is gone.
  const h = harness({ base: "feat/9", baseGone: true });
  const outcome = await h.run();

  ok("base gone: nothing is written, run or spent", spent(h.trace).length === 0, h.trace.join(" → "));
  ok("base gone: the outcome names the assertion, typed", outcome.precondition === "base-missing", JSON.stringify(outcome));
  ok("base gone: and the work item is failed", outcome.status === "failed", JSON.stringify(outcome));
  ok("base gone: the summary names the base that vanished", outcome.summary.includes("feat/9"), outcome.summary);
  ok(
    "base gone: the ORIGIN is what was asked, by branch name — a local `origin/feat/9` is only as fresh as a fetch this run never got to",
    h.remoteChecked.join(",") === "feat/9",
    h.remoteChecked.join(","),
  );
}

{
  // Boot built this repo's image hours ago and a `docker image prune` has taken it since.
  const h = harness({ imageMissing: true });
  const outcome = await h.run();

  ok("image gone: nothing is written, run or spent", spent(h.trace).length === 0, h.trace.join(" → "));
  ok("image gone: the outcome names the assertion, typed", outcome.precondition === "image-missing", JSON.stringify(outcome));
  ok("image gone: and the work item is failed", outcome.status === "failed", JSON.stringify(outcome));
  ok(
    "image gone: the summary names THIS repo's image — the fix is a rebuild of that one",
    outcome.summary.includes("sunday-finance") && h.imagesProbed.join(",") === "sunday-finance",
    `${outcome.summary} | ${h.imagesProbed.join(",")}`,
  );
}
{
  // Docker itself cannot answer. That is not a missing image — it is every repo's problem.
  const h = harness({ imageProbeError: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock" });
  const outcome = await h.run();

  ok(
    "docker down: an ordinary failed outcome carrying docker's own words, NOT `image-missing` — one stops the whole pipeline, the other stops one repo",
    outcome.precondition === undefined && outcome.status === "failed" && outcome.summary.includes("Cannot connect to the Docker daemon"),
    JSON.stringify(outcome),
  );
  ok("docker down: and the agent still never runs", !h.trace.includes("agent"), h.trace.join(" → "));
}

{
  // The human answered — and in the meantime somebody closed the issue. A resume is
  // subject to the same set as a fresh run.
  const h = harness({ resume: { sessionId: "sess-abc123", reply: "Keep the invoices." }, state: "closed" });
  const outcome = await h.run();

  ok("resume stopped: the outcome names the assertion", outcome.precondition === "issue-closed", JSON.stringify(outcome));
  ok(
    "resume stopped: `awaiting-human` is NOT removed — an item that lost the label and never ran is neither gated nor working",
    h.labelsRemoved.length === 0 && h.labelsAdded.length === 0,
    `${h.labelsRemoved.join(", ")} | ${h.labelsAdded.join(", ")}`,
  );
  ok(
    "resume stopped: the gated branch and its worktree survive — they are the only copy of the commits the gate was taken on",
    h.deleted.length === 0 && h.removedWorktrees.length === 0,
    h.trace.join(" → "),
  );
}
{
  const h = harness({ resume: { sessionId: "sess-abc123", reply: "Keep the invoices." } });
  await h.run();

  ok(
    "order: the whole before-work set is asked BEFORE the run's first write of any kind — the label edit, the exclude, the fetch and the agent all come after it",
    h.trace.lastIndexOf("imagePresent") < h.trace.indexOf("removeLabels") && h.trace.indexOf("removeLabels") < h.trace.indexOf("exclude"),
    h.trace.join(" → "),
  );
}

// ── the before-ship re-assertion (AC2): a whole agent run elapses between this run's
//    fetch and its push. The captured 2026-07-25 finance#57 race merged the base 25s
//    after that run's `fetch -p` and three minutes before its create ──
{
  const h = harness({ base: "feat/9", baseGoneAtShip: true });
  const outcome = await h.run();

  ok("ship: the run DID start — the base was there when it was asked the first time", h.trace.includes("agent"), h.trace.join(" → "));
  ok("ship: and then nothing ships — no push, no PR", h.pushed.length === 0 && h.created.length === 0, h.trace.join(" → "));
  ok(
    "ship: nothing is retargeted to main either — a stacked branch has to be REBASED onto its new base before it can target it (ADR-0003), which is #43's machinery",
    h.created.length === 0,
    JSON.stringify(h.created),
  );
  ok("ship: the outcome carries the same typed reason the before-work set uses", outcome.precondition === "base-missing" && outcome.status === "failed", JSON.stringify(outcome));
  ok(
    "ship: the origin was asked TWICE — once before the run, once after the agent came back",
    h.remoteChecked.join(",") === "feat/9,feat/9" && h.trace.lastIndexOf("remoteBranchExists") > h.trace.indexOf("agent"),
    `${h.remoteChecked.join(",")} | ${h.trace.join(" → ")}`,
  );
  ok("ship: the run still cleans up after itself", h.deleted.includes("feat/57"), h.trace.join(" → "));
}
{
  const h = harness();
  await h.run();
  ok(
    "ship: the re-assertion sits immediately before the push — asked any earlier it is the same stale answer the fetch already gave",
    h.trace.indexOf("push") - h.trace.lastIndexOf("remoteBranchExists") === 1,
    h.trace.join(" → "),
  );
}

console.log(fails === 0 ? "\nAll issue-run smokes pass." : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
