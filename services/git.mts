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

import { appendFile, readFile } from "node:fs/promises";
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

/** The real one, over the `git` CLI. */
export class GitCli implements Git {
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

  /** Is `branch` a local branch here? Asked separately rather than catching the
   *  count's failure, so "the branch was never created" stays distinguishable from
   *  "the base ref is gone" — the two want opposite answers. */
  private async branchExists(childDir: string, branch: string): Promise<boolean> {
    return (await shA("git", ["branch", "--list", branch], childDir)) !== "";
  }
}
