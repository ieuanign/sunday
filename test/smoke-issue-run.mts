// test/smoke-issue-run.mts — hermetic smoke for the thing one issue run DECIDES (V2,
// issue #36). It drives the real IssueModule over the real Logger with the three things
// that reach the world substituted — the agent (quota), GitHub (real writes to a real
// repo) and git (a checkout on disk) — so what is asserted is what a run decides from an
// agent's signal, not how the commands are built.
//   devbox run node test/smoke-issue-run.mts
// The module touches no filesystem of its own, so this case needs no temp dir at all.
// $0, offline, no docker, no network, no tokens.

import { IssueModule, type IssueRunInput } from "../issue/index.mts";
import { RESULT_TAG, type IssueResult } from "../issue/prompt.mts";
import type { Agent, AgentRunRequest, AgentRunResult } from "../services/agent/index.mts";
import type { Git } from "../services/git.mts";
import type { GitHubRun, NewPullRequest } from "../services/github/index.mts";
import { Logger, type Destinations, type LogLine } from "../services/logger.mts";

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

/** What this case's fakes answer with. Everything else is the ordinary happy path: an
 *  agent that says `ready`, a branch one commit ahead, and no PR open yet. */
interface Scenario {
  result?: IssueResult;
  /** The agent fails instead of answering. */
  agentError?: string;
  /** Reading the issue fails — a seam throwing before there is any signal to act on. */
  readIssueError?: string;
  /** Commits on the run's branch that the base does not have. */
  ahead?: number;
  /** A PR already open for this head — the retry case. */
  openPr?: string;
  sessionId?: string;
  preservedWorktreePath?: string;
  resume?: { sessionId: string; reply: string };
  /** Cleanup blows up (a `git` that threw with its own stderr). */
  cleanupError?: string;
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
  const agent: Agent = {
    // The trailing comma is not a typo: `<T>` alone is reserved syntax in a `.mts` file.
    run: async <T,>(request: AgentRunRequest<T>): Promise<AgentRunResult<T>> => {
      trace.push("agent");
      requests.push(request as unknown as AgentRunRequest<IssueResult>);
      if (s.agentError) throw new Error(s.agentError);
      return {
        output: (s.result ?? { signal: "ready", description: "shipped it" }) as unknown as T,
        sessionId: s.sessionId,
        commits: [],
        preservedWorktreePath: s.preservedWorktreePath,
        durationMs: 1,
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
      return { title: TITLE, body: BODY };
    },
    addLabels: async (_repo, _issue, labels) => {
      trace.push("addLabels");
      labelsAdded.push(...labels);
    },
    removeLabels: async (_repo, _issue, labels) => {
      trace.push("removeLabels");
      labelsRemoved.push(...labels);
    },
    openPrForHead: async () => s.openPr,
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
  const git: Git = {
    excludeScratch: async () => void trace.push("exclude"),
    fetchPrune: async () => void trace.push("fetch"),
    push: async (_dir, branch) => {
      trace.push("push");
      pushed.push(branch);
    },
    aheadCount: async (_dir, baseRef, branch) => {
      counted.push(`${baseRef}..${branch}`);
      return s.ahead ?? 1;
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

  const input: IssueRunInput = {
    key: "acme/finance#57",
    repo: "acme/finance",
    issue: 57,
    childDir: "/repos/finance",
    imageName: "sunday-finance",
    baselinePrompt: BASELINE,
    logPath: "/var/log/acme/finance/57/run.log",
    ...(s.resume ? { resume: s.resume } : {}),
  };

  const module = new IssueModule({ agent, github, git, log: new Logger(dests).child("issue") });
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
    "nothing to ship: counted against the freshly-fetched remote ref, not a stale local one",
    h.counted.length === 1 && h.counted[0] === "origin/main..feat/57",
    h.counted.join(", "),
  );
}

// ── a retried run whose first attempt already opened the PR adopts it (AC6) ──
{
  const already = "https://github.com/acme/finance/pull/12";
  const h = harness({ openPr: already });
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
    request?.startPoint === "origin/main",
    request?.startPoint ?? "",
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
    "log: every line the child emits is addressed to its issue, and none of them reaches GitHub",
    h.lines.length > 0 && h.lines.every((l) => l.level === "info" && l.context.repo === "acme/finance" && l.context.target === 57),
    h.lines.map((l) => `${l.level} ${JSON.stringify(l.context)}`).join(" | "),
  );
}

console.log(fails === 0 ? "\nAll issue-run smokes pass." : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
