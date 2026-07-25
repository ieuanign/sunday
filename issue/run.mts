// issue/run.mts — the fork entry point for one issue run. The parent forks this file
// BY PATH (ADR-0001), so nothing here is in the parent's import graph and editing it
// takes effect on the next work item with no restart.

import type { RepoConfig } from "#config/repos.mts";
import { acquireLock, releaseLock } from "../lib/lock.mts";
import { writeOutcome, type Outcome } from "../lib/outcome.mts";
import { createLogger } from "../services/destinations.mts";

/** The fully-resolved description of one issue run, handed over at fork time. The
 *  child derives nothing: every path it writes is in here, so the parent decides once
 *  and a smoke can point the real entry point at a throwaway dir. */
export interface Job {
  /** The work-item key (`<owner>/<repo>#<issue>`) the outcome is named back with. */
  key: string;
  /** `<owner>/<repo>`, from the routing table — never a raw payload string. */
  repo: string;
  issue: number;
  /** How Sunday runs this repo, resolved by the parent from the routing table so the
   *  child works from the same config the delivery was routed with. #36 is the first
   *  consumer — the spine has no agent to configure yet. */
  config: RepoConfig;
  /** Where the child drops its result for the parent to apply. */
  resultPath: string;
  /** The PID lock the child holds while it is alive. */
  pidPath: string;
  /** This run's own log — one file per work item, so concurrent runs do not interleave. */
  runLogPath: string;
  /** The shared append-only event log. Handed over rather than read from
   *  `lib/paths.mts` for the same reason as the other three: the child derives no path. */
  eventLogPath: string;
}

/** What the child sends over IPC once its outcome is durable. A NOTIFICATION only:
 *  the parent applies from the file, so a message that never arrives (a child killed
 *  between the two) costs a boot sweep, not the work. */
export interface Report {
  type: "outcome";
  key: string;
}

const job = JSON.parse(process.argv[2]) as Job;

// First thing, and with this process's own pid: from here until it exits, a parent
// that comes back up can see that someone is already on this item without having to
// remember anything (ADR-0001).
acquireLock(job.pidPath);

// Its own Logger, over its own run log: a child shares no memory with the parent, so
// what it did has to be durable where the job pointed. Built by the same wiring
// function the parent uses, so neither can drift in what a level reaches.
const log = createLogger({ runLog: job.runLogPath, eventLog: job.eventLogPath }).child("issue");
// Every line this run emits is about this issue, so the destinations address it and the
// run log reads back in context.
const about = { repo: job.repo, target: job.issue };
log.info("▶ start", about);

// #36 puts the agent run here. The spine deliberately does nothing, and says so rather
// than inventing a status for it.
const outcome: Outcome = {
  key: job.key,
  status: "done",
  summary: "spine only — no agent ran",
  finishedAt: new Date().toISOString(),
};

writeOutcome(job.resultPath, outcome);
// `info`, not `milestone`: a milestone posts a comment on the issue, and the two the
// pipeline has belong to the parent (work started, outcome applied).
log.info(`✓ ${outcome.status} — ${outcome.summary}`, about);

// Only now, and never before: the parent may die in the instant between the write and
// this line, and finished work that exists nowhere on disk is finished work lost
// (ADR-0001).
await report({ type: "outcome", key: job.key });

// Last, so the lock covers the whole run: the parent clears it again while applying
// the outcome (neither can assume it went first), and a child killed before this line
// leaves a lock whose pid reads as not-alive rather than a wedged work item.
releaseLock(job.pidPath);

// No `process.exit()`: the run ends when its work does, so nothing can truncate a
// pending write. The IPC channel does not hold the loop open — this process never
// listens for messages, and the parent settles on the exit.

/** Hand the notification over, and wait until it is actually on the wire — a child
 *  that exits with its message still buffered leaves the parent holding an exit code
 *  instead of an outcome. */
function report(message: Report): Promise<void> {
  const send = process.send?.bind(process);
  // Not forked (someone ran this by hand): the outcome file IS the handoff, and the
  // boot sweep picks it up.
  if (!send) return Promise.resolve();
  return new Promise((resolve, reject) => {
    send(message, (err: Error | null) => (err ? reject(err) : resolve()));
  });
}
