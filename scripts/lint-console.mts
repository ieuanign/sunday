// scripts/lint-console.mts — `npm run lint`. Fails on a bare console write in Sunday's
// own code, so output cannot bypass the Logger (and with it the run log, the event
// log, the issue and the phone). No dependency: the repo has no lint tooling, and this
// is ~40 lines.

import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Dirs the check does not enter. Exclusion-based, so a NEW module is covered the
 *  moment it exists: `test/` holds smokes that print their own results, `scripts/` are
 *  CLIs, `repos/` holds child repo clones that are not this repo's code. Any dot dir
 *  (`.scratch/`, `.git/`) is skipped too — `.scratch/` is throwaway by CLAUDE.md §6. */
const SKIP = new Set(["node_modules", "test", "scripts", "repos"]);

/** A bare write to the screen. `console.` and `process.stdout/stderr.write` with no
 *  space around the dot — prose that ends a sentence on "…the console." is not a call. */
const BARE = /\bconsole\.\w+|\bprocess\.(?:stdout|stderr)\.write\b/;

/** The one exemption, and it covers exactly the line it sits on — never a whole file,
 *  so a stray write cannot hide beside a sanctioned one. */
const PRAGMA = "sunday:allow-console";

export interface Finding {
  file: string;
  line: number;
  text: string;
}

/** Every bare console write in one module's source, by line. */
export function scanSource(source: string, file: string): Finding[] {
  const findings: Finding[] = [];
  source.split("\n").forEach((text, i) => {
    if (BARE.test(text) && !text.includes(PRAGMA)) findings.push({ file, line: i + 1, text: text.trim() });
  });
  return findings;
}

/** Every bare console write in the `.mts` files under `root`, reported repo-relative. */
export function scanTree(root: string): Finding[] {
  const findings: Finding[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !SKIP.has(entry.name)) walk(path);
      } else if (entry.name.endsWith(".mts")) {
        findings.push(...scanSource(readFileSync(path, "utf8"), relative(root, path)));
      }
    }
  };
  walk(root);
  return findings;
}

// The CLI half. Guarded, because the smoke imports the scanners from here — and this is
// `scripts/`, which the check itself excludes, so writing to the screen here is fine.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const repoRoot = resolve(import.meta.dirname, "..");
  const findings = scanTree(repoRoot);
  for (const f of findings) console.log(`${f.file}:${f.line}: ${f.text}`);
  if (findings.length > 0) {
    console.log(
      `\n✗ ${findings.length} bare console write(s). Emit through the Logger` +
        ` (services/logger.mts), or mark the line \`// ${PRAGMA}\` if it really is a sanctioned writer.`,
    );
  } else {
    console.log("✓ no bare console writes outside test/ and scripts/");
  }
  process.exit(findings.length === 0 ? 0 : 1);
}
