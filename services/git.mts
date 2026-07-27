// services/git.mts — the child checkout's git, on a seam of its own. Same shape and
// same reason as services/github/index.mts: every `git` a run performs lives in one
// file, and a run's decisions can be driven with no repo on disk.
//
// Stateless — the checkout is a parameter, never construction state — because the
// consumers do not share one: a forked issue run works in its own child clone (#36)
// and a restack works in whichever dependent's clone the cascade reached (#43).
//
// Nothing here logs or swallows: it throws with git's own stderr and the caller, which
// owns a Logger, decides what a failure means. Cleanup after a shipped PR is
// best-effort at the CALLER; a `git` that decided that for itself would either turn a
// shipped PR into a failed run or hide a fetch that never happened.

import { appendFile, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

import { shA } from "#lib/sh.mts";

/** What the pipeline writes INTO a child's worktree that must not show up in its `git
 *  status`: the injected floor's sub-agents drop their plan docs in `.scratch/`
 *  (cwd-relative inside the sandbox). Ported from v1's `ensureSandboxIgnores`. */
const PIPELINE_SCRATCH = ".scratch/";

/** What a branch changed, as the PR footer states it (#37). Numbers rather than git's
 *  own sentence: the footer renders `16 files, +1533/−49`, and the body composer is a
 *  pure function that must not have to know git's output text. */
export interface DiffStat {
  files: number;
  insertions: number;
  deletions: number;
}

/** What a run is allowed to do to a child checkout. */
export interface Git {
  /** Does the ORIGIN have `branch` right now? The run's base check, asked twice (#38):
   *  before the run starts anything, and again immediately before the push. The origin
   *  rather than a local `origin/<branch>` because that ref is only as fresh as the last
   *  fetch, and a whole agent run elapses between this run's fetch and its push — a base
   *  that merged and was deleted in that window still resolves locally and is gone
   *  (ADR-0003). A transport failure THROWS: a flaky network must not read as "the base
   *  is gone", which would end a run that could have shipped. */
  remoteBranchExists(childDir: string, branch: string): Promise<boolean>;
  /** Keep the pipeline's own scratch out of this checkout's `git status`, idempotently.
   *  A dirty worktree makes the agent library preserve it host-side, which holds the
   *  branch checked out and blocks the run's cleanup — so this runs before every run,
   *  including on children onboarded before it existed. */
  excludeScratch(childDir: string): Promise<void>;
  /** Every remote ref as the origin has them NOW, dropping the ones it no longer has.
   *  A run bases on the freshly-fetched `origin/<base>`, and a head branch GitHub
   *  deleted on merge must not survive locally as a base that still looks alive
   *  (ADR-0003). */
  fetchPrune(childDir: string): Promise<void>;
  /** The commit `ref` names, right now. A run resolves its base with this AFTER the
   *  fetch and hands the SHA to the agent as its start point, so the commit the branch
   *  gets created from is recorded by construction rather than by argument (ADR-0003 —
   *  the fork point has to sit in the dependent's own ancestry). Throws when `ref` does
   *  not resolve: a blocker's branch deleted between admission and the run is a failed
   *  run, never a start point that is not a commit. */
  resolveRef(childDir: string, ref: string): Promise<string>;
  /** Publish `branch` to the origin — the run's one write to the child's remote. */
  push(childDir: string, branch: string): Promise<void>;
  /** Commits on `branch` that `baseRef` does not have. Zero when `branch` does not
   *  exist locally — an agent that committed nothing is an honest "nothing to ship",
   *  not a crash. A `baseRef` that does not resolve still throws: a fetch that
   *  silently failed must not read as an empty branch. */
  aheadCount(childDir: string, baseRef: string, branch: string): Promise<number>;
  /** What `branch` changes against `baseRef`, for the PR footer. Measured from where the
   *  two diverged, so a base that moved while the run worked does not enter the count —
   *  the footer states what the PR's own diff shows. */
  diffStat(childDir: string, baseRef: string, branch: string): Promise<DiffStat>;
  /** Force-remove a worktree the agent library preserved because the run left it dirty.
   *  It holds the run's branch checked out, so it goes FIRST or the delete below
   *  cannot. */
  removeWorktree(childDir: string, worktreePath: string): Promise<void>;
  /** Drop the run's local branch once the origin holds its history. A branch that is
   *  already gone is not a failure — cleanup runs on every non-gated path, including
   *  one that never created a branch. NEVER touches the origin. */
  deleteBranch(childDir: string, branch: string): Promise<void>;
}

/** What a RESTACK is allowed to do to a dependent's checkout, on top of the reads a
 *  run already has (`fetchPrune`, `resolveRef`). Its own interface beside `Git` for the
 *  reason `GitHubReconcile` is one: the two consumers take different powers, and the one
 *  power here that a run never has — rewriting a published branch — is worth naming.
 *
 *  `GitCli` implements both. Every method is async, as `Git`'s are: a restack runs in the
 *  PARENT process (it is not a work item), so a synchronous rebase would freeze the event
 *  loop the readiness probe answers on (ADR-0001). */
export interface GitRestack {
  /** Is `maybeAncestor` already in `ref`'s history? What makes a branch a first pass
   *  restacks and a second pass SKIPS: a branch that already carries the onto commit was
   *  rebased by an earlier delivery, and rebasing it again would replay commits it no
   *  longer owns. False on any non-zero exit, including a ref that does not resolve —
   *  which then fails loudly at the rebase rather than silently skipping it. */
  isAncestor(childDir: string, maybeAncestor: string, ref: string): Promise<boolean>;
  /** Bring one ref down from the origin by its full name — `refs/pull/<n>/head`, which a
   *  plain fetch never brings because it is not under `refs/heads`. It is how a merged
   *  blocker's tip is RECOVERED after GitHub deleted the branch (ADR-0003), and its throw
   *  is the "not recoverable" signal: the origin either still has the PR head or the
   *  dependent's fork point cannot be established at all, and a guessed anchor
   *  force-pushes somebody else's commits. */
  fetchRef(childDir: string, ref: string): Promise<void>;
  /** Replay `branch`'s OWN commits (`forkPoint..branch`) onto `ontoSha` and publish the
   *  result — the whole restack, for one branch.
   *
   *  Answers `"conflict"` rather than throwing when the replay cannot be performed: that
   *  is a decided outcome the caller gates a human on, not a tool error to classify (a
   *  conflict in `src/auth/credentials.ts` reads to the failure classifier as an auth
   *  failure and would halt the pipeline). Anything else throws with git's own stderr. */
  rebaseOnto(rebase: Rebase): Promise<"clean" | "conflict">;
}

/** One branch's rebase, fully resolved by the caller. An object rather than five
 *  positional strings on purpose: `ontoSha` and `forkPoint` are both commits, they mean
 *  opposite ends of the replay, and swapping them force-pushes a branch carrying somebody
 *  else's commits. */
export interface Rebase {
  /** The dependent's own clone — where the branch lives and the worktree hangs off. */
  childDir: string;
  /** The branch being moved. Read from and pushed back to the ORIGIN, never from a local
   *  copy: the PR's tip is what a human sees and what a lease is taken against. */
  branch: string;
  /** The commit the branch is replayed onto, already resolved to a SHA by the caller so
   *  the recorded fork point is true by construction and `origin/main` cannot move
   *  between the rebase and the write (ADR-0003). */
  ontoSha: string;
  /** The branch's stored fork point — `forkPoint..branch` is exactly its own commits, so
   *  the base's commits are never replayed into it. */
  forkPoint: string;
  /** Where the ephemeral detached worktree goes (`lib/paths.mts`). A PARAMETER because
   *  it belongs under `var/`, not inside the child checkout: v1 put it there, where the
   *  untracked directory dirties a concurrent run's worktree (#21). */
  worktreePath: string;
}

/** The real one, over the `git` CLI. */
export class GitCli implements Git, GitRestack {
  async remoteBranchExists(childDir: string, branch: string): Promise<boolean> {
    // Ported from v1 (`listener/run-issue.mts:53`). The pattern is the FULL ref name on
    // top of `--heads`: a bare `feat/9` would also match a tag of that name, which is
    // nothing a PR can target or a branch can be pushed to. No output means gone; a
    // transport failure exits non-zero and `shA` throws it.
    return (await shA("git", ["ls-remote", "--heads", "origin", `refs/heads/${branch}`], childDir)) !== "";
  }

  async excludeScratch(childDir: string): Promise<void> {
    // The clone's LOCAL `.git/info/exclude`, never its tracked `.gitignore`: this is
    // Sunday's business, not the child's, so it must never leak into a PR.
    const excludePath = resolve(childDir, ".git", "info", "exclude");
    const current = await readFile(excludePath, "utf8").catch(() => "");
    if (current.split("\n").some((line) => line.trim() === PIPELINE_SCRATCH)) return;
    const lead = current && !current.endsWith("\n") ? "\n" : "";
    await appendFile(excludePath, `${lead}# Sunday: keep pipeline scratch out of the worktree\n${PIPELINE_SCRATCH}\n`);
  }

  async fetchPrune(childDir: string): Promise<void> {
    await shA("git", ["fetch", "-p", "origin"], childDir);
  }

  async resolveRef(childDir: string, ref: string): Promise<string> {
    // `--verify` so the answer is one revision or nothing: a bare `rev-parse` echoes an
    // unresolved name back on STDOUT alongside its error, which is a fork point that is
    // a branch name rather than a commit.
    return await shA("git", ["rev-parse", "--verify", ref], childDir);
  }

  async push(childDir: string, branch: string): Promise<void> {
    await shA("git", ["push", "origin", branch], childDir);
  }

  async aheadCount(childDir: string, baseRef: string, branch: string): Promise<number> {
    if (!(await this.branchExists(childDir, branch))) return 0;
    return Number(await shA("git", ["rev-list", "--count", `${baseRef}..${branch}`], childDir));
  }

  async diffStat(childDir: string, baseRef: string, branch: string): Promise<DiffStat> {
    // Three dots: the diff from the merge base, which is what the PR shows. Two dots
    // would fold every commit the base gained since the run started into the branch's
    // own stat, as deletions it never made.
    const line = await shA("git", ["diff", "--shortstat", `${baseRef}...${branch}`], childDir);
    // `--shortstat` omits a clause entirely when its count is zero ("1 file changed, 2
    // insertions(+)"), so an absent clause is a zero, not a parse failure.
    const count = (clause: RegExp): number => Number(clause.exec(line)?.[1] ?? 0);
    return {
      files: count(/(\d+) files? changed/),
      insertions: count(/(\d+) insertions?\(\+\)/),
      deletions: count(/(\d+) deletions?\(-\)/),
    };
  }

  async removeWorktree(childDir: string, worktreePath: string): Promise<void> {
    // `--force` because the only worktree that ever reaches here is one that was
    // preserved for being dirty; git refuses to remove those without it.
    await shA("git", ["worktree", "remove", "--force", worktreePath], childDir);
  }

  async deleteBranch(childDir: string, branch: string): Promise<void> {
    if (!(await this.branchExists(childDir, branch))) return;
    await shA("git", ["branch", "-D", branch], childDir);
  }

  async rebaseOnto({ childDir, branch, ontoSha, forkPoint, worktreePath }: Rebase): Promise<"clean" | "conflict"> {
    await this.reclaimWorktree(childDir, worktreePath);
    try {
      // DETACHED at `origin/<branch>` — the PR's own tip, and no local branch is created
      // or reset. The origin is the source of truth for what the restack rewrites.
      await shA("git", ["worktree", "add", "--detach", worktreePath, `origin/${branch}`], childDir);
      try {
        // `--onto` with the branch's stored fork point as upstream: `forkPoint..HEAD` is
        // exactly this branch's own commits, so a base that moved never gets replayed
        // into it (ADR-0003).
        await shA("git", ["rebase", "--onto", ontoSha, forkPoint], worktreePath);
      } catch (err) {
        // A stopped rebase leaves nothing half-applied. `--abort` itself fails when the
        // rebase never STARTED (a ref that does not resolve) — that is not a conflict,
        // so the original error is re-thrown for the caller to classify.
        await shA("git", ["rebase", "--abort"], worktreePath).catch(() => {
          throw err;
        });
        return "conflict";
      }
      // The lease is against `origin/<branch>` as this worktree saw it, so a human who
      // pushed to the PR in the meantime is refused rather than clobbered.
      await shA("git", ["push", "--force-with-lease", "origin", `HEAD:${branch}`], worktreePath);
      return "clean";
    } finally {
      // Every path, conflict included (constraint 13): a worktree left behind holds a
      // branch checked out and blocks whatever touches it next.
      await shA("git", ["worktree", "remove", "--force", worktreePath], childDir).catch(() => {});
    }
  }

  /** Clear whatever a crashed run left at the worktree path — the path is stable per
   *  branch, so a stale directory would otherwise poison every later restack of it.
   *  `prune` drops registrations whose directory is gone, `remove` drops one whose
   *  directory is still there, and the `rm` covers a directory git never registered. */
  private async reclaimWorktree(childDir: string, worktreePath: string): Promise<void> {
    await shA("git", ["worktree", "prune"], childDir);
    await shA("git", ["worktree", "remove", "--force", worktreePath], childDir).catch(() => {});
    await rm(worktreePath, { recursive: true, force: true });
  }

  async fetchRef(childDir: string, ref: string): Promise<void> {
    // No local destination: the objects are what is wanted, not a ref of our own. A ref
    // the origin does not have exits non-zero here ("couldn't find remote ref"), which is
    // the throw the recovery path reads as "not recoverable".
    await shA("git", ["fetch", "origin", ref], childDir);
  }

  async isAncestor(childDir: string, maybeAncestor: string, ref: string): Promise<boolean> {
    // `merge-base --is-ancestor` says yes by exiting 0 and no by exiting 1, so `shA`'s
    // throw IS the negative answer. An unresolvable ref exits non-zero too and reads as
    // "not an ancestor" — the safe way round: it costs a rebase that then fails with
    // git's own message, where the opposite would silently skip a branch's restack.
    return await shA("git", ["merge-base", "--is-ancestor", maybeAncestor, ref], childDir)
      .then(() => true)
      .catch(() => false);
  }

  /** Is `branch` a local branch here? Asked separately rather than catching the
   *  count's failure, so "the branch was never created" stays distinguishable from
   *  "the base ref is gone" — the two want opposite answers. */
  private async branchExists(childDir: string, branch: string): Promise<boolean> {
    return (await shA("git", ["branch", "--list", branch], childDir)) !== "";
  }
}
