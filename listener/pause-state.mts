// listener/pause-state.mts — durable pipeline pause state
// (.scratch/operability/pause.json). The scheduler's `paused` flag is in-memory
// only; this persists WHY and UNTIL-WHEN so a restart re-arms it (reconcile, M3.2):
//   · quota with a future resumeAt → re-schedule the resume
//   · quota whose resumeAt already passed → resume immediately
//   · 403 halt / quota with no timestamp (no resumeAt) → stay paused for a human
// Written temp-then-rename so a crash mid-write never leaves torn JSON (like
// state.mts). Absence of the file == not paused.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export interface PauseState {
  reason: string;
  /** epoch ms when a quota pause may auto-resume (reset + grace). Absent → the
   *  pause needs a human (403 halt, or a quota with no parseable reset). */
  resumeAt?: number;
  /** epoch ms the pause began (for `sunday status`). */
  since: number;
}

const dir = resolve(import.meta.dirname, "..", ".scratch", "operability");
const pausePath = resolve(dir, "pause.json");

export function readPauseState(): PauseState | undefined {
  return existsSync(pausePath) ? (JSON.parse(readFileSync(pausePath, "utf8")) as PauseState) : undefined;
}

export function writePauseState(state: PauseState): void {
  mkdirSync(dir, { recursive: true });
  const tmp = `${pausePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  renameSync(tmp, pausePath); // atomic — no torn file on a mid-write crash
}

export function clearPauseState(): void {
  rmSync(pausePath, { force: true });
}

export type RearmAction = "resume" | "reschedule" | "halt";

/** What a boot should do with a persisted pause: a quota pause whose reset has
 *  already passed → resume now; a future reset → re-schedule the auto-resume; a
 *  403 halt or a quota with no parseable reset (no resumeAt) → stay halted for a
 *  human. Pure so a smoke drives it. */
export function rearmAction(ps: PauseState, now: number): RearmAction {
  if (ps.resumeAt === undefined) return "halt";
  return ps.resumeAt <= now ? "resume" : "reschedule";
}
