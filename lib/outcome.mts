// lib/outcome.mts — the outcome file: how a forked work item hands its result back to
// the parent. The child writes it before it reports over IPC and the parent applies it
// from the FILE, never from the IPC payload (ADR-0001) — so a parent killed at any
// instant loses no finished work, and the boot sweep applies through this same helper.
// Every function takes the path it works on: a smoke points a real child at a temp dir
// instead of the real `var/`.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** What a work item finished as. */
export interface Outcome {
  /** The work-item key (`<owner>/<repo>#<issue>`) this outcome belongs to. */
  key: string;
  /** `awaiting-human` is a FINISHED run too (#36): the agent stopped to ask a question,
   *  so nothing shipped, but nothing failed either and the item is nobody's to retry —
   *  it is the human's to answer. */
  status: "done" | "failed" | "awaiting-human";
  summary: string;
  /** ISO timestamp, stamped by the child as it finishes. */
  finishedAt: string;
  /** The agent session a reply RESUMES rather than restarts, when there is one to
   *  resume. The child that holds it is gone by the time anyone reads this, so the
   *  handle survives here or the human's answer starts the work over from nothing. */
  sessionId?: string;
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
    (o.status === "done" || o.status === "failed" || o.status === "awaiting-human") &&
    typeof o.summary === "string" &&
    typeof o.finishedAt === "string" &&
    // Optional, so absent is fine — but present and not a string is not: the handle is
    // handed to the agent as a session to resume, and the wrong type there restarts the
    // work instead of continuing it.
    (o.sessionId === undefined || typeof o.sessionId === "string")
  );
}
