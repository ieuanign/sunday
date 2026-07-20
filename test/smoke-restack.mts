// test/smoke-restack.mts — no-quota, no-GitHub smoke for 6c hostRebase.
//   devbox run node test/smoke-restack.mts
// Builds a local stacked git fixture (bare origin + clone) and exercises the
// real rebase mechanic: a clean restack pushes A onto main; a conflicting one
// aborts, pushes nothing, and tears the worktree down. The gh glue (dependents,
// retarget, gateConflict) is exercised only in the user-driven e2e run.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { hostRebase } from "../listener/restack.mts";

const ROOT = new URL(".", import.meta.url).pathname;
let fails = 0;

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}
function ok(label: string, cond: boolean, detail = ""): void {
  if (!cond) fails++;
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : `\n    ${detail}`}`);
}

/** A bare origin + a working clone with identity configured. */
function freshRepo(name: string): { origin: string; work: string } {
  const base = resolve(ROOT, "fixture-restack", name);
  rmSync(base, { recursive: true, force: true });
  mkdirSync(base, { recursive: true });
  const origin = resolve(base, "origin.git");
  const work = resolve(base, "work");
  git(base, "init", "--bare", "-b", "main", origin);
  git(base, "clone", origin, work);
  git(work, "config", "user.email", "smoke@sunday.local");
  git(work, "config", "user.name", "smoke");
  return { origin, work };
}
function commit(work: string, file: string, content: string, msg: string): string {
  writeFileSync(resolve(work, file), content, "utf8");
  git(work, "add", file);
  git(work, "commit", "-m", msg);
  return git(work, "rev-parse", "HEAD");
}

// ── clean restack: A (adds a.txt) rebases onto a main that already carries B's
//    change; no file overlap → clean, A lands one commit atop main ────────────
{
  const { work } = freshRepo("clean");
  commit(work, "shared.txt", "base\n", "C0 base");
  git(work, "push", "-u", "origin", "main");

  git(work, "checkout", "-b", "feat/B");
  const bHead = commit(work, "b.txt", "from B\n", "B1");
  git(work, "push", "-u", "origin", "feat/B");

  git(work, "checkout", "-b", "feat/A", "feat/B");
  commit(work, "a.txt", "from A\n", "A1");
  git(work, "push", "-u", "origin", "feat/A");

  // B merges into main (its change lands as a new commit); branch feat/B stays.
  git(work, "checkout", "main");
  commit(work, "b.txt", "from B\n", "M1 (B merged)");
  git(work, "push", "origin", "main");

  const status = await hostRebase(work, "feat/A", "origin/main", bHead);
  ok("clean → status clean", status === "clean", `got ${status}`);

  const mainTip = git(work, "rev-parse", "origin/main");
  const base = git(work, "merge-base", "origin/main", "origin/feat/A");
  ok("feat/A now sits on main", base === mainTip, `base ${base} !== main ${mainTip}`);
  const ahead = git(work, "rev-list", "--count", "origin/main..origin/feat/A");
  ok("feat/A is one commit ahead of main", ahead === "1", `ahead ${ahead}`);
  const hasA = (() => {
    try { git(work, "cat-file", "-e", "origin/feat/A:a.txt"); return true; } catch { return false; }
  })();
  ok("A's file survived the rebase", hasA);
  ok("worktree torn down", !existsSync(resolve(work, ".sunday", "restack", "feat-A")));
}

// ── conflicting restack: A edits shared.txt, main edits it differently →
//    rebase aborts, nothing is pushed, worktree is cleaned ──────────────────
{
  const { work } = freshRepo("conflict");
  commit(work, "shared.txt", "base\n", "C0 base");
  git(work, "push", "-u", "origin", "main");

  git(work, "checkout", "-b", "feat/B");
  const bHead = commit(work, "b.txt", "from B\n", "B1");
  git(work, "push", "-u", "origin", "feat/B");

  git(work, "checkout", "-b", "feat/A", "feat/B");
  const aHead = commit(work, "shared.txt", "from A\n", "A1 edits shared");
  git(work, "push", "-u", "origin", "feat/A");

  git(work, "checkout", "main");
  commit(work, "shared.txt", "from main\n", "M1 edits shared + merges B");
  git(work, "push", "origin", "main");

  const status = await hostRebase(work, "feat/A", "origin/main", bHead);
  ok("conflict → status conflict", status === "conflict", `got ${status}`);
  const tip = git(work, "rev-parse", "origin/feat/A");
  ok("feat/A left untouched (nothing pushed)", tip === aHead, `tip ${tip} !== A1 ${aHead}`);
  ok("worktree torn down after abort", !existsSync(resolve(work, ".sunday", "restack", "feat-A")));
}

rmSync(resolve(ROOT, "fixture-restack"), { recursive: true, force: true });
console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
