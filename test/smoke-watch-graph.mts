// test/smoke-watch-graph.mts — hermetic smoke for the set of files `node --watch`
// watches, which is the parent's own import graph and nothing else (ADR-0001).
//   devbox run node test/smoke-watch-graph.mts
// $0, offline, static: nothing here starts a watcher. It walks the graph from `main.mts`
// the way Node loads it and asserts the invariants a save-to-restart loop rests on.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : `\n    ${detail}`}`);
};

const repoRoot = resolve(import.meta.dirname, "..");

/** A statement that loads another module at runtime: `import …/export … from "x"`, or a
 *  bare `import "x"`. The clause between the keyword and `from` never contains a `;` or a
 *  quote, which is what stops one statement's match running into the next. A line that
 *  does not START with the keyword — a comment, prose — is not a load. */
const LOAD = /^[ \t]*(?:import|export)\s+([^;"']*?)\bfrom\s*["']([^"']+)["']|^[ \t]*import\s*["']([^"']+)["']/gm;

/** Node's strip-only mode erases `import type … from` and `export type … from`, and
 *  nothing else — `import { type X } from` leaves a real load behind. */
const isErased = (clause: string): boolean => /^type\b/.test(clause.trim());

/** The file a specifier resolves to inside this repo, or null for one that is not this
 *  repo's code (`node:*`, a dependency). `#alias` goes through package.json `imports`,
 *  which is how the parent's own modules refer to each other. */
function resolveSpecifier(spec: string, fromFile: string, root: string, imports: Record<string, string>): string | null {
  if (spec.startsWith("#")) {
    for (const [pattern, target] of Object.entries(imports)) {
      const [pre = "", post = ""] = pattern.split("*");
      if (pattern.includes("*") && spec.startsWith(pre) && spec.endsWith(post)) {
        return resolve(root, target.replace("*", spec.slice(pre.length, spec.length - post.length)));
      }
      if (pattern === spec) return resolve(root, target);
    }
    return null;
  }
  if (spec.startsWith(".")) return resolve(fromFile, "..", spec);
  return null;
}

/** Every file `node --watch <entry>` would watch: the entry's own module graph, which is
 *  what Node loads and nothing more. */
function walkGraph(entry: string, root: string): string[] {
  const imports = (JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { imports?: Record<string, string> })
    .imports ?? {};
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const [, clause, spec, bare] of source.matchAll(LOAD)) {
      if (spec !== undefined && isErased(clause ?? "")) continue;
      const target = resolveSpecifier(spec ?? bare ?? "", file, root, imports);
      if (target !== null && !seen.has(target)) queue.push(target);
    }
  }
  return [...seen];
}

// ── the walker, proved against a fixture before it is trusted on the real tree ──
// The one line that matters is the type-only import: Node's strip-only mode erases
// `import type … from` and NOTHING else, so `import { type Job } from "#issue/run.mts"`
// leaves a real runtime load that pulls the worker into the watched graph. `tsc` is
// happy either way, so this is the check that catches it.
{
  const tmp = resolve(import.meta.dirname, "smoke-watch-graph-tmp");
  rmSync(tmp, { recursive: true, force: true });
  const write = (rel: string, body: string) => {
    const path = resolve(tmp, rel);
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, body);
  };
  write("package.json", JSON.stringify({ imports: { "#lib/*": "./lib/*", "#issue/*": "./issue/*" } }));
  write(
    "entry.mts",
    [
      'import { readFileSync } from "node:fs";',
      'import { z } from "zod";',
      'import { helper } from "#lib/helper.mts";',
      'import type { Job } from "#issue/run.mts";',
      'import {',
      '  a,',
      '  b,',
      '} from "./local.mts";',
      '// import { sneaky } from "#issue/run.mts";',
      "",
    ].join("\n"),
  );
  write("lib/helper.mts", 'import "./side-effect.mts";\nexport const helper = 1;\n');
  write("lib/side-effect.mts", "export const noop = 1;\n");
  write("local.mts", 'export type { Job } from "#issue/run.mts";\nexport const a = 1, b = 2;\n');
  write("issue/run.mts", "export type Job = { key: string };\n");

  try {
    const clean = walkGraph(resolve(tmp, "entry.mts"), tmp).map((f) => relative(tmp, f)).sort();
    ok(
      "walks relative and #alias specifiers, follows transitively, and skips bare ones",
      clean.join(" ") === "entry.mts lib/helper.mts lib/side-effect.mts local.mts",
      clean.join(" "),
    );
    ok("a type-only import is erased, so `issue/` stays out of the graph", !clean.includes("issue/run.mts"), clean.join(" "));

    // …and out only because it is type-ONLY: the inline-type form loads for real.
    write("local.mts", 'import { type Job } from "#issue/run.mts";\nexport const a = 1;\nexport const b: Job | number = 2;\n');
    const leaked = walkGraph(resolve(tmp, "entry.mts"), tmp).map((f) => relative(tmp, f));
    ok("`import { type X } from` is NOT erased, and the walk sees it", leaked.includes("issue/run.mts"), leaked.join(" "));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── the real thing: what `node --watch main.mts` actually watches ──
{
  const graph = walkGraph(resolve(repoRoot, "main.mts"), repoRoot).map((f) => relative(repoRoot, f)).sort();

  // Non-trivial first, or every assertion under it passes vacuously on a broken walk.
  // The anchors are one per level: the entry, a root file it imports relatively, an alias
  // it imports directly, and one reached only THROUGH another module.
  const anchors = ["main.mts", "boot.mts", "assignor/index.mts", "lib/sh.mts"];
  ok(
    "the walk reaches the parent's own modules, transitively",
    anchors.every((a) => graph.includes(a)) && graph.length >= 10,
    `${graph.length} file(s): ${graph.join(" ")}`,
  );

  // The point of forking BY PATH (ADR-0001): the worker is not in the parent's graph, so a
  // save under `issue/` (or `pr/`) restarts nothing and takes effect on the next work item.
  const worker = graph.filter((f) => f.startsWith("issue/") || f.startsWith("pr/"));
  ok("no worker file is in the watched set", worker.length === 0, worker.join(" "));

  // Hard constraint 1: the parent must die INSTANTLY on the watcher's SIGTERM. A drain
  // handler turns a save into a wait, and a kill-on-exit throws away a 12-minute run.
  const HANDLER = /\bprocess\.(?:on|once|addListener|prependListener)\s*\(\s*["'](?:SIGTERM|SIGINT)/;
  const handlers = graph.filter((f) => HANDLER.test(readFileSync(resolve(repoRoot, f), "utf8")));
  ok("no file in it registers a SIGTERM/SIGINT handler", handlers.length === 0, handlers.join(" "));
}

// ── the flag itself: `npm run v2` IS the save-to-restart loop ──
{
  const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const v2 = pkg.scripts.v2 ?? "";
  ok("the v2 script runs the parent under --watch", /(?:^|\s)--watch(?:\s|$)/.test(v2), v2);
  // --watch-path is macOS/Windows-only AND watches a whole dir, which would put `issue/`
  // back in the watched set — the exact thing default watch mode excludes by construction.
  ok("and not --watch-path, which would over-watch", !v2.includes("--watch-path"), v2);
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
