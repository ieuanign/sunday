// assignor/scheduler.mts — the work loop: what starts, what waits, and what is already
// running. Ported from v1's `listener/scheduler.mts` with its one console write replaced
// by an injected logger, since every module says everything through the Logger.
//
// TWO LANES, ONE SHARED PER-BRANCH LOCK:
//  · Regular lane (issue + PR-comment runs) — capped at maxConcurrency (one
//    shared agent quota).
//  · Restack lane (rebase / conflict-fix steps) — UNCAPPED: a restack unblocks a
//    stuck merge and conflicts are rare.
// The per-branch lock is TWO-WAY across both lanes — neither lane touches a
// branch while the other is on it. An item whose branch is held is left queued
// and retried the moment ANY item finishes (pump re-runs on every completion).
//
// Dedup by key. JS is single-threaded, and every run() is started on a microtask
// (never synchronously inside pump), so pump's check-then-start can't race and
// can't be re-entered mid-scan.

import type { ModuleLogger } from "#services/logger.mts";

export interface WorkItem {
  /** Stable identity for dedup, e.g. `${fullName}#${issue}` or `restack:…:feat/A`. */
  key: string;
  /** The branch this item touches — the per-branch lock key. */
  branch: string;
  /** The work to perform; the scheduler is agnostic to what it does. In practice this is
   *  typically a forked child, and it settles when that child exits — so the cap and
   *  the branch lock hold for the child's whole life. */
  run: () => Promise<void>;
}

export interface SchedulerSnapshot {
  paused: boolean;
  pauseReason?: string;
  /** Keys currently running in each lane, and keys waiting. */
  regularInFlight: string[];
  restackInFlight: string[];
  regularQueued: string[];
  restackQueued: string[];
}

export interface Scheduler {
  /** Enqueue onto the capped regular lane. */
  enqueue(item: WorkItem): void;
  /** Enqueue onto the uncapped restack lane. */
  enqueueRestack(item: WorkItem): void;
  /** Stall BOTH lanes — stop STARTING new work; queued work is retained and
   *  in-flight runs finish. Used by the quota pause and the 403 halt (M3.2).
   *  Idempotent; a second pause just updates the reason. */
  pause(reason: string): void;
  /** Lift the pause and drain whatever was retained. */
  resume(): void;
  isPaused(): boolean;
  /** A point-in-time view of both lanes — what is in flight, what is queued, and
   *  whether the scheduler is paused. */
  snapshot(): SchedulerSnapshot;
}

export function createScheduler(maxConcurrency: number, log: ModuleLogger): Scheduler {
  let regular: WorkItem[] = [];
  let restack: WorkItem[] = [];
  const known = new Set<string>(); // dedup: keys queued OR in-flight
  const heldBranches = new Set<string>(); // the shared two-way per-branch lock
  const regularInFlight = new Set<string>(); // counts against the cap
  let paused = false; // both-lanes gate (quota pause / 403 halt)
  let pauseReason: string | undefined;

  function start(item: WorkItem, lane: "regular" | "restack"): void {
    heldBranches.add(item.branch);
    if (lane === "regular") regularInFlight.add(item.key);
    // Scheduling is routine progress, so it is `info`: `milestone` posts a comment on the
    // issue and belongs to the two events a human watching it cares about.
    log.info(
      `▶ start ${item.key} [${lane}] branch=${item.branch}` +
        (lane === "regular" ? ` (${regularInFlight.size}/${maxConcurrency})` : " (uncapped)"),
    );
    // Defer the actual run to a microtask: it must never execute synchronously
    // inside pump()'s filter (a sync run() that enqueues would mutate the array
    // being filtered). By the time run() fires, this pump has fully returned.
    Promise.resolve()
      .then(() => item.run())
      .catch((err: unknown) =>
        // The BACKSTOP, and `error` since #39: the apply path classifies every failed
        // outcome and acts on its scope, so a rejection that escaped it reached no policy
        // at all — nothing recorded it, nothing will retry or quarantine it, and the work
        // item is simply gone. It carries no repo or target, so it pages an operator
        // without commenting on an issue the scheduler knows nothing about.
        log.error(`✗ ${item.key} failed: ${err instanceof Error ? err.message : String(err)}`),
      )
      .finally(() => {
        heldBranches.delete(item.branch);
        regularInFlight.delete(item.key);
        known.delete(item.key);
        pump();
      });
  }

  function pump(): void {
    // Paused (quota / 403): stop STARTING new work in EITHER lane — a restack
    // conflict-fix also spends the shared token, and the scheduler can't cheaply
    // tell a pure host-rebase from an agent rebase, so both lanes stall. Queued
    // work stays put; in-flight runs finish; resume() drains it.
    if (paused) return;
    // Restack lane first (uncapped) so a restack's branch claim is visible to the
    // regular scan below. Keep (return true) any item whose branch is busy.
    restack = restack.filter((item) => {
      if (heldBranches.has(item.branch)) return true;
      start(item, "restack");
      return false;
    });
    regular = regular.filter((item) => {
      if (regularInFlight.size >= maxConcurrency) return true;
      if (heldBranches.has(item.branch)) return true;
      start(item, "regular");
      return false;
    });
  }

  function enqueueInto(queue: WorkItem[], item: WorkItem): void {
    if (known.has(item.key)) {
      log.info(`· skip ${item.key} — already queued or in-flight`);
      return;
    }
    known.add(item.key);
    queue.push(item);
    pump();
  }

  return {
    enqueue(item) {
      enqueueInto(regular, item);
    },
    enqueueRestack(item) {
      enqueueInto(restack, item);
    },
    pause(reason) {
      pauseReason = reason;
      if (paused) return;
      paused = true;
      log.info(`⏸ scheduler paused — ${reason}`);
    },
    resume() {
      if (!paused) return;
      paused = false;
      pauseReason = undefined;
      log.info("▶ scheduler resumed");
      pump();
    },
    isPaused: () => paused,
    snapshot() {
      // in-flight = known minus what's still queued in either lane.
      const queued = new Set([...regular, ...restack].map((i) => i.key));
      const inFlight = [...known].filter((k) => !queued.has(k));
      return {
        paused,
        pauseReason,
        regularInFlight: inFlight.filter((k) => regularInFlight.has(k)),
        restackInFlight: inFlight.filter((k) => !regularInFlight.has(k)),
        regularQueued: regular.map((i) => i.key),
        restackQueued: restack.map((i) => i.key),
      };
    },
  };
}
