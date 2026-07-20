// test/smoke-status.mts — no-quota smoke for the M3.6 `sunday status` view.
//   devbox run node test/smoke-status.mts
// formatStatus is pure over a StatusReport → driven with synthetic reports.
// buildStatus's events tail is exercised by seeding ONLY the gitignored
// operability/events.jsonl (cleaned after); state.json is never touched — a stray
// fake state.json would make a live listener try to resume a dead session.

import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

import { formatStatus, buildStatus, type StatusReport } from "../listener/status.mts";
import type { IssueStatus } from "../listener/state.mts";

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : `\n    ${detail}`}`);
};

const emptyByStatus = () =>
  ({ "in-flight": [], "awaiting-human": [], failed: [], done: [] }) as Record<IssueStatus, string[]>;

// ── formatStatus: active vs paused ──
{
  const active: StatusReport = { byStatus: emptyByStatus(), recentEvents: [] };
  ok("format: no pause → active", formatStatus(active).includes("▶ active"));

  const paused: StatusReport = {
    pause: { reason: "quota exhausted", since: 1, resumeAt: 2_000_000_000_000 },
    byStatus: emptyByStatus(),
    recentEvents: [],
  };
  const p = formatStatus(paused);
  ok("format: pause with resumeAt → PAUSED + auto-resume", p.includes("⏸ PAUSED") && p.includes("auto-resume"));

  const halt: StatusReport = { pause: { reason: "403", since: 1 }, byStatus: emptyByStatus(), recentEvents: [] };
  ok("format: pause without resumeAt → awaiting human", formatStatus(halt).includes("awaiting human resume"));
}

// ── formatStatus: issue grouping (enumerate active, count done) ──
{
  const r: StatusReport = {
    byStatus: {
      "in-flight": ["o/r#1"],
      "awaiting-human": ["o/r#2", "o/r#3"],
      failed: [],
      done: ["o/r#4", "o/r#5", "o/r#6"],
    },
    recentEvents: [],
  };
  const s = formatStatus(r);
  ok("format: in-flight enumerated", s.includes("in-flight (1): o/r#1"));
  ok("format: awaiting-human enumerated", s.includes("awaiting-human (2): o/r#2, o/r#3"));
  ok("format: done is counted, not enumerated", s.includes("done: 3") && !s.includes("o/r#4"));
  ok("format: empty status omitted", !s.includes("failed"));
}

// ── formatStatus: recent events rendered with severity ──
{
  const r: StatusReport = {
    byStatus: emptyByStatus(),
    recentEvents: [{ ts: "t", class: "auth", severity: "P1", summary: "403", repo: "o/r", issue: "9" }],
  };
  const s = formatStatus(r);
  ok("format: event line with sev + home", s.includes("🔴 P1 auth: 403 (o/r#9)"));
}

// ── buildStatus: events tail read (seed only events.jsonl, then clean) ──
{
  // The listener's real events path (mirrors listener/status.mts) — NOT relative to
  // this test file; buildStatus() reads exactly this location.
  const eventsPath = resolve(import.meta.dirname, "..", ".scratch", "operability", "events.jsonl");
  const had = existsSync(eventsPath);
  const prev = had ? readFileSync(eventsPath, "utf8") : "";
  try {
    mkdirSync(dirname(eventsPath), { recursive: true });
    writeFileSync(
      eventsPath,
      [
        JSON.stringify({ ts: "t1", class: "quota", severity: "P2", summary: "one" }),
        JSON.stringify({ ts: "t2", class: "auth", severity: "P1", summary: "two", repo: "o/r", issue: "3" }),
      ].join("\n") + "\n",
    );
    const rep = buildStatus({ eventsTail: 5 });
    ok("build: reads the events tail", rep.recentEvents.length === 2, JSON.stringify(rep.recentEvents));
    ok("build: newest-last order preserved", rep.recentEvents.at(-1)!.summary === "two");
    ok("build: report has the byStatus buckets", Object.keys(rep.byStatus).length === 4);
  } finally {
    if (had) writeFileSync(eventsPath, prev);
    else rmSync(eventsPath, { force: true });
  }
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
