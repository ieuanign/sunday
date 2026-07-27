// test/smoke-git.mts — hermetic smoke for the child checkout's git seam (V2, #36).
//   node test/smoke-git.mts
// Real git against a temporary bare origin (test/git-fixture.mts): offline, $0, no
// network and no GitHub. `Gh` is deliberately untested — it needs a token and the
// network — but git is free, so the seam a run reaches the child checkout through is
// driven for real here and asserted on observable repo state, never on which git
// command was built.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { GitCli } from "#services/git.mts";
import { makeFixture, ok, report } from "./git-fixture.mts";

const git = new GitCli();

/** Does `ref` resolve in `dir`? — how a human would check what a checkout can see. */
function hasRef(fx: { git(dir: string, ...args: string[]): string }, dir: string, ref: string): boolean {
  try {
    fx.git(dir, "rev-parse", "--verify", ref);
    return true;
  } catch {
    return false;
  }
}

/** Is the COMMIT `sha` present in `dir`'s object database? Peeled with `^{commit}`
 *  deliberately: a bare `rev-parse --verify <40-hex>` echoes the sha back and exits 0
 *  whether or not the object exists, so it cannot answer this. */
function hasCommit(fx: { git(dir: string, ...args: string[]): string }, dir: string, sha: string): boolean {
  try {
    fx.git(dir, "cat-file", "-e", `${sha}^{commit}`);
    return true;
  } catch {
    return false;
  }
}

// ── ahead-count: what decides whether there is anything to ship at all ────────
{
  const fx = makeFixture("git-ahead");
  fx.commit("shared.txt", "base\n", "C0 base");
  fx.push("main");
  const child = fx.cloneChild();

  fx.git(child, "checkout", "-b", "feat/9");
  fx.git(child, "commit", "--allow-empty", "-m", "A1");
  fx.git(child, "commit", "--allow-empty", "-m", "A2");

  ok("ahead: a branch's own commits are counted against the base ref", (await git.aheadCount(child, "origin/main", "feat/9")) === 2, String(await git.aheadCount(child, "origin/main", "feat/9")));

  // AC5/AC6: an agent that committed nothing must read as an honest "nothing to
  // ship", and a run whose branch was never created at all is the same answer — not
  // a crash the classifier then has to interpret.
  fx.git(child, "checkout", "main");
  fx.git(child, "branch", "-D", "feat/9");
  ok("ahead: a branch that does not exist is zero ahead, not a throw", (await git.aheadCount(child, "origin/main", "feat/9")) === 0);

  // …but a base that does not resolve is NOT zero: a fetch that silently failed
  // would otherwise read as "nothing to ship" and the run would report success
  // having shipped nothing.
  let thrown: unknown;
  await git.aheadCount(child, "origin/nope", "main").catch((err: unknown) => void (thrown = err));
  ok("ahead: a base ref that does not resolve fails loudly", thrown !== undefined, "counting against a missing base returned a number");
}

// ── the diff stat: the "16 files, +1533/−49" the PR footer states (#37) ───────
{
  const fx = makeFixture("git-diffstat");
  fx.commit("shared.txt", "base\n", "C0 base");
  fx.push("main");
  const child = fx.cloneChild();

  fx.git(child, "checkout", "-b", "feat/9");
  writeFileSync(resolve(child, "notes.md"), "one\ntwo\nthree\n", "utf8");
  writeFileSync(resolve(child, "shared.txt"), "changed\n", "utf8");
  fx.git(child, "add", "-A");
  fx.git(child, "commit", "-m", "A1");

  const stat = await git.diffStat(child, "origin/main", "feat/9");
  ok("stat: the branch's own files, insertions and deletions are counted", stat.files === 2 && stat.insertions === 4 && stat.deletions === 1, JSON.stringify(stat));

  // The base moves while the run works — somebody else's PR merged. The footer must
  // still state what THIS branch changed, exactly as the PR's own diff shows it, not
  // the base's commits read backwards.
  fx.commit("other.txt", "theirs\nagain\n", "C1 someone else");
  fx.push("main");
  await git.fetchPrune(child);
  const after = await git.diffStat(child, "origin/main", "feat/9");
  ok("stat: a base that moved under the branch does not enter its stat", after.files === 2 && after.insertions === 4 && after.deletions === 1, JSON.stringify(after));
}

// ── the scratch exclude: what stops the floor's own files blocking cleanup ────
{
  const fx = makeFixture("git-exclude");
  fx.commit("shared.txt", "base\n", "C0 base");
  fx.push("main");
  const child = fx.cloneChild();
  const excludePath = resolve(child, ".git", "info", "exclude");
  writeFileSync(excludePath, "# the child's own\nnotes.txt\n", "utf8");

  await git.excludeScratch(child);

  // The injected floor's sub-agents write their plans into `.scratch/` INSIDE the
  // child worktree. A dirty worktree makes the agent library preserve it, which then
  // holds the branch checked out and blocks the run's cleanup.
  mkdirSync(resolve(child, ".scratch"), { recursive: true });
  writeFileSync(resolve(child, ".scratch", "plan.md"), "a sub-agent's plan\n", "utf8");
  ok("exclude: the floor's scratch does not dirty the child worktree", fx.git(child, "status", "--porcelain") === "", fx.git(child, "status", "--porcelain"));
  ok("exclude: the child's own excludes are left alone", readFileSync(excludePath, "utf8").includes("notes.txt"));

  // Runs before EVERY run, including on a child that was onboarded before this
  // existed — so it has to be idempotent rather than append a line each time.
  await git.excludeScratch(child);
  const occurrences = readFileSync(excludePath, "utf8").split("\n").filter((l) => l.trim() === ".scratch/").length;
  ok("exclude: applying it twice leaves one entry", occurrences === 1, `${occurrences} entries`);
}

// ── fetch -p and push: the two ends of a run's contact with the origin ────────
{
  const fx = makeFixture("git-fetch-push");
  fx.commit("shared.txt", "base\n", "C0 base");
  fx.push("main");
  const child = fx.cloneChild();

  // Somebody else's branch, published after this checkout was made.
  fx.checkout("feat/9", "main");
  fx.commit("b.txt", "from B\n", "B1");
  fx.push("feat/9");
  ok("fetch: the checkout starts out unaware of a branch published after it cloned", !hasRef(fx, child, "origin/feat/9"));

  await git.fetchPrune(child);
  ok("fetch: the run starts from what the origin has NOW", hasRef(fx, child, "origin/feat/9"));

  // GitHub deletes a head branch on merge. A remote ref left behind is a base that
  // looks alive and is not — the race ADR-0003 re-anchors stacking against.
  fx.deleteOnOrigin("feat/9");
  await git.fetchPrune(child);
  ok("fetch: a branch deleted on the origin is pruned, not left looking alive", !hasRef(fx, child, "origin/feat/9"));

  fx.git(child, "checkout", "-b", "feat/10");
  fx.git(child, "commit", "--allow-empty", "-m", "A1");
  const head = fx.git(child, "rev-parse", "HEAD");
  await git.push(child, "feat/10");
  ok("push: the run's own commits reach the origin under their branch", fx.git(fx.origin, "rev-parse", "feat/10") === head);
}

// ── resolveRef: the commit a run's branch is actually created FROM (#42) ─────
{
  const fx = makeFixture("git-resolve");
  fx.commit("shared.txt", "base\n", "C0 base");
  fx.push("main");
  fx.checkout("feat/9", "main");
  const blockerTip = fx.commit("b.txt", "from the blocker\n", "B1");
  fx.push("feat/9");
  const child = fx.cloneChild();

  ok(
    "resolve: a remote ref answers with the commit it points at — the fork point ADR-0003 anchors on",
    (await git.resolveRef(child, "origin/feat/9")) === blockerTip,
    `${await git.resolveRef(child, "origin/feat/9")} !== ${blockerTip}`,
  );

  // A blocker's branch deleted on merge between admission and the run. Resolved to
  // nothing, the agent would be handed a start point that is not a commit — so this
  // fails the run loudly instead (ADR-0003).
  fx.deleteOnOrigin("feat/9");
  await git.fetchPrune(child);
  let thrown: unknown;
  await git.resolveRef(child, "origin/feat/9").catch((err: unknown) => void (thrown = err));
  ok("resolve: a ref that no longer resolves throws rather than answering with nothing", thrown !== undefined, String(await git.resolveRef(child, "origin/feat/9").catch(() => "threw")));
}

// ── remoteBranchExists: does the ORIGIN still hold the base, right now (#38) ──
{
  const fx = makeFixture("git-remote-branch");
  fx.commit("shared.txt", "base\n", "C0 base");
  fx.push("main");
  fx.checkout("feat/9", "main");
  fx.commit("b.txt", "from the blocker\n", "B1");
  fx.push("feat/9");
  const child = fx.cloneChild();

  ok("remote base: a branch the origin has reads as present", (await git.remoteBranchExists(child, "feat/9")) === true);

  // The base merged and GitHub deleted its head branch while the agent worked. The
  // `origin/feat/9` this checkout fetched before the run still resolves locally — asking
  // THAT would ship a stacked PR onto a base that no longer exists.
  fx.deleteOnOrigin("feat/9");
  ok("remote base: the ref fetched before the run still looks alive locally", hasRef(fx, child, "origin/feat/9"));
  ok(
    "remote base: …but the origin is what is asked, so a base deleted mid-run reads as gone",
    (await git.remoteBranchExists(child, "feat/9")) === false,
  );

  // A tag is not something a PR can target or a branch can be pushed to, and repos tag
  // releases after the branch of the same name is gone.
  fx.git(fx.origin, "update-ref", "refs/tags/feat/9", fx.git(fx.origin, "rev-parse", "main"));
  ok("remote base: a TAG of the same name is not a base", (await git.remoteBranchExists(child, "feat/9")) === false);
}

// ── isAncestor: what makes an already-restacked branch a skip, not a second rebase ──
{
  const fx = makeFixture("git-ancestor");
  const forkPoint = fx.commit("shared.txt", "base\n", "C0 base");
  fx.push("main");
  fx.checkout("feat/9", "main");
  fx.commit("a.txt", "from A\n", "A1");
  fx.push("feat/9");
  // main moves on without the branch — somebody else's PR merged while A worked.
  fx.checkout("main");
  const mainTip = fx.commit("other.txt", "theirs\n", "C1 someone else");
  fx.push("main");
  const child = fx.cloneChild();

  ok(
    "ancestor: a branch that does not carry the onto commit is still owed its rebase",
    (await git.isAncestor(child, mainTip, "origin/feat/9")) === false,
  );
  ok(
    "ancestor: the commit a branch forked from is in its ancestry",
    (await git.isAncestor(child, forkPoint, "origin/feat/9")) === true,
  );
}

// ── fetchRef: recovering a merged blocker's tip after GitHub deleted the branch ──
{
  const fx = makeFixture("git-fetch-ref");
  fx.commit("shared.txt", "base\n", "C0 base");
  fx.push("main");
  fx.checkout("feat/9", "main");
  const blockerTip = fx.commit("b.txt", "from the blocker\n", "B1");
  fx.push("feat/9");
  // Squash-merged, then the head branch deleted — GitHub's defaults, and between them
  // the only copy of the fork point left anywhere is `refs/pull/7/head` (ADR-0003).
  fx.squashMerge("feat/9", 7);
  fx.deleteOnOrigin("feat/9");
  const child = fx.cloneChild();

  ok("fetch-ref: a squash-merged, deleted blocker's tip is absent from a fresh clone", !hasCommit(fx, child, blockerTip));

  await git.fetchRef(child, "refs/pull/7/head");
  ok("fetch-ref: the PR head GitHub keeps forever makes the fork point reachable again", hasCommit(fx, child, blockerTip));

  // The recovery's own "not recoverable" signal: nothing downstream may treat a fetch
  // that never happened as an anchor, because a guessed anchor force-pushes somebody
  // else's commits.
  let thrown: unknown;
  await git.fetchRef(child, "refs/pull/99/head").catch((err: unknown) => void (thrown = err));
  ok("fetch-ref: a ref the origin does not have fails loudly", thrown !== undefined);
}

// ── rebaseOnto: the restack itself — a dependent moved off its merged blocker ──
{
  const fx = makeFixture("git-rebase");
  fx.commit("shared.txt", "base\n", "C0 base");
  fx.push("main");
  // The blocker, and the dependent stacked on it (#42): feat/10 forks from feat/9's tip,
  // which is the fork point ADR-0003 has the Assignor record.
  fx.checkout("feat/9", "main");
  const forkPoint = fx.commit("b.txt", "from the blocker\n", "B1");
  fx.push("feat/9");
  fx.checkout("feat/10", "feat/9");
  fx.commit("a.txt", "from the dependent\n", "A1");
  fx.push("feat/10");
  // The blocker merges the way GitHub does it by default: squashed, so B1 itself never
  // enters main's ancestry, and the head branch deleted.
  fx.squashMerge("feat/9", 7);
  fx.deleteOnOrigin("feat/9");
  const child = fx.cloneChild();
  await git.fetchPrune(child);
  const mainTip = await git.resolveRef(child, "origin/main");
  const worktreePath = resolve(fx.root, "restack", "feat-10");

  const result = await git.rebaseOnto({ childDir: child, branch: "feat/10", ontoSha: mainTip, forkPoint, worktreePath });
  ok("rebase: a replay that git could perform answers clean", result === "clean", result);

  // What the origin — the only thing a human or GitHub ever sees — now holds.
  ok(
    "rebase: the dependent carries its OWN commit and nothing else on top of the new base",
    fx.git(fx.origin, "rev-list", "--count", "main..feat/10") === "1",
    fx.git(fx.origin, "rev-list", "--oneline", "main..feat/10"),
  );
  ok("rebase: the dependent's own work survived the move", fx.git(fx.origin, "show", "feat/10:a.txt") === "from the dependent");
  ok(
    "rebase: the blocker's work is on the branch once — through main, not replayed",
    fx.git(fx.origin, "show", "feat/10:b.txt") === "from the blocker",
  );
  ok("rebase: the new base is now in the branch's ancestry — a second pass has nothing to do", await git.isAncestor(child, mainTip, "origin/feat/10"));

  // Constraint 13: nothing is left holding a checkout, on any path.
  ok("rebase: the ephemeral worktree is torn down", !existsSync(worktreePath) && !fx.git(child, "worktree", "list", "--porcelain").includes(worktreePath), fx.git(child, "worktree", "list", "--porcelain"));
}

// ── rebaseOnto: a replay git cannot perform is an answer, not an exception ────
{
  const fx = makeFixture("git-rebase-conflict");
  fx.commit("shared.txt", "base\n", "C0 base");
  fx.push("main");
  fx.checkout("feat/9", "main");
  const forkPoint = fx.commit("b.txt", "from the blocker\n", "B1");
  fx.push("feat/9");
  fx.checkout("feat/10", "feat/9");
  fx.commit("shared.txt", "the dependent's line\n", "A1");
  fx.push("feat/10");
  fx.squashMerge("feat/9", 7);
  fx.deleteOnOrigin("feat/9");
  // Somebody else's PR touched the same lines the dependent did — the one thing that
  // makes a replay genuinely undecidable.
  fx.checkout("main");
  fx.commit("shared.txt", "somebody else's line\n", "C1 someone else");
  fx.push("main");
  const child = fx.cloneChild();
  const before = fx.git(fx.origin, "rev-parse", "feat/10");
  const mainTip = await git.resolveRef(child, "origin/main");
  const worktreePath = resolve(fx.root, "restack", "feat-10");

  const result = await git.rebaseOnto({ childDir: child, branch: "feat/10", ontoSha: mainTip, forkPoint, worktreePath });
  ok("conflict: a replay git cannot perform answers conflict rather than throwing", result === "conflict", result);
  ok("conflict: nothing was pushed — the PR still holds exactly what its author left", fx.git(fx.origin, "rev-parse", "feat/10") === before);
  ok(
    "conflict: the ephemeral worktree is torn down on the conflict path too",
    !existsSync(worktreePath) && !fx.git(child, "worktree", "list", "--porcelain").includes(worktreePath),
    fx.git(child, "worktree", "list", "--porcelain"),
  );

  // A rebase that never STARTED is not a conflict a human should be gated on — it is a
  // tool failure, and the caller has to be able to tell them apart.
  let thrown: unknown;
  await git
    .rebaseOnto({ childDir: child, branch: "feat/10", ontoSha: "0000000000000000000000000000000000000000", forkPoint, worktreePath })
    .catch((err: unknown) => void (thrown = err));
  ok("conflict: an onto ref that does not resolve throws instead of reading as a conflict", thrown !== undefined);
}

// ── cleanup: the preserved worktree, then the local branch ───────────────────
{
  const fx = makeFixture("git-cleanup");
  fx.commit("shared.txt", "base\n", "C0 base");
  fx.push("main");
  const child = fx.cloneChild();
  fx.git(child, "branch", "feat/9");

  // What the agent library leaves behind when a run dirties its worktree past the
  // scratch exclude (a tracked-file edit): the worktree is PRESERVED host-side, and it
  // holds the run's branch checked out.
  const preserved = resolve(child, "..", "preserved-feat-9");
  fx.git(child, "worktree", "add", preserved, "feat/9");
  writeFileSync(resolve(preserved, "left-behind.txt"), "an agent's uncommitted edit\n", "utf8");

  let blocked: unknown;
  await git.deleteBranch(child, "feat/9").catch((err: unknown) => void (blocked = err));
  ok("cleanup: a preserved worktree blocks the branch delete — hence the order", blocked !== undefined);

  await git.removeWorktree(child, preserved);
  ok("cleanup: the preserved worktree is removed even though it was left dirty", !existsSync(preserved));

  await git.deleteBranch(child, "feat/9");
  ok("cleanup: the local branch is gone once the origin holds its history", fx.git(child, "branch", "--list", "feat/9") === "");

  // Cleanup runs on every non-gated path, including one that never created a branch.
  let again: unknown;
  await git.deleteBranch(child, "feat/9").catch((err: unknown) => void (again = err));
  ok("cleanup: deleting a branch that is already gone is not a failure", again === undefined, String(again));
}

report();
