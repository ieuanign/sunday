// test/smoke-token-report.mts — no-quota smoke for the M5.3 token report.
//   devbox run node test/smoke-token-report.mts
// Deterministic synthetic fixtures (verified JSONL shape) + a real captured probe
// session if one is around (grounds the per-phase attribution on real data). $0.
// The arithmetic assertions are unchanged across the V2 move (issue #33) — the numbers
// #37's PR footer and #36's handoff threshold read must not move with the module.

import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { Logger, type LogLine } from "#services/logger.mts";
import {
  parseSessionUsage,
  buildReport,
  collectRows,
  emitReport,
  headline,
  writeReport,
  type Row,
} from "#services/agent/token-report.mts";

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : `\n    ${detail}`}`);
};

// ── parseSessionUsage: sums assistant usage, peak ctx, tolerant of junk ──
{
  const jsonl = [
    JSON.stringify({ type: "assistant", message: { model: "claude-opus-4-8", usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 50 } } }),
    "not json — skipped",
    JSON.stringify({ type: "user", message: { usage: { output_tokens: 999 } } }), // non-assistant → skipped
    JSON.stringify({ type: "assistant", message: { model: "claude-opus-4-8", usage: { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 2000, output_tokens: 200 } } }),
  ].join("\n");
  const r = parseSessionUsage(jsonl);
  ok("parse: sums output across assistant msgs (250)", r.usage.output === 250, String(r.usage.output));
  ok("parse: sums cacheRead (2900)", r.usage.cacheRead === 2900, String(r.usage.cacheRead));
  ok("parse: peakCtx = max per-msg (2005)", r.peakCtx === 2005, String(r.peakCtx));
  ok("parse: model captured", r.model === "claude-opus-4-8");
  ok("parse: msgs counted (2)", r.msgs === 2, String(r.msgs));
}

// ── weighted ranking: output beats raw tokens (the whole point) ──
{
  const rows: Row[] = [
    { label: "cache-heavy", usage: { input: 0, cacheCreation: 0, cacheRead: 100_000, output: 0 }, peakCtx: 100_000, msgs: 1 },
    { label: "output-heavy", usage: { input: 0, cacheCreation: 0, cacheRead: 0, output: 10_000 }, peakCtx: 5_000, msgs: 1 },
  ];
  const rep = buildReport(rows, "run-x");
  ok("rank: output-heavy sorts first despite 10× fewer raw tokens", rep.rows[0].label === "output-heavy", rep.rows[0].label);
  ok("rank: weighted output 50000 > cacheRead 10000", rep.rows[0].weighted === 50_000 && rep.rows[1].weighted === 10_000, `${rep.rows[0].weighted}/${rep.rows[1].weighted}`);
}

// ── flags + cacheHitRatio + zone ──
{
  const rows: Row[] = [
    { label: "recache", usage: { input: 1000, cacheCreation: 9000, cacheRead: 0, output: 10 }, peakCtx: 130_000, msgs: 1 }, // low hit + cacheCreation, NEAR
    { label: "spendy", usage: { input: 0, cacheCreation: 0, cacheRead: 0, output: 40_000 }, peakCtx: 160_000, msgs: 1 }, // output-dominant, OVER
  ];
  const rep = buildReport(rows, "run-y");
  const recache = rep.rows.find((r) => r.label === "recache")!;
  const spendy = rep.rows.find((r) => r.label === "spendy")!;
  ok("flag: RECACHE on low-hit + cacheCreation", recache.flags.includes("RECACHE"), recache.flags.join(","));
  ok("flag: NEAR_ZONE at 130k", recache.flags.includes("NEAR_ZONE"), recache.flags.join(","));
  ok("flag: HIGH_OUTPUT on output-dominant", spendy.flags.includes("HIGH_OUTPUT"), spendy.flags.join(","));
  ok("flag: OVER_ZONE at 160k (not NEAR)", spendy.flags.includes("OVER_ZONE") && !spendy.flags.includes("NEAR_ZONE"), spendy.flags.join(","));
  ok("zone: report peak zone = over", rep.zone === "over", rep.zone);
  ok("cacheHitRatio: 0 when no cacheRead", spendy.cacheHitRatio === 0, String(spendy.cacheHitRatio));
  ok("headline: renders", /tokens in=/.test(headline(rep)));
}

// ── granularity ──
{
  const orchestratorOnly = buildReport([{ label: "orchestrator", usage: { input: 1, cacheCreation: 1, cacheRead: 1, output: 1 }, peakCtx: 3, msgs: 1 }], "r");
  ok("granularity: run (no sub-agents)", orchestratorOnly.granularity === "run", orchestratorOnly.granularity);
}

// ── REAL captured probe session (grounds per-phase attribution) ──
{
  const projRoot = resolve(homedir(), ".claude", "projects");
  let mainFile: string | undefined;
  try {
    const dir = readdirSync(projRoot).find((d) => d.includes("probe-sc-repo"));
    if (dir) {
      const files = readdirSync(resolve(projRoot, dir)).filter((f) => f.endsWith(".jsonl"));
      // pick the one whose <id>/subagents/ dir exists (a run that dispatched a sub-agent)
      mainFile = files
        .map((f) => resolve(projRoot, dir, f))
        .find((p) => existsSync(resolve(p.replace(/\.jsonl$/, ""), "subagents")));
    }
  } catch { /* no probe sessions — skip */ }

  if (mainFile) {
    const rows = collectRows(mainFile);
    const rep = buildReport(rows, "real");
    ok("real: orchestrator row present with usage", rows.some((r) => r.label === "orchestrator" && r.usage.output > 0));
    ok("real: a sub-agent row present", rows.length > 1, `${rows.length} rows`);
    ok("real: sub-agent attributed to a roster phase", rows.some((r) => r.phase !== undefined), rows.map((r) => `${r.label}:${r.phase ?? "?"}`).join(", "));
    console.log(`  (real: ${rows.length} rows, granularity=${rep.granularity}) ${headline(rep)}`);
  } else {
    console.log("  · real probe session not found — synthetic checks only");
  }
}

// ── the artefacts: three files per run, into a dir the writer makes itself ──
{
  const dir = resolve(import.meta.dirname, "..", ".scratch", `smoke-token-report-${process.pid}`, "token-report");
  const rows = (output: number): Row[] => [
    { label: "orchestrator", usage: { input: 10, cacheCreation: 20, cacheRead: 30, output }, peakCtx: 60, msgs: 1 },
  ];
  try {
    ok("artefacts: the report dir does not exist yet", !existsSync(dir), dir);
    writeReport(dir, buildReport(rows(40), "run-1"));
    writeReport(dir, buildReport(rows(80), "run-2"));

    const json = JSON.parse(readFileSync(resolve(dir, "run-1.json"), "utf8")) as { runId: string; totals: { output: number } };
    ok("artefacts: <runId>.json carries that run's numbers", json.runId === "run-1" && json.totals.output === 40, JSON.stringify(json.totals));
    const md = readFileSync(resolve(dir, "run-1.md"), "utf8");
    ok("artefacts: <runId>.md is the human-readable report", md.startsWith("# Token report — run-1") && md.includes("orchestrator"), md.slice(0, 60));
    const history = readFileSync(resolve(dir, "history.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { runId: string });
    ok("history: append-only — one line per run, the earlier run kept", history.map((h) => h.runId).join(",") === "run-1,run-2", JSON.stringify(history));
  } finally {
    rmSync(resolve(dir, ".."), { recursive: true, force: true });
  }
}

// ── emitReport: accounting must never break a run that already succeeded ──
{
  const lines: LogLine[] = [];
  const drop = () => {};
  const logger = new Logger({ console: (l) => void lines.push(l), runLog: drop, eventLog: drop, github: drop, phone: drop });

  let thrown: unknown;
  try {
    emitReport(logger.child("agent"), "acme/finance", resolve(import.meta.dirname, "no-such-session.jsonl"), "run-z");
  } catch (err) {
    thrown = err;
  }
  ok("emitReport: an unreadable session does not throw out of the run", thrown === undefined, String(thrown));
  ok(
    "emitReport: the skipped report is reported through the Logger, against the repo",
    lines.length === 1 && lines[0]!.message.startsWith("token-report skipped") && lines[0]!.context.repo === "acme/finance",
    JSON.stringify(lines),
  );
  ok("emitReport: a skipped report is not a run failure", lines[0]?.level === "info", lines[0]?.level);
}

console.log(fails === 0 ? "\nAll token-report smokes pass." : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
