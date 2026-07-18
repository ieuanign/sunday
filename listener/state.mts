// listener/state.mts — durable per-issue state (.scratch/state.json), the "save
// data". Keyed by `${fullName}#${issue}`. Written temp-then-rename so a crash
// mid-write never leaves torn JSON. Reconcile (step 7) will re-derive pending
// work from GitHub + this file; the gate (step 5) reads back `sessionId`.

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export type IssueStatus = "in-flight" | "done" | "failed";

export interface IssueState {
  status: IssueStatus;
  branch?: string;
  prUrl?: string;
  sessionId?: string;
}

export type State = Record<string, IssueState>;

const statePath = resolve(import.meta.dirname, "..", ".scratch", "state.json");

export function readState(): State {
  return existsSync(statePath)
    ? (JSON.parse(readFileSync(statePath, "utf8")) as State)
    : {};
}

function writeState(state: State): void {
  const tmp = `${statePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  renameSync(tmp, statePath); // atomic — no torn file on a mid-write crash
}

export function getIssue(key: string): IssueState | undefined {
  return readState()[key];
}

/** Merge a patch into an issue's state (read-modify-write is atomic within this
 *  single-threaded process — no await between read and write). */
export function setIssue(
  key: string,
  patch: Partial<IssueState> & { status: IssueStatus },
): void {
  const state = readState();
  state[key] = { ...state[key], ...patch };
  writeState(state);
}
