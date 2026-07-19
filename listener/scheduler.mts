// listener/scheduler.mts — the work loop (M2, step 4 + the 6c restack lane).
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

export interface WorkItem {
  /** Stable identity for dedup, e.g. `${fullName}#${issue}` or `restack:…:feat/A`. */
  key: string;
  /** The branch this item touches — the per-branch lock key. */
  branch: string;
  /** The work to perform; the scheduler is agnostic to what it does. */
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
  /** A point-in-time view for `sunday status` / Telegram `/status` (M3.6). */
  snapshot(): SchedulerSnapshot;
}

export function createScheduler(
  maxConcurrency: number,
  log: (msg: string) => void = console.log,
): Scheduler {
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
    log(
      `▶ start ${item.key} [${lane}] branch=${item.branch}` +
        (lane === "regular" ? ` (${regularInFlight.size}/${maxConcurrency})` : " (uncapped)"),
    );
    // Defer the actual run to a microtask: it must never execute synchronously
    // inside pump()'s filter (a sync run() that enqueues would mutate the array
    // being filtered). By the time run() fires, this pump has fully returned.
    Promise.resolve()
      .then(() => item.run())
      .catch((err: unknown) =>
        log(`✗ ${item.key} failed: ${err instanceof Error ? err.message : String(err)}`),
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

  function enqueueInto(queue: WorkItem[], item: WorkItem, lane: string): void {
    if (known.has(item.key)) {
      log(`· skip ${item.key} — already queued or in-flight`);
      return;
    }
    known.add(item.key);
    queue.push(item);
    pump();
  }

  return {
    enqueue(item) {
      enqueueInto(regular, item, "regular");
    },
    enqueueRestack(item) {
      enqueueInto(restack, item, "restack");
    },
    pause(reason) {
      pauseReason = reason;
      if (paused) return;
      paused = true;
      log(`⏸ scheduler paused — ${reason}`);
    },
    resume() {
      if (!paused) return;
      paused = false;
      pauseReason = undefined;
      log("▶ scheduler resumed");
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
