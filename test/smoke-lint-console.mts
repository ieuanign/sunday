// test/smoke-lint-console.mts — hermetic smoke for scripts/lint-console.mts, the check
// that keeps output on the Logger.
//   devbox run node test/smoke-lint-console.mts
// $0, offline, no writes outside its own temp dir.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { scanSource, scanTree } from "#scripts/lint-console.mts";

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : `\n    ${detail}`}`);
};

// ── a bare console write in a module is a finding ──
{
  const source = ["export function go() {", '  console.log("started");', "}", ""].join("\n");
  const found = scanSource(source, "services/example.mts");
  ok(
    "flags a bare console.log, naming file and line",
    found.length === 1 && found[0]!.file === "services/example.mts" && found[0]!.line === 2,
    JSON.stringify(found),
  );
}

// ── writing the stream directly is the same bypass ──
{
  const source = ['process.stdout.write("hi\\n");', 'process.stderr.write("boom\\n");', ""].join("\n");
  const found = scanSource(source, "services/example.mts");
  ok(
    "flags process.stdout.write and process.stderr.write",
    found.length === 2 && found[0]!.line === 1 && found[1]!.line === 2,
    JSON.stringify(found),
  );
}

// ── prose is not a call: this tree is comment-heavy, so a false positive is a real cost ──
{
  const source = [
    "// Everything Sunday says reaches the console. The Logger owns that.",
    "const dests = { console: consoleDestination(), runLog };",
    "const printer = consoleDestination();",
    "",
  ].join("\n");
  const found = scanSource(source, "services/example.mts");
  ok("ignores prose, an object key and a name that merely starts with console", found.length === 0, JSON.stringify(found));
}

// ── the pragma is the only escape hatch, and it exempts ONE line ──
{
  const source = [
    'console.log("sanctioned"); // sunday:allow-console',
    'console.log("stray beside it");',
    "",
  ].join("\n");
  const found = scanSource(source, "services/destinations.mts");
  ok(
    "honours the line pragma and still flags the line beside it",
    found.length === 1 && found[0]!.line === 2,
    JSON.stringify(found),
  );
}

// ── the walk: every .mts under the root, minus the excluded dirs ──
{
  const tmp = resolve(import.meta.dirname, "smoke-lint-tmp");
  rmSync(tmp, { recursive: true, force: true });
  const write = (rel: string, body: string) => {
    const path = resolve(tmp, rel);
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, body);
  };
  write("services/thing.mts", 'console.log("stray");\n');
  write("services/nested/deep.mts", 'process.stdout.write("stray");\n');
  write("listener/v1.mts", 'console.log("v1 is exempt until cutover");\n');
  write("test/smoke-thing.mts", 'console.log("smokes print their own results");\n');
  write("scripts/tool.mts", 'console.log("scripts are CLIs");\n');
  write("node_modules/dep/index.mts", 'console.log("not ours");\n');
  write(".scratch/throwaway.mts", 'console.log("throwaway");\n');
  write("services/notes.md", 'console.log("prose, not code");\n');

  try {
    const found = scanTree(tmp).map((f) => f.file).sort();
    ok(
      "walks every .mts under the root, skipping listener/, test/, scripts/, node_modules/ and dot dirs",
      found.length === 2 && found[0] === "services/nested/deep.mts" && found[1] === "services/thing.mts",
      found.join(", "),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── the shipped tree passes its own check ──
{
  const repoRoot = resolve(import.meta.dirname, "..");
  const found = scanTree(repoRoot);
  ok("the shipped tree is clean", found.length === 0, found.map((f) => `${f.file}:${f.line}: ${f.text}`).join("\n    "));

  // …and clean because ONE line carries the pragma, not because the scan is blind: take
  // the real console destination, drop its pragma, and the check must catch it.
  const sanctioned = readFileSync(resolve(repoRoot, "services/destinations.mts"), "utf8");
  const unpragmad = sanctioned.replaceAll("// sunday:allow-console", "");
  ok(
    "the one sanctioned console writer is exempt only by its pragma",
    sanctioned.includes("// sunday:allow-console") && scanSource(unpragmad, "services/destinations.mts").length === 1,
    JSON.stringify(scanSource(unpragmad, "services/destinations.mts")),
  );
}

// ── run as a CLI (what `npm run lint` does), it reports the shipped tree and exits 0 ──
{
  const script = resolve(import.meta.dirname, "..", "scripts", "lint-console.mts");
  let out = "";
  let code = 0;
  try {
    out = execFileSync(process.execPath, [script], { encoding: "utf8", timeout: 60_000 });
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    code = e.status ?? 1;
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  ok("the CLI exits 0 and says the tree is clean", code === 0 && /no bare console writes/i.test(out), `exit ${code}\n    ${out.trim()}`);
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
