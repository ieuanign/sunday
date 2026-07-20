// listener/notify.mts — M3.3 notifier floor.
//
// One fan-out for every operability event (a classified failure, a pause/resume, a
// halt). Sinks, in order:
//   1. .scratch/operability/events.jsonl — appended FIRST + synchronously. This is
//      the source of truth (Sentry-style): if everything else fails, the event is
//      still on disk, and it's where the first real quota/403/refusal excerpt is
//      captured for tightening classify.mts (the M3 verify gate).
//   2. GitHub — an issue/PR comment (+ optional label) when the event is homed to a
//      specific issue. Opt-in via context, so a transient blip doesn't comment.
//   3. Telegram — an INERT stub until PR2 (guarded on TELEGRAM_BOT_TOKEN; Telegram
//      is an optional convenience layer, so this staying inert is fine).
//
// notify() NEVER throws — a notifier that breaks the pipeline defeats its purpose.
// A sink failure is caught and recorded as a `notify-degraded` event; only a failed
// events.jsonl write (the last resort) falls back to console.error.

import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { sh, sundayComment } from "./helper.mts";
import { sendTelegram } from "./telegram.mts";
import type { OpEvent, Severity } from "./classify.mts";

const parentRoot = resolve(import.meta.dirname, "..");
const operabilityDir = resolve(parentRoot, ".scratch", "operability");
const eventsPath = resolve(operabilityDir, "events.jsonl");

/** Where an event is homed. When `fullName` + `childDir` + `issue` are all present,
 *  the GitHub sink comments that issue/PR (and applies `label` if given). Omit them
 *  for a pipeline-global event (pause/halt) — those stay in the log + Telegram, not
 *  on any issue (per the "no pipeline state on issues" constraint). */
export interface NotifyContext {
  fullName?: string;
  childDir?: string;
  /** Issue or PR number. */
  issue?: string;
  /** An existing label to apply alongside the comment (act-layer semantics —
   *  `awaiting-human` / `agent-failed`). Never a new pipeline-state label. */
  label?: string;
}

const SEV_ICON: Record<Severity, string> = { P1: "🔴", P2: "🟠", P3: "🟡" };

/** Fan an operability event out to all sinks. Log-first + synchronous; the GitHub
 *  and Telegram sinks are best-effort and can't break a run. */
export function notify(event: OpEvent, ctx: NotifyContext = {}): void {
  const record = {
    ts: new Date().toISOString(),
    ...event,
    ...(ctx.fullName ? { repo: ctx.fullName } : {}),
    ...(ctx.issue ? { issue: ctx.issue } : {}),
  };
  writeEvent(record); // source of truth — first, synchronous

  const where = ctx.fullName && ctx.issue ? ` (${ctx.fullName}#${ctx.issue})` : "";
  console.log(`${SEV_ICON[event.severity]} ${event.severity} ${event.class}: ${event.summary}${where}`);

  if (ctx.fullName && ctx.childDir && ctx.issue) ghSink(event, ctx);
  telegramSink(event, where);
}

/** Append one JSON line to events.jsonl. The one sink that must not silently fail —
 *  on error there's nowhere left to record it, so fall back to stderr. */
function writeEvent(record: Record<string, unknown>): void {
  try {
    mkdirSync(operabilityDir, { recursive: true });
    appendFileSync(eventsPath, `${JSON.stringify(record)}\n`);
  } catch (err) {
    console.error(`✗ notify: events.jsonl write failed — ${msg(err)}\n   dropped: ${JSON.stringify(record)}`);
  }
}

/** Comment the homed issue/PR (+ optional label). Best-effort: a `gh` failure is
 *  recorded as `notify-degraded`, never propagated. */
function ghSink(event: OpEvent, ctx: NotifyContext): void {
  try {
    sh("gh", ["issue", "comment", ctx.issue!, "--body", sundayComment(`⚠️ ${event.summary}`)], ctx.childDir!);
    if (ctx.label) sh("gh", ["issue", "edit", ctx.issue!, "--add-label", ctx.label], ctx.childDir!);
  } catch (err) {
    degraded("gh", err);
  }
}

/** Telegram sink — pushes a one-line notice to the configured chat. No-op when the
 *  token is unset (the common case, and the whole optional-layer point). Fire-and-
 *  forget: a send failure degrades, never blocks — the durable log already has it. */
function telegramSink(event: OpEvent, where: string): void {
  if (!process.env.TELEGRAM_BOT_TOKEN) return; // optional; not configured
  sendTelegram(`${SEV_ICON[event.severity]} ${event.severity} ${event.class}: ${event.summary}${where}`)
    .catch((err) => degraded("telegram", err));
}

/** Record that a sink degraded — straight to the log, bypassing the sinks (so a
 *  broken sink can't recurse). */
function degraded(sink: string, err: unknown): void {
  writeEvent({ ts: new Date().toISOString(), class: "notify-degraded", severity: "P3", sink, error: msg(err) });
  console.log(`  · notify: ${sink} sink degraded — ${msg(err)}`);
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
