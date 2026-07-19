// listener/token-report.mts — M5.3 cost-weighted token report (FREE, host-side, no USD).
//
// On run completion the host reads the captured Claude session JSONL (the run's
// `sessionFilePath`) plus its per-sub-agent files, sums real token usage, and ranks
// consumers by a cost-WEIGHTED key (output is the priciest class — raw-token ranking
// would bury the real offender). No Claude call, no dollars: token consumption is
// the actionable number on a flat Max plan.
//
// Attribution (verified against real captured sessions 2026-07-20): each
// `type:"assistant"` line carries `message.usage.{input,cache_creation,cache_read,
// output}_tokens`; the orchestrator session is `<id>.jsonl` and every sub-agent
// (phase) invocation writes its own `<id>/subagents/agent-*.jsonl` (carrying its own
// model, e.g. opus for code-writer). So the orchestrator + one row per sub-agent file
// = true per-phase rows; the sub-agent's roster name is detected from its file text.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import { loadRoster, PHASES, type Phase } from "#config/roster.mts";

const parentRoot = resolve(import.meta.dirname, "..");

/** Cost weights in base-input units (from #9: output = 5×, cacheCreation = 1.25×,
 *  cacheRead = 0.1×). Sort-only — raw tokens are shown everywhere else. */
const W = { input: 1, cacheCreation: 1.25, cacheRead: 0.1, output: 5 } as const;
const NEAR_ZONE = 120_000; // ctx ≥ → NEAR_ZONE flag (M5.2 handoff threshold)
const OVER_ZONE = 150_000; // ctx ≥ → OVER_ZONE flag (Anthropic's compaction trigger)

export interface Usage {
  input: number;
  cacheCreation: number;
  cacheRead: number;
  output: number;
}
const ZERO: Usage = { input: 0, cacheCreation: 0, cacheRead: 0, output: 0 };

export interface Row {
  /** "orchestrator", a phase name, or a model#id fallback. */
  label: string;
  phase?: Phase;
  model?: string;
  usage: Usage;
  /** Peak per-message context (input+cacheRead+cacheCreation) in this session. */
  peakCtx: number;
  msgs: number;
}

export interface ReportRow extends Row {
  weighted: number;
  cacheHitRatio: number;
  flags: string[];
}

export interface Report {
  runId: string;
  rows: ReportRow[]; // sorted by weighted desc
  totals: Usage;
  totalWeighted: number;
  peakCtx: number;
  zone: "green" | "near" | "over";
  /** "phase" = every sub-agent row got a roster name; "partial" = some fell back to
   *  model#id; "run" = no sub-agent files (single orchestrator row). */
  granularity: "phase" | "partial" | "run";
}

const weightedOf = (u: Usage): number =>
  u.input * W.input + u.cacheCreation * W.cacheCreation + u.cacheRead * W.cacheRead + u.output * W.output;

const cacheHitRatioOf = (u: Usage): number => {
  const denom = u.cacheRead + u.cacheCreation + u.input;
  return denom === 0 ? 0 : u.cacheRead / denom;
};

/** Sum real token usage across a session JSONL's assistant messages; capture the
 *  peak per-message context and the model. Tolerant of non-JSON / usage-less lines. */
export function parseSessionUsage(content: string): { usage: Usage; peakCtx: number; model?: string; msgs: number } {
  const usage: Usage = { ...ZERO };
  let peakCtx = 0;
  let model: string | undefined;
  let msgs = 0;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let d: { type?: string; message?: { model?: string; usage?: Record<string, number> } };
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.type !== "assistant" || !d.message?.usage) continue;
    const u = d.message.usage;
    const input = u.input_tokens ?? 0;
    const cc = u.cache_creation_input_tokens ?? 0;
    const cr = u.cache_read_input_tokens ?? 0;
    const out = u.output_tokens ?? 0;
    usage.input += input;
    usage.cacheCreation += cc;
    usage.cacheRead += cr;
    usage.output += out;
    peakCtx = Math.max(peakCtx, input + cc + cr);
    model ??= d.message.model;
    msgs++;
  }
  return { usage, peakCtx, model, msgs };
}

/** Detect which roster sub-agent a sub-agent session file belongs to, by scanning
 *  its text for a roster agent name (they're distinctive). Best-effort. */
function detectAgent(content: string, agentNames: string[]): string | undefined {
  return agentNames.find((name) => content.includes(name));
}

/** Collect per-consumer rows for a run: the orchestrator (the main session file) plus
 *  one row per sub-agent session under `<id>/subagents/`. */
export function collectRows(sessionFilePath: string): Row[] {
  const roster = loadRoster();
  const agentToPhase = new Map<string, Phase>(PHASES.map((p) => [roster[p].agent, p]));
  const agentNames = [...agentToPhase.keys()];

  const rows: Row[] = [];
  const main = parseSessionUsage(readFileSync(sessionFilePath, "utf8"));
  rows.push({ label: "orchestrator", model: main.model, usage: main.usage, peakCtx: main.peakCtx, msgs: main.msgs });

  const id = basename(sessionFilePath, ".jsonl");
  const subDir = resolve(dirname(sessionFilePath), id, "subagents");
  if (existsSync(subDir)) {
    for (const f of readdirSync(subDir).filter((n) => n.endsWith(".jsonl"))) {
      const content = readFileSync(resolve(subDir, f), "utf8");
      const parsed = parseSessionUsage(content);
      const agent = detectAgent(content, agentNames);
      rows.push({
        label: agent ?? `${parsed.model ?? "sub"}#${f.replace(/^agent-|\.jsonl$/g, "").slice(0, 6)}`,
        phase: agent ? agentToPhase.get(agent) : undefined,
        model: parsed.model,
        usage: parsed.usage,
        peakCtx: parsed.peakCtx,
        msgs: parsed.msgs,
      });
    }
  }
  return rows;
}

/** Per-row flags: output-dominant cost, re-caching waste, and context zone. */
function flagsOf(row: Row, cacheHitRatio: number): string[] {
  const flags: string[] = [];
  const w = weightedOf(row.usage);
  if (w > 0 && (row.usage.output * W.output) / w > 0.5) flags.push("HIGH_OUTPUT");
  if (row.usage.cacheCreation > 0 && cacheHitRatio < 0.5) flags.push("RECACHE");
  if (row.peakCtx >= OVER_ZONE) flags.push("OVER_ZONE");
  else if (row.peakCtx >= NEAR_ZONE) flags.push("NEAR_ZONE");
  return flags;
}

/** Build the ranked, weighted report from a run's rows. Pure. */
export function buildReport(rows: Row[], runId: string): Report {
  const reportRows: ReportRow[] = rows
    .map((row) => {
      const cacheHitRatio = cacheHitRatioOf(row.usage);
      return { ...row, weighted: weightedOf(row.usage), cacheHitRatio, flags: flagsOf(row, cacheHitRatio) };
    })
    .sort((a, b) => b.weighted - a.weighted);

  const totals = rows.reduce<Usage>(
    (acc, r) => ({
      input: acc.input + r.usage.input,
      cacheCreation: acc.cacheCreation + r.usage.cacheCreation,
      cacheRead: acc.cacheRead + r.usage.cacheRead,
      output: acc.output + r.usage.output,
    }),
    { ...ZERO },
  );
  const peakCtx = rows.reduce((m, r) => Math.max(m, r.peakCtx), 0);
  const subRows = rows.filter((r) => r.label !== "orchestrator");
  const granularity: Report["granularity"] =
    subRows.length === 0 ? "run" : subRows.every((r) => r.phase) ? "phase" : "partial";

  return {
    runId,
    rows: reportRows,
    totals,
    totalWeighted: weightedOf(totals),
    peakCtx,
    zone: peakCtx >= OVER_ZONE ? "over" : peakCtx >= NEAR_ZONE ? "near" : "green",
    granularity,
  };
}

/** One-line headline (console / optional notifier): totals by class + peak ctx/zone
 *  + top-3 consumers by weighted rank. */
export function headline(report: Report): string {
  const t = report.totals;
  const top = report.rows.slice(0, 3).map((r) => `${r.label} ${Math.round(r.weighted / 1000)}k`).join(", ");
  return (
    `🧮 tokens in=${t.input} cacheW=${t.cacheCreation} cacheR=${t.cacheRead} out=${t.output} · ` +
    `peak ctx ${report.peakCtx} (${report.zone}) · top: ${top || "—"} [${report.granularity}]`
  );
}

/** Render the human-readable Markdown report. */
export function renderMarkdown(report: Report): string {
  const lines = [
    `# Token report — ${report.runId}`,
    "",
    `Peak ctx **${report.peakCtx}** (zone: ${report.zone}) · granularity: ${report.granularity}`,
    `Totals — input ${report.totals.input} · cacheCreation ${report.totals.cacheCreation} · ` +
      `cacheRead ${report.totals.cacheRead} · output ${report.totals.output} · weighted ${Math.round(report.totalWeighted)}`,
    "",
    "| # | consumer | phase | model | in | cacheW | cacheR | out | weighted | cacheHit | flags |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  report.rows.forEach((r, i) => {
    lines.push(
      `| ${i + 1} | ${r.label} | ${r.phase ?? "—"} | ${r.model ?? "—"} | ${r.usage.input} | ${r.usage.cacheCreation} | ` +
        `${r.usage.cacheRead} | ${r.usage.output} | ${Math.round(r.weighted)} | ${r.cacheHitRatio.toFixed(2)} | ${r.flags.join(" ") || "—"} |`,
    );
  });
  return lines.join("\n") + "\n";
}

/** Persist a report: `.scratch/<repo>/token-report/<runId>.{json,md}` + a one-line
 *  summary appended to `history.jsonl`. */
export function writeReport(fullName: string, report: Report): void {
  const dir = resolve(parentRoot, ".scratch", fullName, "token-report");
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, `${report.runId}.json`), JSON.stringify(report, null, 2), "utf8");
  writeFileSync(resolve(dir, `${report.runId}.md`), renderMarkdown(report), "utf8");
  const summary = {
    runId: report.runId,
    totals: report.totals,
    totalWeighted: Math.round(report.totalWeighted),
    peakCtx: report.peakCtx,
    zone: report.zone,
    granularity: report.granularity,
    top: report.rows.slice(0, 3).map((r) => ({ label: r.label, weighted: Math.round(r.weighted) })),
  };
  appendFileSync(resolve(dir, "history.jsonl"), `${JSON.stringify(summary)}\n`);
}

/** Run-completion entry point (host-side): read the run's captured session, build +
 *  store the report, log the headline. Never throws — a report failure must not break
 *  a run (like notify()). Called from run-issue after the main run() returns. */
export function emitReport(fullName: string, sessionFilePath: string, runId: string): void {
  try {
    const report = buildReport(collectRows(sessionFilePath), runId);
    writeReport(fullName, report);
    console.log(`  ${headline(report)}`);
  } catch (err) {
    console.log(`  · token-report skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}
