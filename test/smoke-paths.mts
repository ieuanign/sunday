// test/smoke-paths.mts — hermetic smoke for lib/paths.mts, the durable var/ layout.
//   devbox run node test/smoke-paths.mts
// Two contracts: every durable path lands under gitignored `var/` (never `.scratch/`,
// which CLAUDE.md documents as throwaway and the pipeline rm -rf's), and naming a
// path CREATES NOTHING — v1's runLogPath mkdirSync'd as a side effect, which made
// every consumer non-hermetic. $0, no network, no writes.

import { existsSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const varRoot = resolve(repoRoot, "var");

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : `\n    ${detail}`}`);
};

// Snapshot BEFORE the module is even loaded: importing it must not create anything
// either. Nothing here is cleaned up afterwards, because nothing should appear.
const watched = [
  varRoot,
  resolve(varRoot, "results"),
  resolve(varRoot, "running"),
  resolve(varRoot, "log"),
  resolve(varRoot, "log", "acme", "finance", "57"),
];
const before = watched.map(existsSync);

const paths = await import("#lib/paths.mts");

// ── the layout, spelled out (expected values are the plan's layout, not the module's) ──
{
  ok("state: var/state.json", relative(repoRoot, paths.statePath) === "var/state.json", paths.statePath);
  ok("pause: var/pause.json", relative(repoRoot, paths.pausePath) === "var/pause.json", paths.pausePath);
  ok("results: var/results", relative(repoRoot, paths.resultsDir) === "var/results", paths.resultsDir);
  ok("running: var/running", relative(repoRoot, paths.runningDir) === "var/running", paths.runningDir);
  ok("log: var/log", relative(repoRoot, paths.logDir) === "var/log", paths.logDir);
  ok("events: var/log/events.jsonl", relative(repoRoot, paths.eventLogPath) === "var/log/events.jsonl", paths.eventLogPath);
  ok("fallback: var/log/sunday.log", relative(repoRoot, paths.fallbackLogPath) === "var/log/sunday.log", paths.fallbackLogPath);
}

// ── run log: one file per work item, nested owner/repo/flow ──
{
  const issueRun = paths.runLogPath("acme/finance", "57");
  ok(
    "run log: issue run → var/log/<owner>/<repo>/<issue>/run.log",
    relative(repoRoot, issueRun) === "var/log/acme/finance/57/run.log",
    issueRun,
  );
  const prRun = paths.runLogPath("acme/finance", "pr-12");
  ok(
    "run log: PR-comment run gets its own flow dir",
    relative(repoRoot, prRun) === "var/log/acme/finance/pr-12/run.log",
    prRun,
  );
}

// ── token report: durable per repo, beside that repo's run logs ──
{
  const dir = paths.tokenReportDir("acme/finance");
  ok(
    "token report: var/log/<owner>/<repo>/token-report",
    relative(repoRoot, dir) === "var/log/acme/finance/token-report",
    dir,
  );
}

// ── restack worktree: ephemeral, under var/ — never inside the child checkout (#21) ──
{
  const wt = paths.restackWorktreePath("acme/finance", "feat/57");
  ok(
    "restack: one flat worktree dir per repo+branch under var/restack",
    relative(repoRoot, wt) === "var/restack/acme-finance-feat-57",
    wt,
  );
}

// ── result + PID lock: one flat file per work-item key (the key carries `/` and `#`) ──
{
  const result = paths.resultPath("acme/finance#57");
  ok(
    "result: key flattened into one file under var/results",
    relative(repoRoot, result) === "var/results/acme-finance-57.json",
    result,
  );
  const pid = paths.pidPath("acme/finance#pr12");
  ok(
    "pid lock: key flattened into one file under var/running",
    relative(repoRoot, pid) === "var/running/acme-finance-pr12.pid",
    pid,
  );
}

// ── durable, not throwaway: every path sits under var/, none under .scratch/ ──
{
  const all = [
    paths.varDir,
    paths.statePath,
    paths.pausePath,
    paths.resultsDir,
    paths.runningDir,
    paths.logDir,
    paths.eventLogPath,
    paths.fallbackLogPath,
    paths.runLogPath("acme/finance", "57"),
    paths.tokenReportDir("acme/finance"),
    paths.resultPath("acme/finance#57"),
    paths.pidPath("acme/finance#pr12"),
    paths.restackWorktreePath("acme/finance", "feat/57"),
  ];
  const stray = all.filter((p) => p !== varRoot && !p.startsWith(`${varRoot}${sep}`));
  ok("layout: every durable path is under var/", stray.length === 0, stray.join("\n    "));
  const scratch = all.filter((p) => p.includes(".scratch"));
  ok("layout: no durable path is under .scratch/", scratch.length === 0, scratch.join("\n    "));
}

// ── pure: naming a path creates no directory (v1's runLogPath mkdirSync'd) ──
{
  const after = watched.map(existsSync);
  const created = watched.filter((p, i) => after[i] && !before[i]);
  ok("pure: resolving every path created no directory", created.length === 0, created.join("\n    "));
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
