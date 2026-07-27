// assignor/state.mts — Sunday's save data: what each work item is currently doing,
// keyed by work-item key (`<owner>/<repo>#<issue>`). It is the answer to "is someone
// already on this?" across a restart, which the in-memory queue cannot give.
// The file path is a constructor argument — `lib/paths.mts` names `var/state.json` and
// the parent hands it over, so a smoke drives the real store against a temp file.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { OutcomeStatus } from "#lib/outcome.mts";

/** Every way an outcome can finish, plus the two statuses only this file knows. Derived
 *  rather than re-spelled — a status the outcome grows is a status a work item can be
 *  recorded as — and the two extras are exactly the ones no CHILD can report:
 *  `in-flight` is a claim rather than a result, and `quarantined` is a decision the
 *  PARENT takes about a failure that already happened twice (#39). */
export type WorkItemStatus = OutcomeStatus | "in-flight" | "quarantined";

export interface WorkItemState {
  status: WorkItemStatus;
  /** The agent session a gated item's answer RESUMES (#36). Kept here and not just in
   *  the outcome file, because the outcome is cleared as it is applied and the human may
   *  reply weeks later — this file is the only thing left that knows what to resume. */
  sessionId?: string;
  /** The branch this item was ADMITTED on: `main`, or `feat/<blocker>` when the Assignor
   *  stacked it (#42). Here for the same reason `sessionId` is — a gate resume opens the
   *  PR the gate never did, and it has to target the base the item started from. Absent
   *  on every item admitted before this existed, which reads as `main`. */
  base?: string;
  /** The commit this item's branch was CREATED FROM, as the run that created it reported
   *  (#42). What #43 rebases the item's own commits off — anchored in the item's own
   *  ancestry, so it survives the blocker's branch being deleted on merge or force-pushed
   *  (ADR-0003), neither of which the blocker's final tip does. Absent until a run has
   *  actually created the branch. */
  forkPoint?: string;
  /** This item has already had its ONE retry (#39): it failed, was restarted once with its
   *  own error, and the next failure quarantines it instead of running the agent again.
   *  Durable and not in memory (constraint 7) — a retry is a whole extra agent run on real
   *  quota, so a restart must not hand every failed item a fresh one. Set by the policy,
   *  carried through the apply, and dropped by admission: an item started fresh (a human
   *  released it, or re-labelled it) has its retry back. */
  retried?: boolean;
}

/** The whole file: one record per work-item key. */
type State = Record<string, WorkItemState>;

export class StateStore {
  // Declared, not a parameter property: Node runs `.mts` in strip-only mode, which
  // rejects `constructor(private path)`.
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  /** What an item is doing, or `undefined` when Sunday has never recorded it. */
  get(key: string): WorkItemState | undefined {
    return this.read()[key];
  }

  /** Every item Sunday has recorded. The whole file is what #35's boot sweep needs: an
   *  item left `in-flight` by a parent that died is only findable by asking what is in
   *  here, since nothing else on disk necessarily survives a child that wrote no
   *  outcome. */
  all(): Record<string, WorkItemState> {
    return this.read();
  }

  /** Record what an item is doing now. */
  set(key: string, state: WorkItemState): void {
    const all = this.read();
    all[key] = state;
    this.write(all);
  }

  private read(): State {
    return existsSync(this.path) ? (JSON.parse(readFileSync(this.path, "utf8")) as State) : {};
  }

  private write(all: State): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, "utf8");
    renameSync(tmp, this.path);
  }
}
