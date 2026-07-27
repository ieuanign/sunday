// test/smoke-restack-races.mts — the two merge races that motivated V2's
// fork-point anchor (ADR-0003), reproduced against a real bare origin.
//   node test/smoke-restack-races.mts
//
// v1 rebases a dependent using the blocker's FINAL TIP (the merge webhook's
// head.sha) as the upstream. That tip is not in the dependent's own ancestry, so
// two things can go wrong once the blocker merges — both invisible in production:
//   A. the head branch is deleted on merge → the tip is unreachable locally and
//      the restack blows up mid-flight;
//   B. the blocker was force-pushed → the tip is a lineage the dependent never
//      forked from, so the rebase SUCCEEDS and quietly force-pushes the blocker's
//      abandoned commits onto the dependent.
//
// V2 anchors on the dependent's OWN recorded fork point instead (`var/state.json`,
// #42), which sits inside its ancestry — so neither race is expressible. Both
// scenarios drive the live path (`Restacker.onMerge`, with an inline drain standing
// in for the scheduler's restack lane) and assert observable repo state on the
// origin (what a human would see on GitHub), never which git/gh command was built.
//
// Both were `knownDefect` markers against v1 until #43 landed. They are plain
// assertions now: this file is the gate that keeps them fixed.

import { resolve } from "node:path";

import { FailurePolicy } from "../assignor/failure.mts";
import { PauseStore } from "../assignor/pause.mts";
import { Restacker } from "../assignor/restack.mts";
import type { Scheduler } from "../assignor/scheduler.mts";
import { StateStore } from "../assignor/state.mts";
import { GitCli } from "../services/git.mts";
import { Gh } from "../services/github/index.mts";
import { Logger, type Destinations } from "../services/logger.mts";
import { makeFixture, ok, report, restackDrain, stubGhInEffect, type Fixture } from "./git-fixture.mts";

/** The repo root — what the routing table's child paths are resolved against. */
const ROOT = resolve(import.meta.dirname, "..");

/** The routed repo name the scenarios pretend to be. Only ever reaches the stub. */
const FULL_NAME = "sunday-fixture/child";

// ── the restacker under test ──────────────────────────────────────────────────

/** A scheduler that starts nothing: what these scenarios drain is `restackDrain()`,
 *  and what this stands in for is only the pipeline a failure would stop (#39). */
const HALTED: Scheduler = {
  enqueue() {},
  enqueueRestack() {},
  pause() {},
  resume() {},
  isPaused: () => false,
  snapshot: () => ({ paused: false, regularInFlight: [], restackInFlight: [], regularQueued: [], restackQueued: [] }),
};

/** The real `Restacker` over the fixture: real git, the real `Gh` against the stub on
 *  PATH, and a real `StateStore` in the fixture's own directory. */
function restackerFor(fx: Fixture): { restacker: Restacker; state: StateStore; lane: ReturnType<typeof restackDrain> } {
  const silent: Destinations = { console() {}, runLog() {}, eventLog() {}, github() {}, phone() {} };
  const logger = new Logger(silent);
  const state = new StateStore(resolve(fx.root, "state.json"));
  const lane = restackDrain();
  const failure = new FailurePolicy({
    pause: new PauseStore(resolve(fx.root, "pause.json")),
    scheduler: HALTED,
    state,
    github: { addLabels: async () => {} },
    log: logger.child("failure"),
  });
  const restacker = new Restacker({
    repos: { [FULL_NAME]: fx.cfg },
    github: new Gh(),
    git: new GitCli(),
    enqueueRestack: lane.enqueue,
    state,
    failure,
    log: logger.child("restack"),
    parentRoot: ROOT,
    // Under the fixture, never the real `var/`: a smoke leaves nothing behind.
    worktreePath: (_repo, branch) => resolve(fx.root, "restack", branch.replaceAll("/", "-")),
  });
  return { restacker, state, lane };
}

// ── observable repo state ─────────────────────────────────────────────────────

function hasCommit(fx: Fixture, dir: string, sha: string): boolean {
  try {
    fx.git(dir, "cat-file", "-e", `${sha}^{commit}`);
    return true;
  } catch {
    return false;
  }
}

function hasPath(fx: Fixture, dir: string, ref: string, path: string): boolean {
  try {
    fx.git(dir, "cat-file", "-e", `${ref}:${path}`);
    return true;
  } catch {
    return false;
  }
}

function isAncestor(fx: Fixture, dir: string, maybeAncestor: string, ref: string): boolean {
  try {
    fx.git(dir, "merge-base", "--is-ancestor", maybeAncestor, ref);
    return true;
  } catch {
    return false;
  }
}

/** How many commits `branch` carries on top of main, ON THE ORIGIN. */
function aheadOfMain(fx: Fixture, branch: string): number {
  return Number(fx.git(fx.origin, "rev-list", "--count", `main..${branch}`));
}

// ── A. the blocker squash-merged and its head branch was deleted ──────────────
//
// The dependent forked at B1; the blocker then added B2 and squash-merged, so
// neither B1 nor B2 is in main's ancestry and B2 lives only at
// `refs/pull/<n>/head` once the branch is deleted. v1 hands B2 to the restack step
// as the upstream — a commit the child clone has never heard of — so the step dies
// on the first git command that names it, leaving the dependent stacked on a branch
// that no longer exists. B1 is in the dependent's OWN ancestry, and that is what V2
// recorded when it created the branch.
{
  const fx = makeFixture("restack-deleted-branch");
  fx.stubGh({
    "pr list": '[{"number":110,"headRefName":"feat/10"}]',
    "dependencies/blocked_by": "9\tclosed",
    // The retarget the step performs once the rebase lands: the base the PR named is
    // the branch that just merged and was deleted with it.
    "pr edit": "",
  });
  ok("A: the stub gh is in effect before any production code runs", stubGhInEffect());

  fx.commit("shared.txt", "base\n", "C0 base");
  fx.push("main");

  fx.checkout("feat/9", "main");
  const forkPoint = fx.commit("b.txt", "from B\n", "B1");
  fx.push("feat/9");

  // The dependent forks HERE — B1 is the fork point, and the only blocker commit
  // it will ever have in its own ancestry.
  fx.checkout("feat/10", "feat/9");
  fx.commit("a.txt", "from A\n", "A1");
  fx.push("feat/10");

  // …and only then does the blocker take review feedback and move on.
  fx.checkout("feat/9");
  fx.commit("b.txt", "from B, revised\n", "B2 (after A forked)");
  fx.push("feat/9");

  // "Squash and merge" + "automatically delete head branches" — the default on
  // two of the three routed repos.
  const mergedHead = fx.squashMerge("feat/9", 91);
  fx.deleteOnOrigin("feat/9");

  const child = fx.cloneChild();
  ok(
    "A: the merged blocker's tip survives on the origin at refs/pull/91/head",
    fx.git(fx.origin, "rev-parse", "refs/pull/91/head") === mergedHead,
  );
  ok(
    "A: …but a fresh clone of the origin does not have that commit",
    !hasCommit(fx, child, mergedHead),
    `${mergedHead} is present in ${child} — the race cannot reproduce`,
  );

  const { restacker, state, lane } = restackerFor(fx);
  // What the run that created feat/10 recorded (#42) — and what it is anchored on.
  state.set(`${FULL_NAME}#10`, { status: "in-flight", base: "feat/9", forkPoint });

  await restacker.onMerge(FULL_NAME, 9);
  await lane.drain();

  ok("A: nothing escaped the restack lane", lane.errors.length === 0, lane.errors[0]?.message ?? "");
  const ahead = aheadOfMain(fx, "feat/10");
  ok(
    "A: the dependent is rebased onto main after its blocker squash-merged with its branch deleted",
    isAncestor(fx, fx.origin, "main", "feat/10") && ahead === 1,
    `origin/feat/10 is ${ahead} commit(s) ahead of main and ` +
      `${isAncestor(fx, fx.origin, "main", "feat/10") ? "descends from" : "does not descend from"} it`,
  );
  ok("A: the dependent's own work survived the move", fx.git(fx.origin, "show", "feat/10:a.txt") === "from A");
}

// ── B. the blocker was force-pushed before it merged ──────────────────────────
//
// The dependent forked at B1; the blocker then rewrote its history (review asked
// for a different approach) and force-pushed B1', which is what merged. v1 hands
// B1' to the rebase as the upstream, and `B1'..feat/10` is the dependent's own
// commit PLUS the abandoned B1 — so the rebase replays both, cleanly, and
// force-pushes a dependent carrying a commit that was deliberately thrown away.
// Nothing fails; nobody is told. The recorded fork point is B1, which bounds the
// replay to the dependent's own commit whatever the blocker did to its history.
{
  const fx = makeFixture("restack-force-pushed-blocker");
  fx.stubGh({
    "pr list": '[{"number":120,"headRefName":"feat/10"}]',
    "dependencies/blocked_by": "9\tclosed",
    // The retarget the step performs once the rebase lands. Stubbed so it cannot
    // reach a real repository.
    "pr edit": "",
  });
  ok("B: the stub gh is in effect before any production code runs", stubGhInEffect());

  fx.commit("shared.txt", "base\n", "C0 base");
  fx.push("main");

  fx.checkout("feat/9", "main");
  const forkPoint = fx.commit("b-draft.txt", "first attempt\n", "B1 (later abandoned)");
  fx.push("feat/9");

  fx.checkout("feat/10", "feat/9");
  fx.commit("a.txt", "from A\n", "A1");
  fx.push("feat/10");

  // The rewrite touches a DIFFERENT file from the abandoned commit, so replaying
  // B1 onto main is clean — a conflicting replay would surface as "conflict" and
  // hide the duplication this scenario is about.
  fx.checkout("feat/9");
  fx.git(fx.author, "reset", "--hard", "main");
  fx.commit("b-final.txt", "second attempt\n", "B1' (the rewrite)");
  fx.forcePush("feat/9");

  fx.merge("feat/9", 92);
  fx.cloneChild();

  const { restacker, state, lane } = restackerFor(fx);
  state.set(`${FULL_NAME}#10`, { status: "in-flight", base: "feat/9", forkPoint });

  await restacker.onMerge(FULL_NAME, 9);
  await lane.drain();

  ok("B: the restack reports no failure at all", lane.errors.length === 0, lane.errors[0]?.message ?? "");
  ok(
    "B: the dependent was rebased and force-pushed onto main",
    isAncestor(fx, fx.origin, "main", "feat/10"),
    "origin/feat/10 does not descend from main",
  );

  const ahead = aheadOfMain(fx, "feat/10");
  ok(
    "B: the restacked dependent carries only its own commit, not the blocker's abandoned one",
    ahead === 1 && !hasPath(fx, fx.origin, "feat/10", "b-draft.txt"),
    `origin/feat/10 is ${ahead} commits ahead of main and reintroduces b-draft.txt from the ` +
      `lineage the blocker force-pushed away`,
  );
}

report();
