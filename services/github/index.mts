// services/github/index.mts — everything Sunday writes to GitHub, in one place. v1
// spread 39 `sh("gh", …)` call sites across the tree; V2 collapses them here so the
// shape of every write is visible at once. The spine writes exactly one thing — the
// claim — and #33/#36/#40/#42 grow the rest.

import { sh } from "#lib/sh.mts";

/** The label that says an issue is Sunday's RIGHT NOW. It is the durable cross-restart
 *  guard: a parent that comes back up with no memory reads this off GitHub, and a
 *  delivery that arrives mid-run is rejected by admission on the strength of it. */
export const CLAIM_LABEL = "agent-working";

/** What the Assignor is allowed to do to GitHub. Narrow deliberately: it is the seam a
 *  test substitutes, and every method on it is a real edit to a real repo. */
export interface GitHub {
  /** Take the issue. A claim applied without a run starting strands the issue until
   *  #35's orphan sweep, so it is taken as late as it can be and released as early. */
  claim(repo: string, issue: number): void;
  /** Give it back. NEVER while a child may still be alive — a released claim readmits
   *  the issue, and a second agent on it is a duplicate run and real quota. */
  release(repo: string, issue: number): void;
}

/** The real one, over the `gh` CLI. `--repo` addresses the issue directly — v1 passed a
 *  child checkout as cwd instead, a field every one of its 39 call sites had to carry.
 *
 *  Left out of the smokes on purpose, like `githubDestination()`: it needs the CLI, a
 *  token and the network. What CAN be wrong is WHEN Sunday claims and releases, and
 *  `test/smoke-assignor.mts` drives that over a substitute. */
export class Gh implements GitHub {
  claim(repo: string, issue: number): void {
    sh("gh", ["issue", "edit", String(issue), "--repo", repo, "--add-label", CLAIM_LABEL]);
  }

  release(repo: string, issue: number): void {
    sh("gh", ["issue", "edit", String(issue), "--repo", repo, "--remove-label", CLAIM_LABEL]);
  }
}
