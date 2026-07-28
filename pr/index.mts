// pr/index.mts — one PR-comment run's DECISIONS: gather the summons nobody has answered,
// run the agent on the PR's head branch, push what it committed, and reply to every
// comment it was given. The sandbox decides; this host performs every write to GitHub
// (CONTEXT.md).
//
// A class over injected services and NOTHING else: no path resolution, no file reads, no
// service construction. That is what lets a smoke drive the real thing with a fake agent,
// GitHub, git and image probe — no docker, no network, no quota (constraint 5).

import { sundayReply, unansweredSummons } from "#lib/markers.mts";
import type { Outcome } from "#lib/outcome.mts";
import type { Agent } from "#services/agent/index.mts";
import type { Git } from "#services/git.mts";
import type { GitHubPrRun } from "#services/github/index.mts";
import type { LogContext, ModuleLogger } from "#services/logger.mts";
import { prPrompt, RESULT_TAG, resultSchema, type GatheredComment, type PrResult } from "./prompt.mts";

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One PR-comment run, fully resolved. Every path is absolute and every file already
 *  read: the entry point (`pr/run.mts`) resolves them from the Job, so nothing in here
 *  derives a path or opens a file. */
export interface PrRunInput {
  /** The work-item key (`<owner>/<repo>#pr<n>`) the outcome is named back with, and what
   *  the agent's per-run floor dir is named for. `#pr<n>` and never `#<n>`: an issue run
   *  on the same number would otherwise share this run's state entry, PID lock and result
   *  file (constraint 1). */
  key: string;
  /** `<owner>/<repo>`, from the routing table. */
  repo: string;
  pr: number;
  /** The child checkout this run happens against, absolute. */
  childDir: string;
  /** The pre-built sandbox image for this repo. */
  imageName: string;
  /** The PR-comment baseline prompt, already read — its `{{REPO}}`/`{{PR}}`/`{{BASE}}`
   *  placeholders are filled here. */
  baselinePrompt: string;
  /** This run's own log. The agent library appends its raw output to the same file, so
   *  the run reads back in one place. */
  logPath: string;
  /** What the PREVIOUS attempt at this item died on, when this run is #39's one retry.
   *  Handed to the agent in the prompt: it is the only thing this run knows that the last
   *  one did not, and without it a retry is the same run again on fresh quota. */
  retryError?: string;
}

/** Everything a run reaches the world through, and constructs none of. */
export interface PrModuleDeps {
  agent: Agent;
  github: GitHubPrRun;
  /** The six git operations a PR-comment run performs, and no more — it never asks the
   *  origin about a base or measures a diff, because it opens no pull request. */
  git: Pick<Git, "fetchPrune" | "resolveRef" | "aheadCount" | "push" | "deleteBranch" | "removeWorktree">;
  /** Is this repo's image on the host? A plain injected function rather than the sandbox
   *  service: nothing in `pr/` may import that library, and a check that constructed its
   *  own probe could not be driven without docker (#34 constraint 7). */
  imagePresent: (imageName: string) => Promise<boolean>;
  log: ModuleLogger;
}

export class PrModule {
  // Declared, not parameter properties: Node runs `.mts` in strip-only mode, which
  // rejects `constructor(private x)`.
  private readonly agent: Agent;
  private readonly github: GitHubPrRun;
  private readonly git: PrModuleDeps["git"];
  private readonly imagePresent: PrModuleDeps["imagePresent"];
  private readonly log: ModuleLogger;

  constructor(deps: PrModuleDeps) {
    this.agent = deps.agent;
    this.github = deps.github;
    this.git = deps.git;
    this.imagePresent = deps.imagePresent;
    this.log = deps.log;
  }

  /** Answer the outstanding `@sunday` comments on one pull request. */
  async run(input: PrRunInput): Promise<Outcome> {
    const about = { repo: input.repo, target: input.pr };

    const detail = await this.github.readPr(input.repo, input.pr);
    // FIRST, and off the read the run already performs: a whole queue wait elapses
    // between admission and this line, and a PR that merged in it has nowhere to ship a
    // fix to. Not a failure — nothing is wrong, and nothing re-derives a closed PR, so
    // the item is finished rather than retried (#39).
    if (detail.state !== "open") {
      this.log.info(`stopped — the pull request is ${detail.state}`, about);
      return this.outcome({
        key: input.key,
        status: "done",
        summary: `the run did not start: the pull request is ${detail.state}.`,
      });
    }

    const comments = await this.gather(input);
    if (comments.length === 0) {
      // Not a failure and not work: every summon on this PR is older than a reply of
      // ours. Reached on every reconcile pass over an answered PR, so it must cost
      // nothing beyond the reads above.
      this.log.info("nothing to answer — every summon already has a reply", about);
      return this.outcome({ key: input.key, status: "done", summary: "no unanswered @sunday comments." });
    }

    // LAST of the three guards, because it is the only one that asks the host rather than
    // GitHub, and first of anything that costs: hours of queue can pass before an item
    // runs — long enough for a prune to take the image, which the agent library reports
    // as an obscure container error. Typed, because the parent stops this whole repo on
    // it rather than retrying one work item (#39).
    if (!(await this.imagePresent(input.imageName))) {
      this.log.info(`stopped — no sandbox image ${input.imageName} on this host`, about);
      return this.outcome({
        key: input.key,
        status: "failed",
        summary: `the run did not start: this repo's sandbox image is not on this host — ${input.imageName}.`,
        precondition: "image-missing",
      });
    }

    /** A host path, when the agent left the worktree dirty and the library kept it. */
    let preserved: string | undefined;
    try {
      // Force fresh-from-origin BEFORE the fetch that recreates it: handed a branch name,
      // the agent library prefers an existing LOCAL branch over the start point it is
      // given, so a stale leftover (a crash, a restack that advanced the origin) would be
      // worked on instead of the PR's actual head. Dropped again in the cleanup.
      await this.git.deleteBranch(input.childDir, detail.head);
      await this.git.fetchPrune(input.childDir);
      // …resolved to the COMMIT it names, after the fetch and before the agent: the
      // library creates the branch at exactly this, so the commits the agent adds are
      // counted against where this run STARTED rather than against a ref that can move
      // underneath it.
      const startPoint = await this.git.resolveRef(input.childDir, `origin/${detail.head}`);

      const result = await this.agent.run({
        key: input.key,
        repo: { fullName: input.repo, childDir: input.childDir, imageName: input.imageName },
        prompt: prPrompt(
          input.baselinePrompt,
          { repo: input.repo, number: input.pr, base: detail.base },
          comments,
          input.retryError,
        ),
        branch: detail.head,
        startPoint,
        logPath: input.logPath,
        output: { tag: RESULT_TAG, schema: resultSchema },
      });
      preserved = result.preservedWorktreePath;

      // GIT's answer, and the agent has no say in it: the result carries no `committed`
      // flag to be wrong about (constraint 9). Zero is an ordinary ending — an agent that
      // judged every comment a won't-fix has nothing to commit, and the replies saying so
      // are the run's whole deliverable.
      const ahead = await this.git.aheadCount(input.childDir, startPoint, detail.head);
      /** What stopped a push that had commits to make, if anything did. */
      let held = "";
      if (ahead > 0) {
        // HERE, immediately before the only write that touches somebody else's branch: a
        // whole agent run has elapsed since the state was read, and pushing into a merged
        // or closed pull request is a write nobody asked for (#38 AC2). The replies below
        // still go out — a human asked those questions, and they are the ONLY record that
        // these comments were served.
        const { state } = await this.github.readPr(input.repo, input.pr);
        if (state === "open") await this.git.push(input.childDir, detail.head);
        else held = `\n\nthe pull request went ${state} while the agent worked, so nothing was pushed.`;
      }

      await this.reply(input, comments, result.output);

      const shipped = ahead > 0 && held === "";
      const push = shipped ? `pushed ${ahead}` : "nothing pushed";
      // Pushed to the phone: somebody summoned Sunday and is waiting on the answer.
      this.log.info(`answered ${comments.length} comment(s) — ${push}`, about, true);
      return this.outcome({ key: input.key, status: "done", summary: `${result.output.summary}${held}` });
    } catch (err) {
      // NOTHING escapes this method. The child's whole job is to leave exactly one durable
      // outcome behind (ADR-0001) — a throw here leaves the parent an exit code, and the
      // work item is recorded as a dead child rather than as the failure it actually was.
      // The message is the agent's or the tool's own, because #39 classifies on that text.
      const failure = describe(err);
      this.log.info(`failed — ${failure}`, about);
      return this.outcome({ key: input.key, status: "failed", summary: failure });
    } finally {
      await this.cleanup(input, detail.head, preserved, about);
    }
  }

  /** Drop what this run left on the child checkout: the origin holds anything worth
   *  keeping, and a branch left behind is the next run's stale head.
   *
   *  Never throws — it runs in a `finally`, and a `finally` that throws REPLACES the
   *  outcome being returned, which would lose a push and a set of replies that really
   *  happened. */
  private async cleanup(
    input: PrRunInput,
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
      // `error` here would post a comment on the PR for a leftover branch.
      this.log.info(`cleanup left something behind — ${describe(err)}`, about);
    }
  }

  /** The summons on this PR that Sunday has not answered, from both streams. Filtered
   *  separately (`unansweredSummons` is per stream): GitHub's ids are only comparable
   *  inside one id space, so an inline comment's id says nothing about a conversation
   *  reply's. */
  private async gather(input: PrRunInput): Promise<GatheredComment[]> {
    const conversation = await this.github.issueComments(input.repo, input.pr);
    const inline = await this.github.reviewComments(input.repo, input.pr);
    return [
      ...unansweredSummons(conversation).map(
        (c): GatheredComment => ({ id: c.id, kind: "conversation", body: c.body }),
      ),
      ...unansweredSummons(inline).map((c): GatheredComment => ({
        id: c.id,
        kind: "inline",
        location: `${c.path}:${c.line ?? "?"}`,
        body: c.body,
      })),
    ];
  }

  /** Answer every GATHERED comment — never just the ones the agent wrote back about
   *  (constraint 8). A gathered comment left unanswered still ends up OLDER than the
   *  replies that did land, so the next pass reads it as answered and a human's request
   *  is dropped in silence. The agent's own words when it has some, and an honest note
   *  pointing at what the run did when it has not.
   *
   *  Every reply carries the reply marker, which is the only thing that counts as an
   *  answer — and the ordinary Sunday marker under it, so a reply quoting the request it
   *  answers never reads back as a summon and Sunday never answers itself. */
  private async reply(input: PrRunInput, comments: GatheredComment[], result: PrResult): Promise<void> {
    const answers = new Map(result.replies.map((r) => [r.comment, r]));
    for (const comment of comments) {
      const answer = answers.get(comment.id);
      // The verdict is rendered HERE off the agent's typed `fixed` and never left to its
      // prose: a human scanning a thread wants to know which requests moved code before
      // reading a word of why, and an agent asked to say so in `body` says it a different
      // way every time — or forgets.
      const body = answer
        ? `${answer.fixed ? "✅ fixed" : "🚫 won't fix"} — ${answer.body}`
        : `No answer came back for this comment. What the run did overall: ${result.summary}`;
      // The reply NAMES the comment it answers, which is what stops it burying a summon
      // that arrived mid-run and has a lower id (`lib/markers.mts`).
      if (comment.kind === "inline") {
        await this.github.replyToReviewComment(input.repo, input.pr, comment.id, sundayReply(body, comment.id));
      } else {
        // GitHub's PR conversation does not thread, so the reply carries its question
        // with it — the first line only: a quoted wall of text buries the answer under it.
        const quoted = `> ${comment.body.split("\n")[0]}\n\n${body}`;
        await this.github.commentOnPr(input.repo, input.pr, sundayReply(quoted, comment.id));
      }
    }
  }

  /** One durable answer for the parent to apply. Takes the outcome's own shape rather
   *  than a positional list, exactly as an issue run's does. */
  private outcome(fields: Omit<Outcome, "finishedAt">): Outcome {
    return { ...fields, finishedAt: new Date().toISOString() };
  }
}
