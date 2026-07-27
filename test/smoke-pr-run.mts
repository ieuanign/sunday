// test/smoke-pr-run.mts — hermetic smoke for what one PR-COMMENT run DECIDES (V2, issue
// #44). It drives the real PrModule over the real Logger with the four things that reach
// the world substituted — the agent (quota), GitHub (real writes to a real repo), git (a
// checkout on disk) and the image probe (docker) — so what is asserted is which comments
// a run answers, whether it pushes, and what it posts back.
//   devbox run node test/smoke-pr-run.mts
// The module touches no filesystem of its own, so this case needs no temp dir at all.
// $0, offline, no docker, no network, no tokens.

import { sundayComment, sundayReply, SUNDAY_REPLY_MARKER } from "../lib/markers.mts";
import { PrModule, type PrRunInput } from "../pr/index.mts";
import { RESULT_TAG, type PrResult } from "../pr/prompt.mts";
import type { Agent, AgentRunRequest, AgentRunResult } from "../services/agent/index.mts";
import type { Git } from "../services/git.mts";
import type { GitHubPrRun, IssueComment, ReviewComment } from "../services/github/index.mts";
import { Logger, type Destinations, type LogLine } from "../services/logger.mts";

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : `\n    ${detail}`}`);
};

/** A baseline prompt with the three placeholders the composer must substitute. */
const BASELINE = `Answer the comments on {{REPO}} PR #{{PR}} (base {{BASE}}). Finish with one <${RESULT_TAG}> result.`;
const HEAD = "feat/57";
const BASE = "main";
/** What `origin/<head>` resolves to when the run starts — the SHA the agent is handed and
 *  the one its commits are counted against (constraint 9). */
const START_SHA = "9c1f0b2e4d6a8c0e2f4a6b8d0c2e4f6a8b0d2c4e";

/** What this case's fakes answer with. Everything else is the ordinary happy path: an
 *  open PR, one unanswered conversation summon, an agent that replies to it, and a
 *  branch one commit ahead of where the run started. */
interface Scenario {
  /** The PR's state as the run reads it, lowercased. Anything but `open` must not ship. */
  state?: string;
  /** The PR closes (or merges) WHILE the agent works — the whole reason the state is read
   *  again immediately before the push (#38). */
  closedAtShip?: boolean;
  /** The conversation timeline, oldest first. */
  conversation?: IssueComment[];
  /** The inline review comments, oldest first. */
  inline?: ReviewComment[];
  /** What the agent answers with. */
  result?: PrResult;
  /** The agent throws instead of answering. */
  agentError?: string;
  /** Commits the agent added on top of the SHA the run started from. */
  ahead?: number;
  /** This repo's sandbox image is not on the host — pruned since boot built it. */
  imageMissing?: boolean;
  /** The agent left the worktree dirty and the library kept it host-side. */
  preservedWorktreePath?: string;
  /** This run is #39's one retry, carrying what the previous attempt died on. */
  retryError?: string;
}

/** One unanswered conversation summon, which is what the default scenario answers. */
const SUMMON: IssueComment = { id: 11, body: "@sunday the retry never backs off" };

/** A real PrModule over the real Logger, with the four world-reaching services stood in
 *  for. Returns the call trace (order is load-bearing) alongside what each fake was
 *  handed. */
function harness(s: Scenario = {}) {
  /** Every service call, in the order it happened. */
  const trace: string[] = [];
  const lines: LogLine[] = [];
  const dests: Destinations = {
    console: () => {},
    runLog: (line) => void lines.push(line),
    eventLog: () => {},
    github: () => {},
    phone: () => {},
  };

  const requests: AgentRunRequest<PrResult>[] = [];
  /** Which side of the agent run a seam is being asked on — the whole point of reading
   *  the PR again is that it can close while the agent works. */
  let agentRan = false;
  const agent: Agent = {
    // The trailing comma is not a typo: `<T>` alone is reserved syntax in a `.mts` file.
    run: async <T,>(request: AgentRunRequest<T>): Promise<AgentRunResult<T>> => {
      trace.push("agent");
      agentRan = true;
      requests.push(request as unknown as AgentRunRequest<PrResult>);
      if (s.agentError) throw new Error(s.agentError);
      return {
        output: (s.result ?? {
          summary: "backed the retry off",
          replies: [{ comment: SUMMON.id, fixed: true, body: "Added exponential backoff." }],
        }) as unknown as T,
        commits: [],
        preservedWorktreePath: s.preservedWorktreePath,
        durationMs: 1,
        logPath: request.logPath,
      };
    },
  };

  /** Every reply that reached GitHub: an inline one keyed by the comment it threads
   *  under, a conversation one by `pr`. */
  const posted: { to: number | "pr"; body: string }[] = [];
  const github: GitHubPrRun = {
    readPr: async () => {
      trace.push("readPr");
      return { head: HEAD, base: BASE, state: agentRan && s.closedAtShip ? "merged" : (s.state ?? "open") };
    },
    issueComments: async () => {
      trace.push("issueComments");
      return s.conversation ?? [SUMMON];
    },
    reviewComments: async () => {
      trace.push("reviewComments");
      return s.inline ?? [];
    },
    replyToReviewComment: async (_repo, _pr, comment, body) => {
      trace.push("replyToReviewComment");
      posted.push({ to: comment, body });
    },
    commentOnPr: async (_repo, _pr, body) => {
      trace.push("commentOnPr");
      posted.push({ to: "pr", body });
    },
  };

  const pushed: string[] = [];
  const deleted: string[] = [];
  const removedWorktrees: string[] = [];
  const counted: string[] = [];
  const resolved: string[] = [];
  const git: Git = {
    remoteBranchExists: async () => true,
    excludeScratch: async () => {},
    fetchPrune: async () => void trace.push("fetch"),
    resolveRef: async (_dir, ref) => {
      trace.push("resolveRef");
      resolved.push(ref);
      return START_SHA;
    },
    push: async (_dir, branch) => {
      trace.push("push");
      pushed.push(branch);
    },
    aheadCount: async (_dir, baseRef, branch) => {
      trace.push("aheadCount");
      counted.push(`${baseRef}..${branch}`);
      return s.ahead ?? 1;
    },
    diffStat: async () => ({ files: 0, insertions: 0, deletions: 0 }),
    removeWorktree: async (_dir, path) => {
      trace.push("removeWorktree");
      removedWorktrees.push(path);
    },
    deleteBranch: async (_dir, branch) => {
      trace.push("deleteBranch");
      deleted.push(branch);
    },
  };

  const imagesProbed: string[] = [];
  const imagePresent = async (imageName: string): Promise<boolean> => {
    trace.push("imagePresent");
    imagesProbed.push(imageName);
    return !s.imageMissing;
  };

  const input: PrRunInput = {
    key: "acme/finance#pr12",
    repo: "acme/finance",
    pr: 12,
    childDir: "/repos/finance",
    imageName: "sunday-finance",
    baselinePrompt: BASELINE,
    logPath: "/var/log/acme/finance/pr-12/run.log",
    ...(s.retryError ? { retryError: s.retryError } : {}),
  };

  const module = new PrModule({ agent, github, git, imagePresent, log: new Logger(dests).child("pr") });
  return {
    run: () => module.run(input),
    trace,
    lines,
    requests,
    posted,
    pushed,
    deleted,
    removedWorktrees,
    counted,
    resolved,
    imagesProbed,
  };
}

// ── nothing to answer: the summon on this PR already carries a reply of ours, so the
//    next pass over it must cost nothing at all — not an agent run, not a checkout ──
{
  const h = harness({
    conversation: [SUMMON, { id: 12, body: sundayReply("Added exponential backoff.") }],
  });
  const outcome = await h.run();

  ok("answered: no agent runs", !h.trace.includes("agent"), h.trace.join(" → "));
  ok("answered: the checkout is never touched", !h.trace.includes("fetch"), h.trace.join(" → "));
  ok("answered: the work item is done, not failed", outcome.status === "done", `${outcome.status}: ${outcome.summary}`);
  ok("answered: it is keyed back with the PR's own key", outcome.key === "acme/finance#pr12", outcome.key);
}

// ── what reaches the agent: the summons neither stream has answered, each with the id it
//    must echo back, and the inline ones with the file line to open before judging ──
{
  const h = harness({
    conversation: [
      { id: 5, body: "@sunday the retry never backs off" },
      { id: 6, body: sundayReply("Added exponential backoff.") },
      { id: 7, body: sundayComment("▶ started — PR-comment run") },
      { id: 8, body: "@sunday and the timeout is still 30s" },
    ],
    // A separate id space: 3 is OLDER than the conversation's newest reply and still
    // unanswered here, because no reply of ours has ever landed on this stream.
    inline: [{ id: 3, body: "@sunday this cast is unchecked", path: "lib/parse.mts", line: 42 }],
  });
  await h.run();

  const prompt = h.requests[0]?.prompt ?? "";
  ok("gather: the unanswered conversation summon is in the prompt", prompt.includes("the timeout is still 30s"), prompt);
  ok("gather: the unanswered inline summon is in the prompt", prompt.includes("this cast is unchecked"), prompt);
  ok("gather: a summon our reply already answered is NOT", !prompt.includes("the retry never backs off"), prompt);
  ok("gather: a milestone comment of ours is not a summon", !prompt.includes("started — PR-comment run"), prompt);
  ok("gather: each comment carries the id the agent replies against", prompt.includes("comment 8") && prompt.includes("comment 3"), prompt);
  ok("gather: an inline comment carries its file and line", prompt.includes("lib/parse.mts:42"), prompt);
  ok("gather: the baseline's placeholders are filled", prompt.includes("acme/finance PR #12 (base main)"), prompt.slice(0, 200));
}

// ── the replies: one per GATHERED comment, never one per reply the agent happened to
//    write. An unanswered one still ends up older than the replies that did land, so the
//    watermark would call it answered — a human's request dropped in silence ──
{
  const h = harness({
    conversation: [{ id: 8, body: "@sunday the timeout is still 30s\nand it retries forever" }],
    inline: [{ id: 3, body: "@sunday this cast is unchecked", path: "lib/parse.mts", line: 42 }],
    result: {
      summary: "checked the cast",
      // The conversation comment is OMITTED — the agent answered one of the two.
      replies: [{ comment: 3, fixed: true, body: "Narrowed it with a type guard." }],
    },
  });
  await h.run();

  const inline = h.posted.find((p) => p.to === 3);
  const conversation = h.posted.find((p) => p.to === "pr");
  ok("reply: every gathered comment is answered, none omitted", h.posted.length === 2, JSON.stringify(h.posted));
  ok("reply: the inline one threads under the comment it answers", inline?.body.includes("Narrowed it with a type guard.") === true, inline?.body ?? "");
  ok("reply: it carries the marker that makes it an ANSWER", inline?.body.includes(SUNDAY_REPLY_MARKER) === true, inline?.body ?? "");
  ok("reply: the conversation one quotes the comment's first line", conversation?.body.includes("> @sunday the timeout is still 30s") === true, conversation?.body ?? "");
  ok("reply: it quotes the FIRST line only, not the whole comment", conversation?.body.includes("> and it retries forever") === false, conversation?.body ?? "");
  ok("reply: the comment the agent skipped is answered anyway", conversation?.body.includes(SUNDAY_REPLY_MARKER) === true, conversation?.body ?? "");
  ok("reply: and says so rather than inventing an answer", conversation?.body.includes("checked the cast") === true, conversation?.body ?? "");
}

// ── a PR that merged (or was closed) while the item queued: whatever the comments ask
//    for, there is nowhere to ship it and nobody re-derives a closed PR ──
{
  const h = harness({ state: "merged" });
  const outcome = await h.run();

  ok("closed: no agent runs", !h.trace.includes("agent"), h.trace.join(" → "));
  ok("closed: nothing is pushed", h.pushed.length === 0, h.pushed.join(", "));
  ok("closed: nothing is posted back", h.posted.length === 0, JSON.stringify(h.posted));
  ok("closed: the work item is done, not failed", outcome.status === "done", `${outcome.status}: ${outcome.summary}`);
  ok("closed: the summary says which state stopped it", outcome.summary.includes("merged"), outcome.summary);
}

// ── the PR merges WHILE the agent works — the window #38 exists for. The commits are
//    real and the human's questions still deserve answers; the push does not happen ──
{
  const h = harness({ closedAtShip: true });
  const outcome = await h.run();

  ok("closed mid-run: the agent ran", h.trace.includes("agent"), h.trace.join(" → "));
  ok("closed mid-run: nothing is pushed into it", h.pushed.length === 0, h.pushed.join(", "));
  ok("closed mid-run: the human still gets an answer", h.posted.length === 1, JSON.stringify(h.posted));
  ok("closed mid-run: the state is read again after the agent", h.trace.filter((c) => c === "readPr").length === 2, h.trace.join(" → "));
  ok("closed mid-run: and the run says nothing shipped", outcome.summary.includes("nothing was pushed"), outcome.summary);
}

// ── GIT decides whether anything is pushed, never the agent's word for it: the result
//    carries no `committed` flag to be wrong about ──
{
  const h = harness();
  await h.run();

  ok("push: the head branch is pushed exactly once", h.pushed.length === 1 && h.pushed[0] === HEAD, h.pushed.join(", "));
  ok("push: counted against the SHA the run started from", h.counted[0] === `${START_SHA}..${HEAD}`, h.counted.join(", "));
  ok("push: the branch is dropped BEFORE the run so the agent cannot work on a stale one", h.trace.indexOf("deleteBranch") < h.trace.indexOf("fetch"), h.trace.join(" → "));
  ok("push: and the agent starts from the origin's tip", h.resolved[0] === `origin/${HEAD}`, h.resolved.join(", "));
  ok("push: the branch is dropped again once the origin has it", h.deleted.length === 2, h.deleted.join(", "));
  ok("push: the trailing drop is the last thing the run does", h.trace[h.trace.length - 1] === "deleteBranch", h.trace.join(" → "));
}

// ── the agent judged every comment a won't-fix and committed nothing. There is nothing
//    to push, and the replies explaining why are the whole point of the run ──
{
  const h = harness({ ahead: 0 });
  const outcome = await h.run();

  ok("no commits: nothing is pushed", h.pushed.length === 0, h.pushed.join(", "));
  ok("no commits: the human still gets the answer", h.posted.length === 1, JSON.stringify(h.posted));
  ok("no commits: it is a done work item, not a failure", outcome.status === "done", `${outcome.status}: ${outcome.summary}`);
}

// ── this repo's image was pruned since boot built it. The agent library would report
//    that as an obscure container error, so the run names it before it spends anything —
//    typed, because the parent stops the whole repo on it rather than retrying one item ──
{
  const h = harness({ imageMissing: true });
  const outcome = await h.run();

  ok("image: the probe was asked", h.imagesProbed[0] === "sunday-finance", h.imagesProbed.join(", "));
  ok("image: no agent runs", !h.trace.includes("agent"), h.trace.join(" → "));
  ok("image: the checkout is never touched", !h.trace.includes("fetch"), h.trace.join(" → "));
  ok("image: nothing is posted back", h.posted.length === 0, JSON.stringify(h.posted));
  ok("image: it fails with the typed reason", outcome.precondition === "image-missing", String(outcome.precondition));
  ok("image: as a failed work item", outcome.status === "failed", outcome.status);
  ok("image: naming the image a human has to rebuild", outcome.summary.includes("sunday-finance"), outcome.summary);
}

// ── the agent blows up. NOTHING escapes the run: a throw would leave the parent an exit
//    code and the work item recorded as a dead child rather than the failure it was ──
{
  const h = harness({ agentError: "container exited 137" });
  const outcome = await h.run();

  ok("failure: it is a failed outcome, not a throw", outcome.status === "failed", outcome.status);
  ok("failure: carrying the agent's OWN message, which #39 classifies on", outcome.summary === "container exited 137", outcome.summary);
  ok("failure: nothing is pushed", h.pushed.length === 0, h.pushed.join(", "));
  ok("failure: nothing is posted back", h.posted.length === 0, JSON.stringify(h.posted));
  ok("failure: the checkout is still left clean", h.deleted.length === 2, h.deleted.join(", "));
}

// ── the agent left the worktree dirty and the library kept it host-side. It holds the
//    branch checked out, so it goes before the delete or the delete cannot run ──
{
  const h = harness({ preservedWorktreePath: "/repos/finance/.worktrees/feat-57" });
  await h.run();

  ok("dirty: the preserved worktree is removed", h.removedWorktrees[0] === "/repos/finance/.worktrees/feat-57", h.removedWorktrees.join(", "));
  ok("dirty: before the branch it holds checked out", h.trace.lastIndexOf("removeWorktree") < h.trace.lastIndexOf("deleteBranch"), h.trace.join(" → "));
}

// ── #39's ONE retry: the previous attempt's error is the only thing this run knows that
//    the last one did not, and without it the retry is the same run again on fresh quota ──
{
  const h = harness({ retryError: "rebase left a conflict in lib/parse.mts" });
  await h.run();

  const prompt = h.requests[0]?.prompt ?? "";
  ok("retry: the previous failure reaches the agent", prompt.includes("rebase left a conflict in lib/parse.mts"), prompt);
  ok("retry: marked as the previous run's, not as one more thing a human asked for", prompt.includes("The previous attempt at these comments failed"), prompt);
  ok("retry: and it comes AFTER the comments", prompt.indexOf("the retry never backs off") < prompt.indexOf("rebase left a conflict"), prompt);
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
