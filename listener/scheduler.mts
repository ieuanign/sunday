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

export interface Scheduler {
  /** Enqueue onto the capped regular lane. */
  enqueue(item: WorkItem): void;
  /** Enqueue onto the uncapped restack lane. */
  enqueueRestack(item: WorkItem): void;
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
  };
}
