// test/smoke-git.mts — hermetic smoke for the child checkout's git seam (V2, #36).
//   node test/smoke-git.mts
// Real git against a temporary bare origin (test/git-fixture.mts): offline, $0, no
// network and no GitHub. `Gh` is deliberately untested — it needs a token and the
// network — but git is free, so the seam a run reaches the child checkout through is
// driven for real here and asserted on observable repo state, never on which git
// command was built.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { GitCli } from "../services/git.mts";
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
