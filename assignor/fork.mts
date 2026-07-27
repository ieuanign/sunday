// assignor/fork.mts — the parent's half of ADR-0001: one work item, one child process,
// forked BY PATH so the worker stays out of this process's import graph and editing
// `issue/` takes effect on the next work item with no restart.
//
// Its own file rather than a closure in `main.mts` because it is not pure wiring: what a
// child that never STARTS means for the pipeline is a decision, and decisions are driven
// by a smoke (`test/smoke-spine-fork.mts`).

import { fork, type ForkOptions } from "node:child_process";
import { resolve } from "node:path";

// Type-only, and deliberately the only reference to either worker anywhere in the parent:
// the job shape is a contract, the entry point itself is only ever reached by path.
import type { Job } from "#issue/run.mts";
import type { PrJob } from "#pr/run.mts";
import type { ChildExit, ForkWorkItem } from "./index.mts";

const issueWorker = resolve(import.meta.dirname, "..", "issue", "run.mts");
/** The other lane (#44): a comment run on a pull request. */
const prWorker = resolve(import.meta.dirname, "..", "pr", "run.mts");

/** Fork one work item, and settle when the child EXITS — so the concurrency cap and the
 *  branch lock hold for the child's whole life rather than for the fork call. The job
 *  carries every path the child writes; the child derives none (constraint 7).
 *
 *  The child's report over IPC is deliberately not listened for: it only says an outcome
 *  is ready, and the parent applies from the FILE (constraint 4) — which is what lets
 *  this process die mid-run without losing the work.
 *
 *  `options` is here for the smoke, which needs a spawn that REALLY fails (an execPath
 *  that is not there); the parent passes none. */
export function createForkWorkItem(options: ForkOptions = {}): ForkWorkItem {
  return (job: Job | PrJob) =>
    new Promise<ChildExit>((settle) => {
      // Which worker, off the JOB's own shape — a PR-comment run is the one that names a
      // `pr`. Read here rather than handed over as a field, so the Assignor cannot build
      // a job of one shape and route it to the other lane's entry point.
      // stdio inherited: a child's own lines belong in the same supervised log stream as
      // the parent's, alongside its durable per-run log.
      const child = fork("pr" in job ? prWorker : issueWorker, [JSON.stringify(job)], options);
      // A child that never starts — no node binary to exec, no file descriptors left,
      // EACCES — emits `error` and NO `exit`. An `error` with no listener is an uncaught
      // exception on the EventEmitter, which would take this process down and every
      // other in-flight item and the socket it answers on with it: the exact opposite of
      // the per-item isolation the fork exists for. It is one work item's failure, so it
      // settles like any other child that left no outcome (constraint 6) and the apply
      // path records it against the item, cause and all.
      child.once("error", (err) => settle({ code: null, signal: null, error: err.message }));
      child.once("exit", (code, signal) => settle({ code, signal }));
    });
}
