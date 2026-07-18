// listener/scheduler.mts — the serializing work loop (M2, step 4).
//
// One process, one loop. Admitted issues are enqueued and run at most
// maxConcurrency at a time (one shared agent quota). Dedup by key: a duplicate
// (re-delivery, rapid labels) for an issue already queued or in-flight is
// dropped — the intra-process double-launch guard. JS is single-threaded, so
// enqueue's check-then-add can't race within the process. (The durable cross-
// restart guard is the `agent-working` label, applied by the run thunk.)

export interface WorkItem {
  /** Stable identity, e.g. `${fullName}#${issue}`. */
  key: string;
  /** The work to perform; the scheduler is agnostic to what it does. */
  run: () => Promise<void>;
}

export interface Scheduler {
  enqueue(item: WorkItem): void;
}

export function createScheduler(
  maxConcurrency: number,
  log: (msg: string) => void = console.log,
): Scheduler {
  const queue: WorkItem[] = [];
  const inFlight = new Set<string>();
  const queued = new Set<string>();

  function pump(): void {
    while (inFlight.size < maxConcurrency && queue.length > 0) {
      const item = queue.shift()!;
      queued.delete(item.key);
      inFlight.add(item.key);
      log(`▶ start ${item.key} (in-flight ${inFlight.size}/${maxConcurrency})`);
      item
        .run()
        .catch((err: unknown) =>
          log(
            `✗ ${item.key} failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        )
        .finally(() => {
          inFlight.delete(item.key);
          pump();
        });
    }
  }

  return {
    enqueue(item: WorkItem): void {
      if (inFlight.has(item.key) || queued.has(item.key)) {
        log(
          `· skip ${item.key} — already ${inFlight.has(item.key) ? "in-flight" : "queued"}`,
        );
        return;
      }
      queued.add(item.key);
      queue.push(item);
      pump();
    },
  };
}
