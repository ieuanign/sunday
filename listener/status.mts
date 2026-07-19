// listener/status.mts — `sunday status` (M3.6).
//
// A cheap point-in-time view assembled from the DURABLE state a separate process
// can read: the per-issue save-data (state.json), the pause-state (pause.json),
// and the tail of the operability log (events.jsonl). It deliberately does NOT
// reach into the running listener's in-memory scheduler queues — the in-process
// Telegram `/status` (PR2) merges scheduler.snapshot() on top of this.
//
//   devbox run node listener/status.mts        # print the report
//
// The bespoke `sunday watch` TUI is deferred (plan) — for a live single run, tail
// its per-flow log:  tail -f .scratch/<repo>/<issue>/run.log

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readState, type IssueStatus } from "./state.mts";
import { readPauseState, type PauseState } from "./pause-state.mts";

const eventsPath = resolve(import.meta.dirname, "..", ".scratch", "operability", "events.jsonl");

export interface EventLine {
  ts: string;
  class: string;
  severity: string;
  summary: string;
  repo?: string;
  issue?: string;
}

export interface StatusReport {
  pause?: PauseState;
  /** issue keys grouped by status. */
  byStatus: Record<IssueStatus, string[]>;
  recentEvents: EventLine[];
}

const STATUSES: IssueStatus[] = ["in-flight", "awaiting-human", "failed", "done"];

/** Read the last `tail` lines of events.jsonl (newest last). Tolerates a missing
 *  file (no events yet) and a torn final line. */
function readEventsTail(tail: number): EventLine[] {
  if (!existsSync(eventsPath)) return [];
  const lines = readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean);
  return lines.slice(-tail).flatMap((l) => {
    try {
      return [JSON.parse(l) as EventLine];
    } catch {
      return [];
    }
  });
}

/** Assemble the status report from durable state. */
export function buildStatus(opts: { eventsTail?: number } = {}): StatusReport {
  const state = readState();
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, [] as string[]])) as Record<IssueStatus, string[]>;
  for (const [key, s] of Object.entries(state)) {
    (byStatus[s.status] ??= []).push(key);
  }
  return { pause: readPauseState(), byStatus, recentEvents: readEventsTail(opts.eventsTail ?? 10) };
}

const SEV_ICON: Record<string, string> = { P1: "🔴", P2: "🟠", P3: "🟡" };

/** Render the report as a terse human-readable block. */
export function formatStatus(r: StatusReport): string {
  const out: string[] = [];
  out.push(`Sunday status — ${new Date().toISOString()}`);

  if (r.pause) {
    const until = r.pause.resumeAt ? `, auto-resume ${new Date(r.pause.resumeAt).toISOString()}` : " (awaiting human resume)";
    out.push(`Pipeline: ⏸ PAUSED — ${r.pause.reason}${until}`);
  } else {
    out.push("Pipeline: ▶ active");
  }

  for (const s of STATUSES) {
    const keys = r.byStatus[s];
    if (keys.length === 0) continue;
    // Enumerate active work; just count the terminal `done`.
    out.push(s === "done" ? `  ${s}: ${keys.length}` : `  ${s} (${keys.length}): ${keys.join(", ")}`);
  }

  if (r.recentEvents.length > 0) {
    out.push(`Recent events (${r.recentEvents.length}):`);
    for (const e of r.recentEvents) {
      const where = e.repo && e.issue ? ` (${e.repo}#${e.issue})` : "";
      out.push(`  ${SEV_ICON[e.severity] ?? "·"} ${e.severity ?? "?"} ${e.class}: ${e.summary}${where}`);
    }
  }

  return out.join("\n");
}

// CLI entry: only when run directly (not when imported by the listener / Telegram).
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  console.log(formatStatus(buildStatus()));
}
