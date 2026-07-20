// test/run.mts — the `npm test` entrypoint. Runs every hermetic smoke in this
// dir (`smoke-*.mts`) as its own subprocess (each one owns `process.exit`), and
// aggregates pass/fail. $0, no network/GitHub — the live smokes (dag, pr-comments,
// gate, telegram) stay manual under .scratch/. `node test/run.mts` or `npm test`.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

const dir = import.meta.dirname;
const smokes = readdirSync(dir)
  .filter((f) => f.startsWith("smoke-") && f.endsWith(".mts"))
  .sort();

let failed = 0;
for (const f of smokes) {
  process.stdout.write(`\n▶ ${f}\n`);
  try {
    process.stdout.write(
      execFileSync(process.execPath, [resolve(dir, f)], { encoding: "utf8", timeout: 120_000 }),
    );
  } catch (err) {
    failed++;
    const e = err as { stdout?: string; stderr?: string };
    if (e.stdout) process.stdout.write(e.stdout);
    if (e.stderr) process.stderr.write(e.stderr);
    process.stdout.write(`✗ ${f} FAILED\n`);
  }
}

console.log(`\n${"═".repeat(48)}`);
console.log(failed === 0 ? `✅ all ${smokes.length} smoke files pass` : `❌ ${failed}/${smokes.length} smoke files FAILED`);
process.exit(failed === 0 ? 0 : 1);
