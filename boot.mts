// boot.mts — everything that happens between the parent process starting and it being
// ready to work. A restart has to be a DELAY, not a loss: without this file a persisted
// pause is silently lifted, sandbox images are never built, and the outcomes and locks a
// dead parent left behind sit on disk forever while their issues keep the claim that
// stops anyone re-admitting them.
//
// The sequence is ordered, and every step's position is load-bearing:
//   1. hold the queue     — nothing STARTS until boot has finished re-deriving.
//   2. re-arm the pause   — before any work is re-derived, so what boot finds is HELD
//                           rather than run straight back into the wall that paused it.
//   3. build images       — with the hold on, so an early delivery cannot race a
//                           half-built image.
//   4. recovery sweep     — resolve what the dead parent left: every finished outcome on
//                           disk and every in-flight item whose child is gone.
//   5. reconcile          — re-derive outstanding work from GitHub, which is the truth.
//                           AFTER the sweep, so what it re-reads is settled state rather
//                           than a half-resolved item it would read as work in progress.
//   6. lift the hold      — only if no pause is armed.
//
// Constraint 2: the ONLY fatal step is the routing table. Everything else is reported
// and survived — v1's preflight threw out of boot instead, which under `restart: always`
// is an infinite rebuild loop that never gets as far as answering a webhook.

import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import type { FailurePolicy } from "#assignor/failure.mts";
import { type Assignor, parseWorkItemKey, type WorkItemRef } from "#assignor/index.mts";
import { type PauseState, type PauseStore, rearmAction } from "#assignor/pause.mts";
import type { Scheduler } from "#assignor/scheduler.mts";
import type { StateStore } from "#assignor/state.mts";
import type { RepoConfig } from "#config/repos.mts";
import { readOutcome } from "#lib/outcome.mts";
import type { ImageOutcome } from "#services/sandbox.mts";
import type { ModuleLogger } from "#services/logger.mts";

/** Why the queue is held for the length of the sequence. It is a reason and not a flag
 *  because the scheduler reports it in `sunday status`, and "why is nothing running" is
 *  the question a boot that is still sweeping has to answer. */
const BOOT_HOLD = "boot — re-deriving what the last parent left behind";

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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

export class Boot {
  // Declared, not parameter properties: Node runs `.mts` in strip-only mode, which
  // rejects `constructor(private x)`.
  private readonly repos: Record<string, RepoConfig>;
  private readonly scheduler: Scheduler;
  private readonly pause: PauseStore;
  private readonly state: StateStore;
  private readonly assignor: Assignor;
  private readonly failure: FailurePolicy;
  private readonly buildImages: BuildImages;
  private readonly reconcile: Reconcile;
  private readonly parentRoot: string;
  private readonly paths: BootPaths;
  private readonly log: ModuleLogger;
  /** Has the sequence finished? Read by the re-scheduled auto-resume, which is the one
   *  thing in this file that fires on a clock rather than in sequence order — and the
   *  queue is not its to release while the sequence is still running. */
  private finished = false;

  constructor(deps: BootDeps) {
    this.repos = deps.repos;
    this.scheduler = deps.scheduler;
    this.pause = deps.pause;
    this.state = deps.state;
    this.assignor = deps.assignor;
    this.failure = deps.failure;
    this.buildImages = deps.buildImages;
    this.reconcile = deps.reconcile;
    this.parentRoot = deps.parentRoot;
    this.paths = deps.paths;
    this.log = deps.log;
  }

  /** The sequence, once, in order. Never rejects (constraint 2): each step is isolated,
   *  so a failure in one is a line in the log and the next step still runs. */
  async run(): Promise<void> {
    this.scheduler.pause(BOOT_HOLD);
    await this.step("re-arm", () => this.rearm());
    await this.step("images", () => this.images());
    await this.step("sweep", () => this.sweep());
    // AFTER the sweep: an item the sweep has not settled yet is still recorded in-flight,
    // and re-derived in that state it reads as work in progress and is left alone — which
    // is the loss this whole sequence exists to prevent.
    await this.step("reconcile", () => this.reconcile());
    this.finished = true;
    this.lift();
  }

  /** Re-apply the pause a dead parent left armed — BEFORE anything is re-derived, so the
   *  work boot finds is held rather than run straight back into the wall that armed it.
   *  A resume only clears the FILE: boot's own hold stays on until the sequence ends. */
  private rearm(): void {
    const armed = this.pause.read();
    if (!armed) return;
    switch (rearmAction(armed, Date.now())) {
      case "resume":
        this.pause.clear();
        this.log.info(`⟲ pause elapsed (${armed.reason}) — the window closed while Sunday was down`);
        return;
      case "reschedule":
        this.scheduler.pause(armed.reason);
        // The auto-resume died with the parent that armed it, and nothing else fires it:
        // without this the pipeline stays paused until a human notices.
        this.scheduleResume(armed.resumeAt!, armed.reason);
        return;
      case "halt":
        this.scheduler.pause(armed.reason);
        // Operator-facing and not a failure, so `alert`: it carries no target, which is
        // what keeps a pipeline-scope line off every issue thread (constraint 12).
        this.log.alert(`⏸ halt re-armed (${armed.reason}) — awaiting a human resume`);
        return;
    }
  }

  /** Re-schedule what is LEFT of an open pause window. Clearing the file is half of the
   *  resume: a pause left on disk is re-applied by the next boot, whose window has by
   *  then closed.
   *
   *  What is LEFT of the window can be shorter than the sequence — a restart minutes
   *  before a quota reset is an ordinary one — and the scheduler has a SINGLE pause flag,
   *  which for the length of the sequence is also boot's own hold. So this fires the
   *  durable half only: it disarms the pause and leaves releasing the queue to `lift`,
   *  which happens once, at the end, and re-reads the file. Resuming from here mid-
   *  sequence would un-hold the queue while the images are still building and the sweep
   *  is still settling locks — the exact race the hold exists to close. */
  private scheduleResume(resumeAt: number, reason: string): void {
    const delay = Math.max(0, resumeAt - Date.now());
    this.log.info(`⟲ pause re-armed (${reason}) until ${new Date(resumeAt).toISOString()}`);
    setTimeout(() => {
      this.pause.clear();
      this.log.info(`▶ pause window closed (${reason})`);
      // Fired after the sequence: nothing else will lift now, so this one does — through
      // `lift`, which re-reads the file, so a pause armed since (a fresh 403) still wins.
      if (this.finished) this.lift();
    }, delay);
  }

  /** (Re)build every routed repo's image, with the hold on. A repo that did not build goes
   *  to the POLICY and not to a log line of its own (#39 constraint 1): a broken image
   *  stops that repo, a dead container daemon stops the pipeline, and both decisions live
   *  in one place — boot reporting it separately is the second reading of a failure that is
   *  how v1's live and recovery paths drifted apart.
   *
   *  The build's OWN output goes over, never a line composed here (constraint 3), with
   *  `setup` as the fallback: a failure that came out of an image build is that repo's
   *  environment whatever docker said about it. What the build could not do is already a
   *  durable `error` from `services/sandbox.mts`, carrying the image name and the reason. */
  private async images(): Promise<void> {
    for (const outcome of await this.buildImages(this.repos, this.parentRoot)) {
      if (outcome.status === "built") continue;
      this.failure.failed({ text: outcome.reason, repo: outcome.fullName, fallback: "setup" });
    }
  }

  /** The recovery sweep: resolve everything the dead parent left half-finished. One sink
   *  — `Assignor.applyOutcome`, the SAME path a live run's outcome takes (constraint 3),
   *  which clears the result file, releases the lock, releases the claim and posts the
   *  second milestone. */
  private sweep(): void {
    // Both sources, deduped: an item can appear in either or in both, and applying it
    // twice would comment on the issue twice.
    const items = new Map<string, WorkItemRef>();
    for (const item of [...this.strandedOutcomes(), ...this.strandedItems()]) items.set(item.key, item);
    for (const item of items.values()) {
      // Constraint 6, and the one genuinely dangerous write in the sequence: children
      // outlive the parent by design (ADR-0001), so a live lock means somebody IS on this
      // item — and settling it now releases a claim, which re-admits the issue to a SECOND
      // agent run on real quota while the first is still going. So a survivor is ADOPTED
      // rather than applied: queued under its own key, untouched until it exits, and
      // settled through the same one path everything else here takes.
      // The Assignor is asked rather than `var/running/` read here (constraint 5): one
      // owner for the lock is what stops two readings of it drifting apart.
      const pid = this.assignor.liveChild(item.key);
      try {
        if (pid !== undefined) {
          this.log.info(`· ${item.key} adopted — pid ${pid} is still on it, and its outcome is applied when it exits`);
          this.assignor.adopt(item);
          continue;
        }
        this.assignor.applyOutcome(item);
      } catch (err) {
        // Isolated per ITEM, not per sweep: applying reaches GitHub, and one 502 must not
        // strand every item behind it — that is the difference between a restart being a
        // delay and a restart being a loss.
        this.log.error(`✗ ${item.key} not settled — ${describe(err)}`, { repo: item.repo });
      }
    }
  }

  /** Sweep source A: every item this parent's predecessor recorded `in-flight`. A child
   *  can die before it writes any outcome at all, and then nothing else on disk says the
   *  work ended — its state entry is the only trace, and left alone it holds a claim that
   *  stops the item ever being re-admitted. */
  private strandedItems(): WorkItemRef[] {
    const items: WorkItemRef[] = [];
    for (const [key, state] of Object.entries(this.state.all())) {
      if (state.status !== "in-flight") continue;
      const item = parseWorkItemKey(key, this.repos);
      if (!item) {
        this.log.error(`✗ ${JSON.stringify(key)} is in-flight in the state file and is not a work item this parent routes`);
        continue;
      }
      items.push(item);
    }
    return items;
  }

  /** Sweep source B: every finished outcome nobody applied. The other half of the loss —
   *  either side can be the one that survived — and it is keyed by the `key` INSIDE the
   *  file, because the filename is slugged and not reversible. */
  private strandedOutcomes(): WorkItemRef[] {
    if (!existsSync(this.paths.resultsDir)) return [];
    const items: WorkItemRef[] = [];
    for (const entry of readdirSync(this.paths.resultsDir)) {
      const file = resolve(this.paths.resultsDir, entry);
      const read = readOutcome(file);
      if (read.state !== "ok") {
        this.log.info(`· ${entry} is not a readable outcome — left where it is`);
        continue;
      }
      const item = parseWorkItemKey(read.outcome.key, this.repos);
      if (!item) {
        this.refuse(entry, `${JSON.stringify(read.outcome.key)} is not a work item this parent routes`);
        continue;
      }
      // Constraint 8: the file has to be the one this item's outcome BELONGS in. A key
      // that names a different file settles the wrong work item — recorded, un-claimed
      // and commented on, all on the strength of somebody else's result.
      if (this.paths.resultPath(item.key) !== file) {
        this.refuse(entry, `it holds ${item.key}, whose outcome belongs in another file`);
        continue;
      }
      items.push(item);
    }
    return items;
  }

  /** A result file the sweep will not act on. `error`, because it is a work item nobody
   *  will ever settle: the file stays where it is (deleting what Sunday cannot vouch for
   *  is how a real outcome gets thrown away) and every boot from here on says so again. */
  private refuse(entry: string, why: string): void {
    this.log.error(`✗ refusing the result file ${entry} — ${why}`);
  }

  /** Lift boot's own hold — and ONLY boot's. An armed pause file outranks it: the
   *  pipeline stopped for a reason that has not expired yet, and lifting the hold here
   *  would spend the quota that pause is waiting on.
   *
   *  The one step with nothing above it to catch a throw: it runs after `run`'s last
   *  `step`, and again from the re-scheduled auto-resume, which fires on a timer whose
   *  callback has no caller at all. `run` is awaited at the top level of `main.mts`, so
   *  a throw here is an unhandled rejection that kills the parent AFTER the receiver is
   *  answering webhooks — under `restart: always`, the crash loop constraint 2 exists to
   *  eliminate. So it swallows its own failure rather than relying on a caller. */
  private lift(): void {
    let armed: PauseState | undefined;
    try {
      armed = this.pause.read();
    } catch (err) {
      // A pause file that cannot be read is NOT "not paused": it exists because the
      // pipeline had to stop, and a torn or corrupted one could be a halt. Staying held
      // costs a delay somebody can see in `sunday status` and fix; guessing the other way
      // spends the quota (or re-runs against the auth failure) the pause was armed for.
      this.log.error(`✗ boot done — the pause file is unreadable (${describe(err)}), so the queue stays held until a human clears it`);
      return;
    }
    if (armed) {
      this.log.info(`⏸ boot done — the queue stays held: ${armed.reason}`);
      return;
    }
    this.scheduler.resume();
  }

  /** One isolated step. Constraint 2: the routing table is the only thing boot dies on,
   *  so every step here reports its failure and the sequence carries on — a parent that
   *  refuses to come up because one repo's image is broken answers no webhook at all. */
  private async step(name: string, run: () => Promise<void> | void): Promise<void> {
    try {
      await run();
    } catch (err) {
      this.log.error(`✗ boot step "${name}" failed — ${describe(err)}`);
    }
  }
}

/** Load the routing table, or refuse the boot. The one fatal preflight: a table Sunday
 *  cannot parse is not "a pipeline with no repos" — it is a pipeline that would answer
 *  nothing while looking healthy, and every delivery it drops is work a human thinks is
 *  running.
 *
 *  The loader is an argument so the caller supplies the real `loadRepos` and a test
 *  supplies a throwing one; the refusal is logged at `error` (constraint 1: durable, and
 *  never a bare stack) and reported by RETURNING, so the exit code stays the caller's
 *  decision rather than this module's. */
export function readRoutingTable(
  load: () => Record<string, RepoConfig>,
  log: ModuleLogger,
): Record<string, RepoConfig> | undefined {
  try {
    return load();
  } catch (err) {
    log.error(`✗ refusing to start — the routing table is unreadable: ${describe(err)}`);
    return undefined;
  }
}
