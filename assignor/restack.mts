// assignor/restack.mts — restack on merge (#43): a blocker landed, so every branch
// stacked on it has to move.
//
// A dependent is admitted onto its blocker's branch and its PR targets `feat/<blocker>`
// (#42). The moment that blocker merges, the base under the dependent is gone — GitHub
// deletes the head branch by default — and its PR shows the blocker's commits as its
// own. This module rebases each dependent's OWN commits onto the new base, retargets its
// PR, and cascades into whatever is stacked on IT.
//
// The rebase upstream is the dependent's STORED FORK POINT (`var/state.json`,
// ADR-0003) and never the merged blocker's final tip, which is what v1 anchored on: that
// tip survives neither the branch being deleted on merge (it is not in the dependent's
// ancestry, so a fresh clone has never heard of it) nor a force-push (it names a lineage
// the dependent never forked from, and the replay then force-pushes the blocker's
// abandoned commits onto the dependent). The fork point sits INSIDE the dependent's own
// ancestry, so both races are simply not expressible.
//
// It runs in the PARENT (a restack is not a work item), so every call is `shA` and
// nothing here blocks the event loop the readiness probe answers on (ADR-0001).

import { resolve } from "node:path";

import { readBlockers } from "#assignor/dag.mts";
import type { FailurePolicy } from "#assignor/failure.mts";
import type { WorkItem } from "#assignor/scheduler.mts";
import type { StateStore } from "#assignor/state.mts";
import type { RepoConfig } from "#config/repos.mts";
import type { Git, GitRestack } from "#services/git.mts";
import { AWAITING_HUMAN_LABEL, type GitHubRestack } from "#services/github/index.mts";
import type { ModuleLogger } from "#services/logger.mts";

/** A head branch of ours, and the issue behind it. Anything else on the repo is
 *  somebody's own work and the scan leaves it alone. */
const FEAT = /^feat\/(\d+)$/;

/** Everything the restack needs and constructs none of. */
export interface RestackerDeps {
  repos: Record<string, RepoConfig>;
  github: GitHubRestack;
  /** The restack's own powers, plus the two reads a run already has — the fetch that
   *  opens a pass and the ref resolution that pins what a branch is rebased onto. */
  git: GitRestack & Pick<Git, "fetchPrune" | "resolveRef">;
  /** The scheduler's uncapped restack lane, and only that method: it is all this module
   *  uses, and the per-branch lock behind it is what keeps a restack off a branch an
   *  issue run is on. */
  enqueueRestack: (item: WorkItem) => void;
  state: StateStore;
  failure: FailurePolicy;
  log: ModuleLogger;
  /** The workspace root the routing table's child paths are relative to. */
  parentRoot: string;
  /** Where one branch's ephemeral rebase worktree goes (`lib/paths.mts`). */
  worktreePath: (repo: string, branch: string) => string;
}

/** One open PR of ours, as the dependent scan finds it. */
interface Dependent {
  pr: number;
  branch: string;
  issue: number;
}

/** One branch's restack, fully decided by whoever enqueued it. */
interface Step extends Dependent {
  repo: string;
  childDir: string;
  /** What the branch is rebased onto: `origin/main` for a merged blocker's direct
   *  dependent, `origin/feat/<parent>` for one the cascade reached. */
  ontoRef: string;
  /** Only a merged blocker's direct dependents change base — a cascaded one is still
   *  stacked on the same branch, which merely moved. */
  retargetToMain: boolean;
  /** Where the fork point comes from when state cannot answer (constraint 4). The
   *  merged blocker's PR head for a direct dependent, and the parent's PRE-REBASE tip
   *  for one the cascade reached — which the parent's own step captured before it moved,
   *  because after the push nothing points at it any more. */
  anchor: { mergedBlocker: number } | { tip: string };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class Restacker {
  // Declared, not parameter properties: Node runs `.mts` in strip-only mode, which
  // rejects `constructor(private x)`.
  private readonly repos: Record<string, RepoConfig>;
  private readonly github: GitHubRestack;
  private readonly git: GitRestack & Pick<Git, "fetchPrune" | "resolveRef">;
  private readonly enqueueRestack: (item: WorkItem) => void;
  private readonly state: StateStore;
  private readonly failure: FailurePolicy;
  private readonly log: ModuleLogger;
  private readonly parentRoot: string;
  private readonly worktreePath: (repo: string, branch: string) => string;

  constructor(deps: RestackerDeps) {
    this.repos = deps.repos;
    this.github = deps.github;
    this.git = deps.git;
    this.enqueueRestack = deps.enqueueRestack;
    this.state = deps.state;
    this.failure = deps.failure;
    this.log = deps.log;
    this.parentRoot = deps.parentRoot;
    this.worktreePath = deps.worktreePath;
  }

  /** A blocker merged: seed the lane with every branch stacked on it. */
  async onMerge(repo: string, mergedIssue: number): Promise<void> {
    const cfg = this.repos[repo];
    if (!cfg) {
      this.log.info(`· restack: ${repo} is not routed — nothing stacked on #${mergedIssue} is ours`);
      return;
    }
    const childDir = resolve(this.parentRoot, cfg.path);
    try {
      // The PRUNE is load-bearing: a head branch GitHub deleted on merge must not survive
      // here as a remote-tracking ref that still looks like a live base.
      await this.git.fetchPrune(childDir);
      const dependents = await this.dependents(repo, mergedIssue);
      this.log.info(`⟲ restack ${repo}: #${mergedIssue} merged — ${dependents.length} branch(es) stacked on it`, { repo });
      for (const dependent of dependents) {
        this.enqueue({
          ...dependent,
          repo,
          childDir,
          ontoRef: "origin/main",
          retargetToMain: true,
          anchor: { mergedBlocker: mergedIssue },
        });
      }
    } catch (err) {
      // The seeding pass has no PR to address — it had not got as far as choosing one.
      this.report(`restack ${repo}: nothing stacked on #${mergedIssue} could be seeded — ${describe(err)}`, repo);
    }
  }

  /** Open PRs of ours whose issue names `blocker`. The FORWARD edge, and the only one
   *  there is: GitHub's `.../dependencies/blocks` 404s, so "what does this unblock"
   *  cannot be asked — what is open is read instead, and each one asked what blocks IT. */
  private async dependents(repo: string, blocker: number): Promise<Dependent[]> {
    const found: Dependent[] = [];
    for (const pr of await this.github.listOpenPrs(repo)) {
      const ours = FEAT.exec(pr.head);
      if (!ours) continue;
      const issue = Number(ours[1]);
      try {
        const blockers = await readBlockers(this.github, repo, issue);
        if (blockers.some((b) => b.number === blocker)) found.push({ pr: pr.number, branch: pr.head, issue });
      } catch (err) {
        // Per candidate, and never wider (constraint 7): a read that failed is not "not a
        // dependent", and one unreadable issue must not cost every other branch stacked on
        // the merged blocker its restack. Addressed at the REPO — whether this PR is even
        // affected is precisely what could not be read.
        this.report(`restack ${repo}: could not tell whether #${issue} is stacked on #${blocker} — ${describe(err)}`, repo);
      }
    }
    return found;
  }

  /** Put one branch's restack on the lane. The key dedups a redelivered merge and the
   *  branch is the lock the scheduler already holds two ways (constraint 14). */
  private enqueue(step: Step): void {
    this.enqueueRestack({
      key: `restack:${step.repo}:${step.branch}`,
      branch: step.branch,
      // Caught HERE and not left to the scheduler: its backstop is an error line with no
      // repo and no target — an operator page about a key, not a report anyone can act on
      // — and it reaches no policy at all, so a 403 met mid-cascade would vanish into it.
      run: async () => {
        try {
          await this.step(step);
        } catch (err) {
          this.report(`restack ${step.branch}: ${describe(err)}`, step.repo, step.pr);
        }
      },
    });
  }

  /** One branch: resolve what it moves onto, replay its own commits there, retarget. */
  private async step(step: Step): Promise<void> {
    // Resolved to a SHA BEFORE the rebase, so `origin/main` moving mid-flight cannot
    // make the recorded fork point a lie (constraint 2).
    const ontoSha = await this.git.resolveRef(step.childDir, step.ontoRef);
    // Captured BEFORE the rebase, because the push below is what makes it unfindable:
    // this is the commit whatever is stacked on THIS branch forked from, and their only
    // anchor if their own is unreadable.
    const tip = await this.git.resolveRef(step.childDir, `origin/${step.branch}`);
    const key = `${step.repo}#${step.issue}`;
    // A branch that already carries the onto commit was moved by an earlier pass — a
    // redelivered merge, or a first pass that died after the push. Rebasing it again from
    // a fork point it has already left behind replays commits it no longer owns
    // (constraint 5). What follows still runs: both halves are idempotent, and either is
    // what that first pass may have missed.
    if (!(await this.git.isAncestor(step.childDir, ontoSha, `origin/${step.branch}`))) {
      // The branch's OWN stored fork point first, always (constraint 1): it sits inside
      // this branch's ancestry, which is what survives the blocker's branch being deleted
      // on merge and its history being force-pushed.
      const forkPoint = this.state.get(key)?.forkPoint ?? (await this.recover(step));
      if (!forkPoint) return;
      const rebase = await this.git.rebaseOnto({
        childDir: step.childDir,
        branch: step.branch,
        ontoSha,
        forkPoint,
        worktreePath: this.worktreePath(step.repo, step.branch),
      });
      // A conflict ends the step here: nothing was pushed, so the branch has not moved,
      // its recorded fork point is still true, and whatever is stacked on it is still
      // stacked on a tip that has not changed.
      if (rebase === "conflict") return await this.gate(step);
    }
    this.record(key, ontoSha);
    if (step.retargetToMain) await this.github.retargetPr(step.repo, step.pr, "main");
    this.log.info(`↪ restacked ${step.branch} onto ${step.ontoRef}`, { repo: step.repo });
    // Whatever is stacked on THIS branch is now stacked on a tip that moved, so it gets
    // the same treatment — onto this branch's new tip, and keeping its base: it was
    // never based on the branch that merged.
    for (const dependent of await this.dependents(step.repo, step.issue)) {
      this.enqueue({
        ...dependent,
        repo: step.repo,
        childDir: step.childDir,
        ontoRef: `origin/${step.branch}`,
        retargetToMain: false,
        anchor: { tip },
      });
    }
  }

  /** The fork point for a branch state has no record of — a branch created before it was
   *  recorded (#42), or a state file lost with the disk it was on. RECOVERED and never
   *  guessed (constraint 4): the rebase force-pushes, so an anchor that is merely
   *  plausible publishes somebody else's commits under this branch's name.
   *
   *  `undefined` means the step does not happen. A dependent left stacked on a merged
   *  branch is stuck and a human can see that it is; the alternative is not. */
  private async recover(step: Step): Promise<string | undefined> {
    // The cascade carries the answer with it — the parent's pre-rebase tip IS what this
    // branch forked from, and the parent's step captured it before it moved.
    if ("tip" in step.anchor) return step.anchor.tip;
    const head = `feat/${step.anchor.mergedBlocker}`;
    const merged = await this.github.mergedPrForHead(step.repo, head);
    if (!merged) {
      this.report(`restack ${step.branch}: ${head} merged through no PR, so its fork point cannot be recovered`, step.repo, step.pr);
      return undefined;
    }
    // `refs/pull/<n>/head` is the copy GitHub keeps forever, and the fetch is what makes
    // the commit present here at all: it is not under `refs/heads`, so no ordinary fetch
    // brings it and the branch it belonged to is deleted (ADR-0003). A ref the origin does
    // not have throws, which is this path's "not recoverable" — it reaches the funnel
    // through the step's own catch.
    await this.git.fetchRef(step.childDir, `refs/pull/${merged.number}/head`);
    return merged.headOid;
  }

  /** A replay git could not perform. It is a DECIDED OUTCOME, not an error: it never
   *  reaches the failure classifier, which matches the bare word `credential` and would
   *  read `CONFLICT (content): … src/auth/credentials.ts` as a dead credential and halt
   *  the whole pipeline for it (constraint 8). What a stuck branch gets instead is a
   *  human, told on the PR — `error` addressed at the PR number, which the Logger's
   *  GitHub destination posts as the comment, plus the label a human filters on. */
  private async gate(step: Step): Promise<void> {
    this.log.error(
      `⛔ restack ${step.branch}: replaying it onto ${step.ontoRef.replace(/^origin\//, "")} conflicts, and ` +
        `I will not guess at the resolution. Nothing was pushed — rebase this branch by hand and push, ` +
        `and the PR catches up.`,
      { repo: step.repo, target: step.pr },
    );
    await this.github.labelPr(step.repo, step.pr, [AWAITING_HUMAN_LABEL]);
  }

  /** The branch sits on `ontoSha` now, so that is its fork point from here on
   *  (constraint 3). MERGED into what is there, because `set` replaces the whole record
   *  and a gate's `sessionId`, the admitted `base` and a spent retry all have to survive
   *  it — and skipped entirely when there is no record, rather than inventing a `status`
   *  for an item Sunday never ran. A branch with no record still restacks; what it loses
   *  is only the cheap anchor, and the recovery path re-derives that. */
  private record(key: string, forkPoint: string): void {
    const prior = this.state.get(key);
    if (prior) this.state.set(key, { ...prior, forkPoint });
  }

  /** THE funnel. No failure in this module is logged and dropped (constraint 10): one
   *  `error` line — addressed at the PR when the step has one, so it lands where the
   *  stuck branch is — and the same text handed to the failure policy, which is what
   *  turns a 403 or a spent quota met during a restack into a pipeline halt rather than
   *  a line nobody reads (#31).
   *
   *  `text` and `repo` ONLY, deliberately (constraint 9): `failed()` reaches its item
   *  ladder only when an item is present, and that ladder acts on the dependent's ISSUE
   *  — it would spend that issue's one agent-run retry on a `gh` blip and quarantine an
   *  already-finished issue on the second. What a stuck BRANCH gets instead is the gate. */
  private report(text: string, repo: string, pr?: number): void {
    this.log.error(`✗ ${text}`, { repo, target: pr });
    this.failure.failed({ text, repo });
  }
}
