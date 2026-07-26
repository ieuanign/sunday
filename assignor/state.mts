// assignor/state.mts — Sunday's save data: what each work item is currently doing,
// keyed by work-item key (`<owner>/<repo>#<issue>`). It is the answer to "is someone
// already on this?" across a restart, which the in-memory queue cannot give.
// The file path is a constructor argument — `lib/paths.mts` names `var/state.json` and
// the parent hands it over, so a smoke drives the real store against a temp file.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type WorkItemStatus = "in-flight" | "done" | "failed" | "awaiting-human";

export interface WorkItemState {
  status: WorkItemStatus;
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
