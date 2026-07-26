// assignor/pause.mts — the durable half of a pipeline pause: WHY the pipeline stopped
// and UNTIL WHEN. The scheduler's own `paused` flag is in-memory only, so without a file
// a restart silently lifts a quota pause and the next work item spends the quota Sunday
// was waiting for. Absence of the file is what "not paused" looks like.
// Ported from v1's `listener/pause-state.mts`, with two changes: the path is a
// constructor argument (mirroring `StateStore`) so a smoke drives the real store against
// a throwaway file rather than the live one, and it names `var/pause.json` — durable
// state, not v1's `.scratch/`, which CLAUDE.md documents as rm -rf'able.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface PauseState {
  reason: string;
  /** epoch ms when a quota pause may auto-resume (reset + grace). Absent → the pause
   *  needs a human: a 403 halt, or a quota whose reset time could not be read. */
  resumeAt?: number;
  /** epoch ms the pause began. */
  since: number;
}

export class PauseStore {
  // Declared, not a parameter property: Node runs `.mts` in strip-only mode, which
  // rejects `constructor(private path)`.
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  /** The armed pause, or `undefined` when the pipeline is not paused. */
  read(): PauseState | undefined {
    return existsSync(this.path) ? (JSON.parse(readFileSync(this.path, "utf8")) as PauseState) : undefined;
  }

  /** Arm (or update) the pause. Temp-then-rename, like `StateStore`: the pause can be
   *  armed in the instant the process is killed, and a torn file is a pause the next boot
   *  cannot read — which reads as "not paused" and starts spending quota again. */
  write(state: PauseState): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    renameSync(tmp, this.path);
  }

  /** Disarm the pause. The file's absence IS "not paused", so nothing else has to be
   *  written for a resume to survive the next restart. */
  clear(): void {
    rmSync(this.path, { force: true });
  }
}

export type RearmAction = "resume" | "reschedule" | "halt";

/** What boot does with the pause it found armed: a quota reset that has already passed
 *  → resume now (the common case — the pipeline was down longer than the window); a
 *  reset still ahead → re-schedule the auto-resume for what is left of it; a pause with
 *  no reset time (a 403 halt, or a quota whose reset could not be read) → stay halted
 *  until a human lifts it. Pure, with `now` an argument, so a smoke drives the rule
 *  without waiting on a clock. */
export function rearmAction(state: PauseState, now: number): RearmAction {
  if (state.resumeAt === undefined) return "halt";
  return state.resumeAt <= now ? "resume" : "reschedule";
}
