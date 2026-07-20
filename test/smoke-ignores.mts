// test/smoke-ignores.mts — no-quota smoke for ensureSandboxIgnores.
//   devbox run node test/smoke-ignores.mts
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ensureSandboxIgnores } from "../listener/helper.mts";

let fails = 0;
const ok = (l: string, c: boolean, d = "") => { if (!c) fails++; console.log(`${c ? "✓" : "✗"} ${l}${c ? "" : `\n    ${d}`}`); };

const dir = resolve(import.meta.dirname, "smoke-ign-tmp");
rmSync(dir, { recursive: true, force: true });
mkdirSync(resolve(dir, ".git", "info"), { recursive: true });
const ex = resolve(dir, ".git", "info", "exclude");

ensureSandboxIgnores(dir);
ok("adds .scratch/ to a fresh exclude", existsSync(ex) && readFileSync(ex, "utf8").includes(".scratch/"));

const after1 = readFileSync(ex, "utf8");
ensureSandboxIgnores(dir);
ok("idempotent — second call adds nothing", readFileSync(ex, "utf8") === after1, "file changed on repeat");

// preserves a pre-existing exclude's content
rmSync(dir, { recursive: true, force: true });
mkdirSync(resolve(dir, ".git", "info"), { recursive: true });
writeFileSync(ex, "node_modules/\n", "utf8");
ensureSandboxIgnores(dir);
const merged = readFileSync(ex, "utf8");
ok("preserves existing entries + appends", merged.includes("node_modules/") && merged.includes(".scratch/"), merged);

rmSync(dir, { recursive: true, force: true });
console.log(fails === 0 ? "\nAll ignores smokes pass." : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
