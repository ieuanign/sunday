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
import { readBlockers, type Blocker } from "./dag.mts";
import { runAgentInSandbox } from "./sandbox-agent.mts";
import type { WorkItem } from "./scheduler.mts";
import type { RepoConfig } from "#config/repos.mts";

const parentRoot = resolve(import.meta.dirname, "..");

/** The ephemeral worktree path for a branch's rebase — INSIDE childDir so a single
 *  docker bind-mount (`-v childDir:childDir`) covers both it and its `.git` link
 *  (the in-sandbox conflict fix needs that; the host clean rebase is happy here
 *  too). Stable per branch. */
function worktreePath(childDir: string, branch: string): string {
  return resolve(childDir, ".sunday", "restack", branch.replaceAll("/", "-"));
}

function isRegisteredWorktree(childDir: string, wt: string): boolean {
  return sh("git", ["worktree", "list", "--porcelain"], childDir)
    .split("\n")
    .includes(`worktree ${wt}`);
}

/** Run `body` in a fresh worktree created with `addArgs` — `--detach <wt>
 *  origin/<b>` for a host clean rebase, or `-f -B <b> <wt> origin/<b>` to check
 *  the branch out for the in-sandbox fix — always torn down afterward. The
 *  scheduler's two-way per-branch lock guarantees no concurrent work on this
 *  branch, so this only reclaims a STALE worktree a crashed run left at the path. */
async function withWorktree<T>(
  childDir: string,
  wt: string,
  addArgs: string[],
  body: () => T | Promise<T>,
): Promise<T> {
  sh("git", ["worktree", "prune"], childDir); // drop entries for vanished dirs
  if (existsSync(wt) || isRegisteredWorktree(childDir, wt)) {
    try { sh("git", ["worktree", "remove", "--force", wt], childDir); } catch { /* */ }
    rmSync(wt, { recursive: true, force: true });
  }
  try {
    sh("git", ["worktree", "add", ...addArgs], childDir);
    return await body();
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

/** Every open PR whose head is one of ours (`feat/<n>`). The shared scan behind
 *  both dependent discovery (6c) and the reconcile restack sweep (step 7). */
function openFeatPrs(childDir: string): Dependent[] {
  const prs = JSON.parse(
    sh("gh", ["pr", "list", "--state", "open", "--json", "number,headRefName", "--limit", "100"], childDir),
  ) as { number: number; headRefName: string }[];
  return prs
    .filter((p) => p.headRefName.startsWith("feat/"))
    .map((p) => ({ pr: String(p.number), branch: p.headRefName, issue: p.headRefName.slice("feat/".length) }));
}

/** Open PRs stacked on `blockerIssue`: their issue lists it as a blocker
 *  (forward edge). Only `feat/<n>` heads are ours; others are ignored. */
function dependents(fullName: string, childDir: string, blockerIssue: string): Dependent[] {
  const target = Number(blockerIssue);
  return openFeatPrs(childDir).filter((p) =>
    readBlockers(fullName, childDir, p.issue).some((b) => b.number === target),
  );
}

/** Is a dependent still owed a restack onto main? Only a single now-closed blocker
 *  can leave one — that's the sole case `decideBase` stacks (N>1 or an open blocker
 *  never stacks). It's outstanding until `origin/main` is in the branch's ancestry
 *  (an already-rebased branch has it; a still-stacked one doesn't). `mainIsAncestor`
 *  is lazy so the git check is skipped when the blocker precondition already fails.
 *  Pure + injected — unit-tested with synthetic blockers. */
export function restackOwed(blockers: Blocker[], mainIsAncestor: () => boolean): boolean {
  return blockers.length === 1 && blockers[0].state === "closed" && !mainIsAncestor();
}

/** Is `maybeAncestor` an ancestor of `ref`? `git merge-base --is-ancestor` exits
 *  0 (true) / 1 (false); `sh` throws on the non-zero, so false is the catch. */
function isAncestor(childDir: string, maybeAncestor: string, ref: string): boolean {
  try {
    sh("git", ["merge-base", "--is-ancestor", maybeAncestor, ref], childDir);
    return true;
  } catch {
    return false;
  }
}

/** The fork point for restacking a dependent of merged blocker `blockerIssue`:
 *  the blocker's merged-PR head commit (`upstream..dependent` = the dependent's
 *  OWN commits). On the live path this is the merge payload's `head.sha`; on
 *  reconcile we recover it from GitHub — `gh pr view` keeps `headRefOid` after the
 *  branch is deleted, and `fetch refs/pull/<n>/head` makes the object present so a
 *  later `rebase --onto` can reach it. Returns null (→ skip; can't rebase safely)
 *  if the blocker never merged via a `feat/<n>` PR, or the object is unreachable. */
function mergedBlockerTip(childDir: string, blockerIssue: number): string | null {
  const prs = JSON.parse(
    sh("gh", ["pr", "list", "--head", `feat/${blockerIssue}`, "--state", "merged", "--json", "number,headRefOid", "--limit", "5"], childDir),
  ) as { number: number; headRefOid: string }[];
  if (prs.length === 0) return null;
  const { number, headRefOid } = prs[0];
  const present = () => {
    try { sh("git", ["cat-file", "-e", `${headRefOid}^{commit}`], childDir); return true; } catch { return false; }
  };
  if (!present()) {
    try { sh("git", ["fetch", "origin", `refs/pull/${number}/head`], childDir); } catch { /* unreachable → null below */ }
  }
  return present() ? headRefOid : null;
}

/** Rebase `branch`'s own commits (`upstream..branch`) onto `ontoRef` in an
 *  ephemeral detached worktree, then force-push. Returns "clean" on success,
 *  "conflict" if the rebase couldn't be replayed (aborted, nothing pushed).
 *  `upstream` is passed straight to `git rebase --onto` — its `<upstream>..HEAD`
 *  set-semantics already exclude shared history, so a merge-base is unneeded
 *  even if the parent advanced after the child forked. */
export async function hostRebase(
  childDir: string,
  branch: string,
  ontoRef: string,
  upstream: string,
): Promise<"clean" | "conflict"> {
  const wt = worktreePath(childDir, branch);
  return withWorktree(childDir, wt, ["--detach", wt, `origin/${branch}`], () => {
    try {
      sh("git", ["rebase", "--onto", ontoRef, upstream], wt);
    } catch {
      // Non-zero exit = a genuine source conflict; leave nothing half-applied.
      sh("git", ["rebase", "--abort"], wt);
      return "conflict" as const;
    }
    // Lease uses origin/<branch> (the worktree's base) — safe against a concurrent
    // push, still a force since we rewrote history.
    sh("git", ["push", "--force-with-lease", "origin", `HEAD:${branch}`], wt);
    return "clean" as const;
  });
}

/** The in-sandbox conflict-fix prompt: `/implement` rebases `branch` onto `onto`,
 *  dropping its old base at `upstream` (the fork point), resolving by judgment and
 *  verifying green; gate if genuinely stuck; never push (Sunday does). No git
 *  mechanics are spelled out — the agent handles rebase-vs-`--onto` and the
 *  resolution itself. */
function conflictPrompt(step: Step): string {
  return [
    `This working tree is checked out at the tip of branch \`${step.branch}\`. A branch it was ` +
      `stacked on has moved, so \`${step.branch}\` must be rebased onto \`${step.onto}\`, keeping ` +
      `only its own commits (those after \`${step.upstream}\`).`,
    ``,
    `Use \`/implement\` to do it: run the rebase (you decide plain \`rebase\` vs \`rebase --onto\`), ` +
      `resolve any conflicts using your judgment about what each side intended, and confirm the ` +
      `result builds and its tests pass.`,
    ``,
    `If — and only if — you genuinely cannot tell how to resolve a conflict, or cannot get the ` +
      `result to green, abort the rebase and gate instead of guessing.`,
    ``,
    `Do not push and do not open a PR — Sunday does that automatically once you finish.`,
    ``,
    `Finish by printing exactly one line and nothing after it:`,
    `<sunday-result>{"signal":"resolved","summary":"..."}</sunday-result>`,
    `or`,
    `<sunday-result>{"signal":"gate","summary":"why you could not resolve"}</sunday-result>`,
  ].join("\n");
}

/** In-sandbox conflict fix (uncapped lane; the step already holds the branch
 *  lock). Rebase the PR's authoritative tip (`origin/<branch>`, DETACHED — no local
 *  branch created or reset), letting `claude -p` resolve + verify via `/implement`,
 *  then trust the GIT ground truth before force-pushing HEAD back: rebase finished,
 *  HEAD sits on the target, and it carries only this branch's OWN commits
 *  (`≤ ownCommits` — guards a plain `rebase` that pulled in the base's commits too).
 *  Returns "resolved" (pushed) or "gate" (the caller opens the human gate). */
async function agentFix(
  cfg: RepoConfig,
  childDir: string,
  step: Step,
  ownCommits: number,
): Promise<"resolved" | "gate"> {
  const model = process.env.MODEL;
  if (!model) throw new Error("MODEL unset — load the parent .env (node --env-file=.env …).");
  const wt = worktreePath(childDir, step.branch);
  // Detached at origin/<branch> — the PR's tip. We rebase that content and push
  // HEAD back; no local branch is touched (origin is the source of truth).
  return withWorktree(childDir, wt, ["--detach", wt, `origin/${step.branch}`], async () => {
    console.log(`↻ restack ${step.branch}: conflict — summoning in-sandbox claude -p…`);
    const res = await runAgentInSandbox({
      childDir, imageName: cfg.imageName, worktree: wt, prompt: conflictPrompt(step), model,
    });
    const rebaseDir = sh("git", ["rev-parse", "--git-path", "rebase-merge"], wt);
    const rebasing = existsSync(resolve(wt, rebaseDir)) || existsSync(rebaseDir);
    const onTarget = (() => {
      try {
        return sh("git", ["merge-base", step.onto, "HEAD"], wt) === sh("git", ["rev-parse", step.onto], wt);
      } catch {
        return false;
      }
    })();
    // Commit-count guard: a correct `--onto` replays only this branch's own commits
    // (≤ ownCommits; some may drop as empty). More than that means the agent replayed
    // the base's commits too (a plain `rebase`) — reject even though HEAD is on target.
    const got = onTarget ? Number(sh("git", ["rev-list", "--count", `${step.onto}..HEAD`], wt)) : -1;
    const countOk = got >= 1 && got <= ownCommits;
    if (res.signal !== "resolved" || res.errored || rebasing || !onTarget || !countOk) {
      console.log(
        `⛔ restack ${step.branch}: agent did not cleanly resolve ` +
          `(signal=${res.signal}, errored=${res.errored}, rebasing=${rebasing}, onTarget=${onTarget}, commits=${got}/${ownCommits}).`,
      );
      return "gate";
    }
    sh("git", ["push", "--force-with-lease", "origin", `HEAD:${step.branch}`], wt);
    console.log(`✅ restack ${step.branch}: agent resolved the conflict — pushed (${got} commit(s) on ${step.onto}).`);
    return "resolved";
  });
}

/** A restack couldn't be resolved (host rebase conflicted AND the in-sandbox fix
 *  gave up) — open the human gate ON THE PR (the dependent's issue is already done;
 *  the stuck thing is a branch rebase a human fixes on the PR). */
function gateConflict(childDir: string, d: Dependent, ontoRef: string): void {
  const body =
    `Restacking \`${d.branch}\` onto \`${ontoRef.replace(/^origin\//, "")}\` hit a source conflict ` +
    `I couldn't resolve (even in-sandbox). Rebase this branch by hand, then push — the PR will catch up.`;
  sh("gh", ["pr", "comment", d.pr, "--body", sundayComment(body)], childDir);
  sh("gh", ["pr", "edit", d.pr, "--add-label", "awaiting-human"], childDir);
  console.log(`⛔ restack ${d.branch}: unresolved conflict — opened the gate on PR #${d.pr}.`);
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
    // branch's OWN dependents (their rebase upstream). Its `upstream..oldHead`
    // count is this branch's own-commit count — the ceiling the fix is checked against.
    const oldHead = sh("git", ["rev-parse", `origin/${step.branch}`], childDir);
    const ownCommits = Number(sh("git", ["rev-list", "--count", `${step.upstream}..${oldHead}`], childDir));
    const d: Dependent = { pr: step.pr, branch: step.branch, issue: step.issue };

    // Host clean rebase first (fast, free, no agent). On a genuine conflict,
    // summon the in-sandbox claude -p fix; if it can't reach green either, gate.
    if ((await hostRebase(childDir, step.branch, step.onto, step.upstream)) === "conflict") {
      if ((await agentFix(cfg, childDir, step, ownCommits)) === "gate") {
        gateConflict(childDir, d, step.onto);
        return; // don't cascade past an unresolved branch
      }
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

  /** Restart recovery (step 7): the restack queue + branch locks are in-memory
   *  and lost on restart, so re-derive any restack a merge fired while we were
   *  down. A dependent is owed a restack iff its PR is open, it has exactly one
   *  (now-closed) blocker — the only case `decideBase` stacks — and `origin/main`
   *  isn't yet an ancestor of its head (an already-rebased branch has main in its
   *  ancestry; a still-stacked one does not). Enqueues the SAME `Step` the live
   *  path uses, so the cascade + conflict fix + gate all apply; dedup by key means
   *  it's harmless if the live merge handler also seeded it. Deeper nodes whose
   *  blocker is still open are left to that blocker's cascade. */
  function reconcileRestacks(fullName: string, cfg: RepoConfig): void {
    const childDir = resolve(parentRoot, cfg.path);
    // Freshen origin/main + origin/feat/*; `-p` also prunes dangling origin/feat/*
    // left by merged/deleted branches — the once-per-repo boot hygiene (findings §4).
    sh("git", ["fetch", "-p", "origin"], childDir);
    let owed = 0;
    for (const p of openFeatPrs(childDir)) {
      const blockers = readBlockers(fullName, childDir, p.issue);
      if (!restackOwed(blockers, () => isAncestor(childDir, "origin/main", `origin/${p.branch}`))) continue;
      const upstream = mergedBlockerTip(childDir, blockers[0].number);
      if (!upstream) {
        console.log(`  · reconcile restack ${p.branch}: blocker #${blockers[0].number} has no recoverable merged tip — skipping`);
        continue;
      }
      console.log(`  ⟲ reconcile restack ${p.branch} → main (blocker #${blockers[0].number})`);
      enqueue(fullName, cfg, childDir, {
        branch: p.branch, onto: "origin/main", upstream,
        retargetToMain: true, pr: p.pr, issue: p.issue,
      });
      owed++;
    }
    if (owed) console.log(`⟲ reconcile: seeded ${owed} missed restack(s) for ${fullName}`);
  }

  return { restackOnMerge, reconcileRestacks };
}
