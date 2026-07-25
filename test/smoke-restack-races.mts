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
// Both drive the live path — `makeRestacker(...).restackOnMerge(...)` with an
// inline drain standing in for the scheduler's restack lane — and assert observable
// repo state on the origin (what a human would see on GitHub), never which git/gh
// command was built.
//
// Both defects are still present, so each desired outcome is recorded with
// `knownDefect`: loud, not counted, and it FAILS the moment a fix lands — which is
// how it forces promotion to a real `ok`.

import { makeFixture, knownDefect, ok, report, restackDrain, stubGhInEffect, type Fixture } from "./git-fixture.mts";

import { makeRestacker } from "../listener/restack.mts";

/** The routed repo name the scenarios pretend to be. Only ever reaches the stub. */
const FULL_NAME = "sunday-fixture/child";

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
// on the first git command that names it and the error escapes into the lane,
// leaving the dependent stacked on a branch that no longer exists.
{
  const fx = makeFixture("restack-deleted-branch");
  fx.stubGh({
    "pr list": '[{"number":110,"headRefName":"feat/10"}]',
    "dependencies/blocked_by": "9\tclosed",
  });
  ok("A: the stub gh is in effect before any production code runs", stubGhInEffect());

  fx.commit("shared.txt", "base\n", "C0 base");
  fx.push("main");

  fx.checkout("feat/9", "main");
  fx.commit("b.txt", "from B\n", "B1");
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

  console.log("\n▸ A: restacking feat/10 — the `fatal:` lines below are the defect, not a suite failure\n");
  const lane = restackDrain();
  makeRestacker(lane.enqueue).restackOnMerge(FULL_NAME, fx.cfg, "9", mergedHead);
  await lane.drain();

  const ahead = aheadOfMain(fx, "feat/10");
  knownDefect(
    "A: the dependent is rebased onto main after its blocker squash-merged with its branch deleted",
    isAncestor(fx, fx.origin, "main", "feat/10") && ahead === 1,
    `origin/feat/10 is still stacked on the deleted branch (${ahead} commits ahead of main); ` +
      `the restack step threw: ${lane.errors[0]?.message ?? "(nothing threw)"}`,
  );
}

// ── B. the blocker was force-pushed before it merged ──────────────────────────
//
// The dependent forked at B1; the blocker then rewrote its history (review asked
// for a different approach) and force-pushed B1', which is what merged. v1 hands
// B1' to the rebase as the upstream, and `B1'..feat/10` is the dependent's own
// commit PLUS the abandoned B1 — so the rebase replays both, cleanly, and
// force-pushes a dependent carrying a commit that was deliberately thrown away.
// Nothing fails; nobody is told.
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
  fx.commit("b-draft.txt", "first attempt\n", "B1 (later abandoned)");
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

  const mergedHead = fx.merge("feat/9", 92);
  fx.cloneChild();

  console.log("\n▸ B: restacking feat/10 onto a main whose blocker was force-pushed first\n");
  const lane = restackDrain();
  makeRestacker(lane.enqueue).restackOnMerge(FULL_NAME, fx.cfg, "9", mergedHead);
  await lane.drain();

  ok("B: the restack reports no failure at all", lane.errors.length === 0, lane.errors[0]?.message ?? "");
  ok(
    "B: the dependent was rebased and force-pushed onto main",
    isAncestor(fx, fx.origin, "main", "feat/10"),
    "origin/feat/10 does not descend from main",
  );

  const ahead = aheadOfMain(fx, "feat/10");
  knownDefect(
    "B: the restacked dependent carries only its own commit, not the blocker's abandoned one",
    ahead === 1 && !hasPath(fx, fx.origin, "feat/10", "b-draft.txt"),
    `origin/feat/10 is ${ahead} commits ahead of main and reintroduces b-draft.txt from the ` +
      `lineage the blocker force-pushed away`,
  );
}

report();
