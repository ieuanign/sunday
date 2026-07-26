// issue/index.mts — one issue run's DECISIONS: compose the prompt, run the agent in the
// credential-free sandbox, and act on the signal it comes back with. The sandbox decides;
// this host performs every write to GitHub (CONTEXT.md).
//
// A class over injected services and NOTHING else: no path resolution, no file reads, no
// service construction. That is what lets a smoke drive the real thing with a fake agent,
// GitHub and git — no docker, no network, no quota — which is the only way any of this is
// checkable at all.

import type { Outcome } from "#lib/outcome.mts";
import type { Agent, AgentRunResult } from "#services/agent/index.mts";
import type { DiffStat, Git } from "#services/git.mts";
import type { GitHubRun } from "#services/github/index.mts";
import type { LogContext, ModuleLogger } from "#services/logger.mts";
import { composeBody } from "./body.mts";
import { freshPrompt, RESULT_TAG, resultSchema, resumePrompt, type IssueResult } from "./prompt.mts";

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The label that says this run stopped to ask, and the item is the human's now. */
const AWAITING_HUMAN = "awaiting-human";

/** One issue run, fully resolved. Every path is absolute and every file already read: the
 *  entry point (`issue/run.mts`) resolves them from the Job, so nothing in here derives a
 *  path or opens a file. */
export interface IssueRunInput {
  /** The work-item key (`<owner>/<repo>#<issue>`) the outcome is named back with, and
   *  what the agent's per-run floor dir is named for. */
  key: string;
  /** `<owner>/<repo>`, from the routing table. */
  repo: string;
  issue: number;
  /** The child checkout this run happens against, absolute. */
  childDir: string;
  /** The branch this run bases on and its PR targets — `main`, or `feat/<blocker>` when
   *  the Assignor stacked this item on a blocker whose PR is already open (#42). The
   *  ASSIGNOR decided it and this run recomputes none of it (constraint 8); re-asserting
   *  that a stacked base still exists before shipping is #38's. */
  base: string;
  /** The pre-built sandbox image for this repo. */
  imageName: string;
  /** The repo's baseline prompt, already read — its `{{REPO}}`/`{{ISSUE}}` placeholders
   *  are filled here. */
  baselinePrompt: string;
  /** This run's own log. The agent library appends its raw output to the same file, so
   *  the run reads back in one place. */
  logPath: string;
  /** Continue the session a previous run gated on, with the human's answer. */
  resume?: { sessionId: string; reply: string };
}

/** Everything a run reaches the world through, and constructs none of. */
export interface IssueModuleDeps {
  agent: Agent;
  github: GitHubRun;
  git: Git;
  log: ModuleLogger;
}

export class IssueModule {
  // Declared, not parameter properties: Node runs `.mts` in strip-only mode, which
  // rejects `constructor(private x)`.
  private readonly agent: Agent;
  private readonly github: GitHubRun;
  private readonly git: Git;
  private readonly log: ModuleLogger;

  constructor(deps: IssueModuleDeps) {
    this.agent = deps.agent;
    this.github = deps.github;
    this.git = deps.git;
    this.log = deps.log;
  }

  /** Run one issue to a pull request. */
  async run(input: IssueRunInput): Promise<Outcome> {
    const about = { repo: input.repo, target: input.issue };
    const branch = `feat/${input.issue}`;
    /** A host path, when the agent left the worktree dirty and the library kept it. */
    let preserved: string | undefined;
    /** A gate keeps its branch and its worktree: they are the only copy of the commits it
     *  made, and the resume continues from them. */
    let gated = false;

    try {
      // Read on every run, fresh or resumed: the PR a resume finally opens is titled from
      // the issue, and the gate that came before it opened none.
      const detail = await this.github.readIssue(input.repo, input.issue);
      if (input.resume) {
        // Straight away, not at the end: from here on the item is working, not waiting on
        // anybody. The resuming child does this itself so the Assignor's GitHub seam stays
        // the two writes it takes.
        await this.github.removeLabels(input.repo, input.issue, [AWAITING_HUMAN]);
      }
      // The floor's sub-agents write inside the worktree; excluded, or the library
      // preserves the dirty worktree and cleanup cannot delete the branch. Idempotent,
      // so every run — including children onboarded before this existed.
      await this.git.excludeScratch(input.childDir);
      // The base as the origin has it NOW — the agent branches off the freshly-fetched ref.
      await this.git.fetchPrune(input.childDir);

      const result = await this.agent.run<IssueResult>({
        key: input.key,
        repo: { fullName: input.repo, childDir: input.childDir, imageName: input.imageName },
        prompt: input.resume
          ? resumePrompt(input.resume.reply)
          : freshPrompt(input.baselinePrompt, input.repo, input.issue, detail.title, detail.body),
        branch,
        // RESOLVED, never a bare branch name: handed one, the library prefers a stale
        // local branch over the origin's (#33's contract).
        startPoint: `origin/${input.base}`,
        logPath: input.logPath,
        output: { tag: RESULT_TAG, schema: resultSchema },
        ...(input.resume ? { resumeSession: input.resume.sessionId } : {}),
      });
      preserved = result.preservedWorktreePath;

      const { signal, description, question } = result.output;
      if (signal === "gate") {
        gated = true;
        await this.github.addLabels(input.repo, input.issue, [AWAITING_HUMAN]);
        this.log.info("gate — asked the human, awaiting-human", about);
        // The question travels as the SUMMARY: the parent's outcome milestone posts it as
        // the one comment this work item gets, and it reaches the human even if the parent
        // dies before it can. The handle travels with it or the answer starts over from
        // nothing — the child holding the session is gone by the time anyone reads this.
        return this.outcome(input.key, "awaiting-human", question ?? description, result.sessionId);
      }

      // Asked of git rather than taken from the agent's own commit list: on a resume the
      // commits that matter were made by the run that gated, and this run may add none.
      const ahead = await this.git.aheadCount(input.childDir, `origin/${input.base}`, branch);
      if (ahead === 0) {
        // An honest nothing-to-ship, not a crash — and not a success either: whatever the
        // agent signalled, no work reached the origin.
        this.log.info(`${signal} — no commits ahead of ${input.base}, nothing to ship`, about);
        return this.outcome(input.key, "failed", `${description}\n\nsignal ${signal}, but no commits — nothing to ship.`);
      }
      await this.git.push(input.childDir, branch);
      const draft = signal !== "ready";
      const url = await this.openPr(input, branch, detail.title, result, ahead, draft);
      this.log.info(`${signal} — ${draft ? "draft " : ""}PR ${url}`, about);
      // A `fail` that shipped a draft is still a FAILED work item: the PR is there for a
      // human to read, not because the run succeeded. Classifying it (and the
      // `agent-failed` label) is #39's.
      return this.outcome(
        input.key,
        signal === "fail" ? "failed" : "done",
        `${description}\n\n${draft ? "draft " : ""}PR: ${url}`,
      );
    } catch (err) {
      // NOTHING escapes this method. The child's whole job is to leave exactly one durable
      // outcome behind (ADR-0001) — a throw here leaves the parent an exit code, and the
      // work item is recorded as a dead child rather than as the failure it actually was.
      // The message is the agent's or the tool's own, because #39 classifies on that text.
      const failure = describe(err);
      this.log.info(`failed — ${failure}`, about);
      return this.outcome(input.key, "failed", failure);
    } finally {
      if (!gated) await this.cleanup(input, branch, preserved, about);
    }
  }

  /** Drop what this run left on the child checkout: the origin holds any history worth
   *  keeping, and a branch left behind is the next run's stale local base.
   *
   *  Never throws — it runs in a `finally`, and a `finally` that throws REPLACES the
   *  outcome being returned, which would lose a pull request that really was opened. */
  private async cleanup(
    input: IssueRunInput,
    branch: string,
    preserved: string | undefined,
    about: LogContext,
  ): Promise<void> {
    try {
      // FIRST: a preserved worktree holds the branch checked out, so the delete below
      // cannot run while it is there.
      if (preserved) await this.git.removeWorktree(input.childDir, preserved);
      await this.git.deleteBranch(input.childDir, branch);
    } catch (err) {
      // `info`, like everything else this child says: the run itself is decided, and an
      // `error` here would post a third comment on the issue for a leftover branch.
      this.log.info(`cleanup left something behind — ${describe(err)}`, about);
    }
  }

  /** The PR this run ships behind, opened or ADOPTED. A retried run whose first attempt
   *  already opened one must not die on "a pull request already exists" — that turns a
   *  recoverable GitHub blip into a human-only stop. */
  private async openPr(
    input: IssueRunInput,
    branch: string,
    title: string,
    result: AgentRunResult<IssueResult>,
    commits: number,
    draft: boolean,
  ): Promise<string> {
    const open = await this.github.openPrForHead(input.repo, branch);
    // An adopted PR keeps the body it was opened with, so nothing below is worth
    // measuring for it.
    if (open) return open;
    const stat = await this.fileStat(input, branch);
    return await this.github.createPr({
      repo: input.repo,
      base: input.base,
      head: branch,
      title,
      // Composed, never concatenated here: the closing keyword, the defusing of the
      // agent's prose and the not-provided sections are one pure function's invariants
      // (`issue/body.mts`), and this class reads no file and resolves no path.
      body: composeBody(result.output, {
        issue: input.issue,
        base: input.base,
        // What GIT counted, not `result.commits`: on a gate resume the agent's own list
        // names only the resuming session's commits.
        commits,
        durationMs: result.durationMs,
        logPath: result.logPath,
        // Only the agent adapter knows what it ran on — nothing out here may read
        // `MODEL`, so an agent that cannot say leaves the footer saying so.
        model: result.model,
        stat,
      }),
      draft,
    });
  }

  /** What the branch changed, for the footer — or nothing. BEST-EFFORT on purpose: this
   *  runs after the push, so a `git` blip here would turn a pushed branch into a failed
   *  work item (ADR-0001). The footer degrades that one fact instead, and says so. */
  private async fileStat(input: IssueRunInput, branch: string): Promise<DiffStat | undefined> {
    try {
      return await this.git.diffStat(input.childDir, `origin/${input.base}`, branch);
    } catch (err) {
      this.log.info(`file stats unavailable — ${describe(err)}`, { repo: input.repo, target: input.issue });
      return undefined;
    }
  }

  /** One durable answer for the parent to apply. */
  private outcome(key: string, status: Outcome["status"], summary: string, sessionId?: string): Outcome {
    return { key, status, summary, finishedAt: new Date().toISOString(), ...(sessionId ? { sessionId } : {}) };
  }
}
