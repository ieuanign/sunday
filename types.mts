// types.mts — every shape the boot sequence is injected in, split out of `boot.mts` per
// CLAUDE.md §7. At the repo root because that is `boot.mts`'s own directory. Declarations
// only: `boot.mts` re-exports them (`export * from "./types.mts"`), so no caller's import
// path changes.

import type { FailurePolicy } from "#assignor/failure.mts";
import type { Assignor } from "#assignor/index.mts";
import type { PauseStore } from "#assignor/pause.mts";
import type { Scheduler } from "#assignor/scheduler.mts";
import type { StateStore } from "#assignor/state.mts";
import type { RepoConfig } from "#config/repos.mts";
import type { ImageOutcome } from "#services/sandbox.mts";
import type { ModuleLogger } from "#services/logger.mts";

/** (Re)build every routed repo's sandbox image and report one outcome per repo —
 *  `services/sandbox.mts`'s `SandboxService.buildImages`, injected rather than
 *  constructed so a smoke drives the whole sequence with no docker daemon anywhere. */
export type BuildImages = (
  table: Record<string, RepoConfig>,
  parentRoot: string,
) => Promise<ImageOutcome[]>;

/** Re-derive every outstanding piece of work from GitHub — `assignor/reconcile.mts`'s
 *  `Reconciler.run`, injected as a function for the same reason the image build is: this
 *  file is about WHERE in the sequence it happens, and a smoke drives the whole sequence
 *  with no GitHub anywhere. What it re-derives is that module's own smoke's subject. */
export type Reconcile = () => Promise<void>;

/** The `var/results/` facts the recovery sweep needs, from `lib/paths.mts`. Injected for
 *  the same reason the Assignor's paths are: a smoke drives the real sweep against a
 *  throwaway dir instead of the real `var/`. */
export interface BootPaths {
  /** The dir every finished child drops its outcome in — sweep source B. */
  resultsDir: string;
  /** Where the outcome for a given work-item key BELONGS (constraint 8). */
  resultPath(key: string): string;
}

/** Everything boot needs and constructs none of: the queue it holds, the three durable
 *  stores it re-derives from, the Assignor every recovered outcome is applied through
 *  (constraint 3 — one path, never a copy of it), the image build, and the Logger. */
export interface BootDeps {
  repos: Record<string, RepoConfig>;
  scheduler: Scheduler;
  pause: PauseStore;
  state: StateStore;
  assignor: Assignor;
  /** What a failed image build MEANS and what is done about it (#39): one repo stopped,
   *  or — for a dead container daemon — the pause armed. The same policy the Assignor
   *  routes a failed work item into, so one broken environment is read one way. */
  failure: FailurePolicy;
  buildImages: BuildImages;
  reconcile: Reconcile;
  /** The workspace root the routing table's child paths resolve against. */
  parentRoot: string;
  paths: BootPaths;
  log: ModuleLogger;
}
