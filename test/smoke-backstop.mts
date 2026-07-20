// test/smoke-backstop.mts — no-quota smoke for removePreservedWorktree.
//   devbox run node test/smoke-backstop.mts
// Drives the real failure mode on a throwaway git repo (no Sandcastle, $0): a
// worktree holding feat/1 blocks `branch -D`; the backstop force-removes it so
// deleteLocalBranch then succeeds.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { sh, deleteLocalBranch, removePreservedWorktree } from "../listener/helper.mts";

let fails = 0;
const ok = (l: string, c: boolean, d = "") => { if (!c) fails++; console.log(`${c ? "✓" : "✗"} ${l}${c ? "" : `\n    ${d}`}`); };

const root = resolve(import.meta.dirname, "smoke-bs-tmp");
rmSync(root, { recursive: true, force: true });
const main = resolve(root, "main");
mkdirSync(main, { recursive: true });
sh("git", ["init", "-q", "-b", "main"], main);
sh("git", ["config", "user.email", "s@s"], main);
sh("git", ["config", "user.name", "s"], main);
writeFileSync(resolve(main, "f.txt"), "hi\n", "utf8");
sh("git", ["add", "-A"], main);
sh("git", ["commit", "-qm", "init"], main);

// Worktree on feat/1 (as Sandcastle's branch strategy leaves it), then dirtied by
// a TRACKED-file edit — the case the .scratch exclude can't catch.
const wt = resolve(root, "wt");
sh("git", ["worktree", "add", "-q", "-b", "feat/1", wt, "main"], main);
writeFileSync(resolve(wt, "f.txt"), "dirty\n", "utf8");

let blocked = false;
try { sh("git", ["branch", "-D", "feat/1"], main); } catch { blocked = true; }
ok("branch -D is blocked while the worktree holds it", blocked);

removePreservedWorktree(main, wt);
ok("worktree dir is removed", !existsSync(wt));

deleteLocalBranch(main, "feat/1");
ok("branch is gone after backstop + delete", !sh("git", ["branch", "--list", "feat/1"], main));

// Already-removed path is best-effort — logs, never throws.
removePreservedWorktree(main, wt);
ok("second remove on a gone worktree does not throw", true);

rmSync(root, { recursive: true, force: true });
console.log(fails === 0 ? "\nAll backstop smokes pass." : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
