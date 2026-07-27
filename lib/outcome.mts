// lib/outcome.mts — the outcome file: how a forked work item hands its result back to
// the parent. The child writes it before it reports over IPC and the parent applies it
// from the FILE, never from the IPC payload (ADR-0001) — so a parent killed at any
// instant loses no finished work, and the boot sweep applies through this same helper.
// Every function takes the path it works on: a smoke points a real child at a temp dir
// instead of the real `var/`.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Every way a run can END, spelled ONCE. The type below, the shape guard at the bottom
 *  of this file and `assignor/state.mts`'s own union all derive from this tuple, so a
 *  status added here reaches the RUNTIME guard by itself. Hand-written, the guard is what
 *  the type system cannot check: a fourth status would type-check everywhere and still
 *  make `readOutcome` call a perfectly good outcome file unreadable, which the parent
 *  records as a failed work item — a finished run thrown away. */
export const OUTCOME_STATUSES = ["done", "failed", "awaiting-human"] as const;

export type OutcomeStatus = (typeof OUTCOME_STATUSES)[number];

/** What a work item finished as. */
export interface Outcome {
  /** The work-item key (`<owner>/<repo>#<issue>`) this outcome belongs to. */
  key: string;
  /** `awaiting-human` is a FINISHED run too (#36): the agent stopped to ask a question,
   *  so nothing shipped, but nothing failed either and the item is nobody's to retry —
   *  it is the human's to answer. */
  status: OutcomeStatus;
  summary: string;
  /** ISO timestamp, stamped by the child as it finishes. */
  finishedAt: string;
  /** The agent session a reply RESUMES rather than restarts, when there is one to
   *  resume. The child that holds it is gone by the time anyone reads this, so the
   *  handle survives here or the human's answer starts the work over from nothing. */
  sessionId?: string;
  /** The commit this run's branch was CREATED FROM (#42), when this run created it. The
   *  boundary between a blocker's commits and this item's own, and what #43 restacks
   *  against — so it is recorded from the SHA the agent was actually handed rather than
   *  re-derived later from a branch that has moved since (ADR-0003). Absent on a resumed
   *  run: the branch was already there, so that run forked from nothing. */
  forkPoint?: string;
  /** The agent RAN and reported the failure ITSELF (#39) — a `fail` signal, or a run that
   *  committed nothing — as opposed to something blowing up around it. Carried as a typed
   *  fact because the summary on those paths is prose SUNDAY composed around the agent's
   *  own description: classifying that by pattern would break the day the wording changes,
   *  and would let anything the agent happened to write ("hit the usage limit") stop the
   *  whole pipeline. Absent on every other path, which is every failure the agent never
   *  got to describe. */
  agentFailed?: boolean;
}

/** The answers a read can give. Absence is the common one — no file means nothing to
 *  apply — so it is a state the caller branches on, never an exception. */
export type OutcomeRead =
  | { state: "ok"; outcome: Outcome }
  | { state: "absent" }
  | { state: "unreadable"; detail: string };

/** Write a child's outcome, temp-then-rename: the parent may read the results dir in
 *  the very instant a child is writing, so the file it finds is either the whole old
 *  outcome or the whole new one. A crash mid-write leaves bytes in `<path>.tmp` and
 *  none in the file the parent applies. Makes its own directory — `lib/paths.mts` only
 *  names paths. */
export function writeOutcome(path: string, outcome: Outcome): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(outcome, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

/** Read the outcome at `path`. Never throws: a file the parent cannot understand still
 *  has to be recorded and cleared, and a throw on the apply path would strand the work
 *  item in-flight with its claim still on it. */
export function readOutcome(path: string): OutcomeRead {
  if (!existsSync(path)) return { state: "absent" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return { state: "unreadable", detail: err instanceof Error ? err.message : String(err) };
  }
  if (!isOutcome(parsed)) return { state: "unreadable", detail: `not an outcome: ${JSON.stringify(parsed)}` };
  return { state: "ok", outcome: parsed };
}

/** Drop an outcome once it has been applied. Idempotent: the file's presence is what
 *  stops an outcome being applied twice, and a parent that dies between two clears of
 *  the same file must be able to finish the job on its next boot. */
export function clearOutcome(path: string): void {
  rmSync(path, { force: true });
}

/** Parseable is not usable: the parent writes `status` into durable state and posts
 *  `summary` to the issue, so a file of the wrong shape is unreadable, not an outcome
 *  with holes in it. */
function isOutcome(value: unknown): value is Outcome {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.key === "string" &&
    // Widened to compare against an unknown: the check has to come off OUTCOME_STATUSES
    // rather than re-spell it, or a status added to the type stops being readable here.
    (OUTCOME_STATUSES as readonly unknown[]).includes(o.status) &&
    typeof o.summary === "string" &&
    typeof o.finishedAt === "string" &&
    // Optional, so absent is fine — but present and not a string is not: the handle is
    // handed to the agent as a session to resume, and the wrong type there restarts the
    // work instead of continuing it.
    (o.sessionId === undefined || typeof o.sessionId === "string") &&
    // Likewise optional, and likewise checked: a restack aims at the commit this names,
    // and this file's own warning is that a field the guard skips is how a finished run
    // becomes an unreadable outcome — or here, a fork point that is not a commit.
    (o.forkPoint === undefined || typeof o.forkPoint === "string") &&
    // And likewise: this one decides whether a failure is the agent's own verdict or an
    // unrecognised one, so a truthy string here would classify a real quota wall as the
    // agent having failed — one item quarantined while the pipeline feeds into the wall.
    (o.agentFailed === undefined || typeof o.agentFailed === "boolean")
  );
}
