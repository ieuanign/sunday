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
import { AWAITING_HUMAN_LABEL, type GitHubRun } from "#services/github/index.mts";
import type { LogContext, ModuleLogger } from "#services/logger.mts";
import { composeBody } from "./body.mts";
import { beforeShip, beforeWork, type ImagePresent } from "./preconditions.mts";
import { freshPrompt, RESULT_TAG, resultSchema, resumePrompt, type IssueResult } from "./prompt.mts";

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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
  /** The labels this repo admits an issue on, from the routing table. The run asserts
   *  they are all STILL on the issue before it starts (#38): a human who pulls one while
   *  the item waits in the queue is taking it back, and an agent started anyway spends
   *  real quota on work nobody asked for any more. */
  triggerLabels: string[];
  /** The repo's baseline prompt, already read — its `{{REPO}}`/`{{ISSUE}}` placeholders
   *  are filled here. */
  baselinePrompt: string;
  /** This run's own log. The agent library appends its raw output to the same file, so
   *  the run reads back in one place. */
  logPath: string;
  /** Continue the session a previous run gated on, with the human's answer. */
  resume?: { sessionId: string; reply: string };
  /** What the PREVIOUS attempt at this item died on, when this run is #39's one retry.
   *  Handed to the agent in the prompt: it is the only thing this run knows that the last
   *  one did not, and without it a retry is the same run again on fresh quota. */
  retryError?: string;
}

/** Everything a run reaches the world through, and constructs none of. */
export interface IssueModuleDeps {
  agent: Agent;
  github: GitHubRun;
  git: Git;
  /** Is this repo's image on the host? A plain injected function rather than the sandbox
   *  service: nothing in `issue/` may import that library, and a check that constructed
   *  its own probe could not be driven without docker (#34 constraint 7). */
  imagePresent: ImagePresent;
  log: ModuleLogger;
}

export class IssueModule {
  // Declared, not parameter properties: Node runs `.mts` in strip-only mode, which
  // rejects `constructor(private x)`.
  private readonly agent: Agent;
  private readonly github: GitHubRun;
  private readonly git: Git;
  private readonly imagePresent: ImagePresent;
  private readonly log: ModuleLogger;

  constructor(deps: IssueModuleDeps) {
    this.agent = deps.agent;
    this.github = deps.github;
    this.git = deps.git;
    this.imagePresent = deps.imagePresent;
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
    /** The commit THIS run created its branch at, once it has one. Undefined on a resume
     *  all the way through: the branch already exists, so the agent library ignores the
     *  start point it is handed and this run forks from nothing — reporting a re-resolved
     *  base there would overwrite the real fork point with wherever the base has moved to
     *  (ADR-0003). */
    let forkPoint: string | undefined;
    /** A before-work assertion stopped this run: it made no branch and no worktree, so
     *  the cleanup below has nothing to drop — and an item that must not start must not
     *  spend even two `git` calls on a checkout it never touched (constraint 1). */
    let stopped = false;

    try {
      // Read on every run, fresh or resumed: the PR a resume finally opens is titled from
      // the issue, and the gate that came before it opened none.
      const detail = await this.github.readIssue(input.repo, input.issue);
      // HERE — after the read the run already performs, and before its first write of any
      // kind (#38 constraint 1). A resume is subject to the same set: one that stripped
      // `awaiting-human` first would leave the item neither gated nor running.
      const refused = await beforeWork(
        { github: this.github, git: this.git, imagePresent: this.imagePresent },
        input,
        branch,
        detail,
      );
      if (refused) {
        stopped = true;
        this.log.info(`stopped — ${refused.summary}`, about);
        return this.outcome(refused);
      }
      if (input.resume) {
        // Straight away, not at the end: from here on the item is working, not waiting on
        // anybody. The resuming child does this itself so the Assignor's GitHub seam stays
        // the two writes it takes.
        await this.github.removeLabels(input.repo, input.issue, [AWAITING_HUMAN_LABEL]);
      }
      // The floor's sub-agents write inside the worktree; excluded, or the library
      // preserves the dirty worktree and cleanup cannot delete the branch. Idempotent,
      // so every run — including children onboarded before this existed.
      await this.git.excludeScratch(input.childDir);
      // The base as the origin has it NOW — the agent branches off the freshly-fetched ref.
      await this.git.fetchPrune(input.childDir);
      // …resolved to the COMMIT it names, after the fetch and before the agent: the
      // library creates the branch at exactly this, so handing over the SHA makes the
      // fork point recorded below true by construction rather than by argument. A base
      // that no longer resolves (a blocker merged and its branch deleted since admission)
      // throws here, which is one failed work item — not an agent started from nowhere.
      const startPoint = await this.git.resolveRef(input.childDir, `origin/${input.base}`);
      if (!input.resume) forkPoint = startPoint;

      const result = await this.agent.run<IssueResult>({
        key: input.key,
        repo: { fullName: input.repo, childDir: input.childDir, imageName: input.imageName },
        prompt: input.resume
          ? resumePrompt(input.resume.reply)
          : freshPrompt(input.baselinePrompt, input.repo, input.issue, detail.title, detail.body, input.retryError),
        branch,
        // RESOLVED, never a bare branch name: handed one, the library prefers a stale
        // local branch over the origin's (#33's contract).
        startPoint,
        logPath: input.logPath,
        output: { tag: RESULT_TAG, schema: resultSchema },
        ...(input.resume ? { resumeSession: input.resume.sessionId } : {}),
      });
      preserved = result.preservedWorktreePath;

      const { signal, description, question } = result.output;
      if (signal === "gate") {
        gated = true;
        await this.github.addLabels(input.repo, input.issue, [AWAITING_HUMAN_LABEL]);
        this.log.info("gate — asked the human, awaiting-human", about);
        // The question travels as the SUMMARY: the parent's outcome milestone posts it as
        // the one comment this work item gets, and it reaches the human even if the parent
        // dies before it can. The handle travels with it or the answer starts over from
        // nothing — the child holding the session is gone by the time anyone reads this.
        return this.outcome({
          key: input.key,
          status: "awaiting-human",
          summary: question ?? description,
          sessionId: result.sessionId,
          forkPoint,
        });
      }

      // Asked of git rather than taken from the agent's own commit list: on a resume the
      // commits that matter were made by the run that gated, and this run may add none.
      const ahead = await this.git.aheadCount(input.childDir, `origin/${input.base}`, branch);
      if (ahead === 0) {
        // An honest nothing-to-ship, not a crash — and not a success either: whatever the
        // agent signalled, no work reached the origin.
        this.log.info(`${signal} — no commits ahead of ${input.base}, nothing to ship`, about);
        return this.outcome({
          key: input.key,
          status: "failed",
          summary: `${description}\n\nsignal ${signal}, but no commits — nothing to ship.`,
          forkPoint,
          // The agent RAN, and the summary above is prose SUNDAY wrote around its own
          // description — so what it failed AT travels as this typed fact rather than as
          // text for #39 to pattern-match (constraint 3). Retrying this one with its own
          // error would spend a second agent run on a decision already taken.
          agentFailed: true,
        });
      }
      // HERE, between the count and the push: this is the last instant before the run
      // writes to somebody else's repository, and the base it was going to target may
      // have merged while the agent worked (#38 AC2).
      const vanished = await beforeShip(this.git, input);
      if (vanished) {
        this.log.info(`stopped — ${vanished.summary}`, about);
        return this.outcome(vanished);
      }
      await this.git.push(input.childDir, branch);
      const draft = signal !== "ready";
      const url = await this.openPr(input, branch, detail.title, result, ahead, draft);
      this.log.info(`${signal} — ${draft ? "draft " : ""}PR ${url}`, about);
      // A `fail` that shipped a draft is still a FAILED work item: the PR is there for a
      // human to read, not because the run succeeded — and it is the agent's OWN verdict,
      // flagged as one so #39 neither retries it nor quarantines it. Only on the failing
      // branch: a shipped `ready`/`draft` has nothing for anyone to classify.
      return this.outcome({
        key: input.key,
        status: signal === "fail" ? "failed" : "done",
        summary: `${description}\n\n${draft ? "draft " : ""}PR: ${url}`,
        forkPoint,
        ...(signal === "fail" ? { agentFailed: true } : {}),
      });
    } catch (err) {
      // NOTHING escapes this method. The child's whole job is to leave exactly one durable
      // outcome behind (ADR-0001) — a throw here leaves the parent an exit code, and the
      // work item is recorded as a dead child rather than as the failure it actually was.
      // The message is the agent's or the tool's own, because #39 classifies on that text.
      const failure = describe(err);
      this.log.info(`failed — ${failure}`, about);
      return this.outcome({ key: input.key, status: "failed", summary: failure, forkPoint });
    } finally {
      if (!gated && !stopped) await this.cleanup(input, branch, preserved, about);
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

  /** One durable answer for the parent to apply. Takes the outcome's own shape rather
   *  than a positional list: what a run reports back grows (a session handle, a fork
   *  point, #39's classification), and a list of optionals makes every call site spell
   *  `undefined` for the ones it has nothing to say about. */
  private outcome(fields: Omit<Outcome, "finishedAt">): Outcome {
    return { ...fields, finishedAt: new Date().toISOString() };
  }
}
