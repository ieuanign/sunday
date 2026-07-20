// test/smoke-notify.mts — no-quota smoke for the M3.3 notifier floor.
//   devbox run node test/smoke-notify.mts
// Appends real events to .scratch/operability/events.jsonl (gitignored) and reads
// them back. Forces a GH-sink failure via a nonexistent childDir — execFileSync
// throws ENOENT on spawn BEFORE any real `gh`/network call — to prove a sink
// failure degrades to a notify-degraded line instead of throwing.

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { notify } from "../listener/notify.mts";
import type { OpEvent } from "../listener/classify.mts";

// The listener's real events path (mirrors listener/notify.mts) — NOT relative to
// this test file; notify() appends to exactly this location.
const eventsPath = resolve(import.meta.dirname, "..", ".scratch", "operability", "events.jsonl");

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : `\n    ${detail}`}`);
};

const lines = (): Record<string, unknown>[] =>
  existsSync(eventsPath)
    ? readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];
const last = () => lines().at(-1)!;

const tag = `smoke-${lines().length}-${Math.round(performance.now())}`; // unique per run
const event: OpEvent = { class: "quota", severity: "P2", summary: tag, excerpt: "raw error text", resetAt: 1_800_000_000_000 };

// ── append → read back ──
{
  notify(event); // no context → log sink only
  const l = last();
  ok("notify: appends a JSONL line", l.summary === tag, JSON.stringify(l));
  ok("notify: line carries class + severity + excerpt", l.class === "quota" && l.severity === "P2" && l.excerpt === "raw error text");
  ok("notify: line carries a ts + resetAt", typeof l.ts === "string" && l.resetAt === 1_800_000_000_000);
}

// ── homed context with a broken sink → notify-degraded, never throws ──
{
  let threw = false;
  try {
    notify({ ...event, summary: `${tag}-homed` }, { fullName: "owner/repo", childDir: "/nonexistent-xyz-42", issue: "1" });
  } catch {
    threw = true;
  }
  ok("notify: never throws even when the GH sink fails", !threw);
  const ls = lines();
  ok("notify: last line is notify-degraded (gh sink failed)", ls.at(-1)!.class === "notify-degraded" && ls.at(-1)!.sink === "gh", JSON.stringify(ls.at(-1)));
  ok("notify: the homed event itself was still logged first", ls.at(-2)!.summary === `${tag}-homed` && ls.at(-2)!.repo === "owner/repo");
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
