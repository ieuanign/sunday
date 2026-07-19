// listener/restack.mts — restack-on-merge (M2, step 6c).
//
// When a stacked blocker B merges, its dependents A (which branched from B and
// whose PRs target feat/<B>) must be rebased onto main and retargeted. This is
// pure HOST mechanics — TS drives every `git rebase`; an agent is summoned only
// on a genuine source conflict (deferred — see the gate note below). Rebase
// only, never merge; history stays linear.
//
// Where the rebase runs (the one non-mechanical decision): an EPHEMERAL detached
// worktree per branch under .scratch/restack/, off the child's .git. It never
// touches the main child checkout or a Sandcastle worktree (either may be
// mid-run), tears down cleanly on success or conflict, and composes for the
// cascade.
//
// Finding dependents (divergence from the base-list approach): a FORWARD-edge
// scan — open PRs whose issue is `blocked_by` the merged issue (reuses
// readBlockers, same pattern as 6b). Robust to GitHub auto-deleting feat/<B> on
// merge and auto-retargeting A's PR base to main, which would make a
// `--base feat/<B>` list miss A entirely. The reverse `.../dependencies/blocks`
// edge 404s, so this is never a reverse query.

import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { sh } from "./helper.mts";
import { sundayComment } from "./run-issue.mts";
import { readBlockers } from "./dag.mts";
import type { WorkItem } from "./scheduler.mts";
import type { RepoConfig } from "#config/repos.mts";

const parentRoot = resolve(import.meta.dirname, "..");

/** The ephemeral worktree path for a branch's rebase (stable per branch). */
function worktreePath(branch: string): string {
  return resolve(parentRoot, ".scratch", "restack", branch.replaceAll("/", "-"));
}

function isRegisteredWorktree(childDir: string, wt: string): boolean {
  return sh("git", ["worktree", "list", "--porcelain"], childDir)
    .split("\n")
    .includes(`worktree ${wt}`);
}

/** Run `body` in a fresh detached worktree at `wt` (checked out at `ref`), always
 *  torn down afterward. The scheduler's two-way per-branch lock already guarantees
 *  no concurrent work on this branch, so this only guards against a STALE worktree
 *  a crashed run left at the path: prune vanished entries, reclaim a leftover, then
 *  add fresh. `--detach` never checks out the branch itself, so it can't collide
 *  with a Sandcastle worktree that has it checked out. */
function withWorktree<T>(childDir: string, wt: string, ref: string, body: () => T): T {
  sh("git", ["worktree", "prune"], childDir); // drop entries for vanished dirs
  if (existsSync(wt) || isRegisteredWorktree(childDir, wt)) {
    try { sh("git", ["worktree", "remove", "--force", wt], childDir); } catch { /* */ }
    rmSync(wt, { recursive: true, force: true });
  }
  try {
    sh("git", ["worktree", "add", "--detach", wt, ref], childDir);
    return body();
  } finally {
    try { sh("git", ["worktree", "remove", "--force", wt], childDir); } catch { /* next prune */ }
  }
}

interface Dependent {
  /** PR number, as a string for gh. */
  pr: string;
  /** Head branch, `feat/<issue>`. */
  branch: string;
  /** Issue number, as a string. */
  issue: string;
}

/** Open PRs stacked on `blockerIssue`: their issue lists it as a blocker
 *  (forward edge). Only `feat/<n>` heads are ours; others are ignored. */
function dependents(fullName: string, childDir: string, blockerIssue: string): Dependent[] {
  const prs = JSON.parse(
    sh("gh", ["pr", "list", "--state", "open", "--json", "number,headRefName", "--limit", "100"], childDir),
  ) as { number: number; headRefName: string }[];
  const target = Number(blockerIssue);
  const out: Dependent[] = [];
  for (const p of prs) {
    if (!p.headRefName.startsWith("feat/")) continue;
    const issue = p.headRefName.slice("feat/".length);
    const blockers = readBlockers(fullName, childDir, issue);
    if (blockers.some((b) => b.number === target)) {
      out.push({ pr: String(p.number), branch: p.headRefName, issue });
    }
  }
  return out;
}

/** Rebase `branch`'s own commits (`upstream..branch`) onto `ontoRef` in an
 *  ephemeral detached worktree, then force-push. Returns "clean" on success,
 *  "conflict" if the rebase couldn't be replayed (aborted, nothing pushed).
 *  `upstream` is passed straight to `git rebase --onto` — its `<upstream>..HEAD`
 *  set-semantics already exclude shared history, so a merge-base is unneeded
 *  even if the parent advanced after the child forked. */
export function hostRebase(
  childDir: string,
  branch: string,
  ontoRef: string,
  upstream: string,
): "clean" | "conflict" {
  return withWorktree(childDir, worktreePath(branch), `origin/${branch}`, () => {
    const wt = worktreePath(branch);
    try {
      sh("git", ["rebase", "--onto", ontoRef, upstream], wt);
    } catch {
      // Non-zero exit = a genuine source conflict; leave nothing half-applied.
      sh("git", ["rebase", "--abort"], wt);
      return "conflict";
    }
    // Lease uses origin/<branch> (the worktree's base) — safe against a concurrent
    // push, still a force since we rewrote history.
    sh("git", ["push", "--force-with-lease", "origin", `HEAD:${branch}`], wt);
    return "clean";
  });
}

/** A restack couldn't rebase cleanly — stop and open the human gate ON THE PR
 *  (the dependent's issue is already done; the stuck thing is a branch rebase a
 *  human fixes on the PR). Slice 2 will attempt an in-sandbox `claude -p` fix
 *  before falling through to this gate. */
function gateConflict(childDir: string, d: Dependent, ontoRef: string): void {
  const body =
    `Restacking \`${d.branch}\` onto \`${ontoRef.replace(/^origin\//, "")}\` hit a source ` +
    `conflict I won't auto-resolve. Rebase this branch by hand, then push — the PR will catch up.`;
  sh("gh", ["pr", "comment", d.pr, "--body", sundayComment(body)], childDir);
  sh("gh", ["pr", "edit", d.pr, "--add-label", "awaiting-human"], childDir);
  console.log(`⛔ restack ${d.branch}: conflict — opened the gate on PR #${d.pr}.`);
}

/** One branch's restack: rebase `step.branch`'s own commits (`upstream..branch`)
 *  onto `step.onto`, force-push, retarget its PR to main (merged-parent only),
 *  then enqueue ITS dependents (they stay stacked on this branch, rebased onto its
 *  new tip). Runs in the uncapped restack lane, holding the shared branch lock. */
interface Step {
  branch: string;
  /** Ref to rebase onto: `origin/main` (direct dependent) or `origin/feat/<parent>`. */
  onto: string;
  /** Fork point — the parent's pre-rebase tip; `<upstream>..branch` = this branch's own commits. */
  upstream: string;
  /** Retarget this PR's base to `main` (true only for a merged parent's direct dependents). */
  retargetToMain: boolean;
  pr: string;
  issue: string;
}

/** Build the restack driver bound to the scheduler's restack lane. `enqueueStep`
 *  is `scheduler.enqueueRestack`; a clean step enqueues its children through it,
 *  so the cascade drains as a queue (parent-before-child) rather than a
 *  synchronous recursion — each step waits on the shared per-branch lock. */
export function makeRestacker(enqueueStep: (item: WorkItem) => void) {
  function enqueue(fullName: string, cfg: RepoConfig, childDir: string, step: Step): void {
    enqueueStep({
      key: `restack:${fullName}:${step.branch}`,
      branch: step.branch,
      run: async () => runStep(fullName, cfg, childDir, step),
    });
  }

  async function runStep(fullName: string, cfg: RepoConfig, childDir: string, step: Step): Promise<void> {
    // Capture the pre-rebase tip BEFORE rebasing: it's the fork point for this
    // branch's OWN dependents (their rebase upstream).
    const oldHead = sh("git", ["rev-parse", `origin/${step.branch}`], childDir);
    const d: Dependent = { pr: step.pr, branch: step.branch, issue: step.issue };

    if (hostRebase(childDir, step.branch, step.onto, step.upstream) === "conflict") {
      gateConflict(childDir, d, step.onto); // slice 2: try an in-sandbox fix first
      return; // don't cascade past an unrebased branch
    }
    if (step.retargetToMain) {
      sh("gh", ["pr", "edit", step.pr, "--base", "main"], childDir);
    }
    console.log(
      `↪ restacked ${step.branch} onto ${step.onto}${step.retargetToMain ? ` (PR #${step.pr} → main)` : ""}`,
    );

    // Cascade: this branch's dependents stay stacked on it (base unchanged),
    // rebased onto its NEW tip (origin/<branch>, updated by the push above).
    for (const c of dependents(fullName, childDir, step.issue)) {
      enqueue(fullName, cfg, childDir, {
        branch: c.branch, onto: `origin/${step.branch}`, upstream: oldHead,
        retargetToMain: false, pr: c.pr, issue: c.issue,
      });
    }
  }

  /** A stacked blocker just merged (`pull_request.closed`, merged, head
   *  `feat/<issue>`). Seed the restack lane with its direct dependents (rebase
   *  onto main, retarget to main); the cascade unfolds from there. Safe no-op
   *  when the merged branch has no dependents. */
  function restackOnMerge(fullName: string, cfg: RepoConfig, mergedIssue: string, mergedHeadSha: string): void {
    const childDir = resolve(parentRoot, cfg.path);
    // One fetch brings main + every feat/* remote-tracking ref current; our own
    // pushes below keep origin/<branch> current for the cascade.
    sh("git", ["fetch", "origin"], childDir);
    console.log(`⟲ restack: blocker #${mergedIssue} merged — seeding stacked dependents…`);
    for (const d of dependents(fullName, childDir, mergedIssue)) {
      enqueue(fullName, cfg, childDir, {
        branch: d.branch, onto: "origin/main", upstream: mergedHeadSha,
        retargetToMain: true, pr: d.pr, issue: d.issue,
      });
    }
  }

  return { restackOnMerge };
}
