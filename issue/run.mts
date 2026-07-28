// issue/run.mts — the fork entry point for one issue run. The parent forks this file
// BY PATH (ADR-0001), so nothing here is in the parent's import graph and editing it
// takes effect on the next work item with no restart.
//
// WIRING, and deliberately nothing else: take the lock, build the Logger over the job's
// paths, resolve what the Job NAMES, hand it all to the module that decides, and make its
// answer durable. Every decision a run makes lives in `issue/index.mts` over injected
// services — which is what lets the whole set of them be driven with no docker, no git,
// no network and no quota (`test/smoke-issue-run.mts`).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { RepoConfig } from "#config/repos.mts";
import { acquireLock, releaseLock } from "#lib/lock.mts";
import { writeOutcome, type Outcome } from "#lib/outcome.mts";
import { selectAgent } from "#services/agent/index.mts";
import { createLogger } from "#services/destinations.mts";
import { GitCli } from "#services/git.mts";
import { Gh } from "#services/github/index.mts";
import { imagePresent } from "#services/sandbox.mts";
import { IssueModule } from "./index.mts";

/** The workspace root the routing table's `path` and `promptFile` are relative to — this
 *  file sits one level under it, exactly as `main.mts` sits on it. */
const parentRoot = resolve(import.meta.dirname, "..");

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
   *  child works from the same config the delivery was routed with. The run resolves its
   *  child checkout, its image and its baseline prompt out of it. */
  config: RepoConfig;
  /** The branch this run bases on and its PR targets: `main`, or `feat/<blocker>` when
   *  the Assignor stacked it on a blocker whose PR is already open (#42). Decided by the
   *  ASSIGNOR and carried here rather than recomputed: the child would be asking GitHub
   *  the same question minutes later and could get a different answer (constraint 8). */
  base: string;
  /** Where the child drops its result for the parent to apply. */
  resultPath: string;
  /** The PID lock the child holds while it is alive. */
  pidPath: string;
  /** This run's own log — one file per work item, so concurrent runs do not interleave. */
  runLogPath: string;
  /** The shared append-only event log. Handed over rather than read from
   *  `lib/paths.mts` for the same reason as the other three: the child derives no path. */
  eventLogPath: string;
  /** Present when this run CONTINUES the session an earlier one gated on: the handle the
   *  parent kept in durable state, what the human replied, and how big that session had
   *  grown when it gated (#67) — the child cannot measure a session it has not run yet,
   *  and absent means the parent has no number, which reads as the ordinary resume. */
  resume?: { sessionId: string; reply: string; contextTokens?: number };
  /** The error the PREVIOUS run of this item died on, when this run is #39's one retry.
   *  It goes into the prompt: it is the only thing this run knows that the last one did
   *  not, and without it the retry is the same run again on fresh quota. */
  retryError?: string;
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
const logger = createLogger({ runLog: job.runLogPath, eventLog: job.eventLogPath });
const log = logger.child("issue");
// Every line this run emits is about this issue, so the destinations address it and the
// run log reads back in context.
const about = { repo: job.repo, target: job.issue };
log.info("▶ start", about);

const outcome = await runIssue();

writeOutcome(job.resultPath, outcome);
// `info`, not `milestone`: a milestone posts a comment on the issue, and the two the
// pipeline has belong to the parent (work started, outcome applied).
log.info(`${outcome.status} — ${outcome.summary}`, about);

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

/** Resolve what the Job names and run it. The module itself never throws — it answers
 *  with an outcome, whatever happened — so what this catch is for is the RESOLUTION: a
 *  `promptFile` the routing table points at nothing, an `AGENT` nobody implements. Those
 *  are one work item's failure and they have a reason worth reading, so they leave the
 *  same durable outcome any other failure does rather than a bare exit code the parent
 *  has to guess at. */
async function runIssue(): Promise<Outcome> {
  try {
    const issueRun = new IssueModule({
      // `AGENT` (and `MODEL`, and the agent's token) reaches the child through the fork,
      // from a parent started with `--env-file=.env`; the child loads no env of its own.
      agent: selectAgent(process.env.AGENT, logger),
      github: new Gh(),
      git: new GitCli(),
      // The plain probe, not the sandbox SERVICE: the module takes a function so it
      // names no library type and a smoke answers it without docker (#38 constraint 11).
      imagePresent,
      log,
    });
    return await issueRun.run({
      key: job.key,
      repo: job.repo,
      issue: job.issue,
      childDir: resolve(parentRoot, job.config.path),
      // The Assignor's decision, carried through untouched (#42 constraint 8).
      base: job.base,
      imageName: job.config.imageName,
      // From the SAME routing-table entry admission decided on, so the run asserts
      // against exactly what admitted it (#38) — no new `Job` field for it.
      triggerLabels: job.config.triggerLabels,
      // Read HERE, not in there: the module resolves no path and opens no file, which is
      // the only reason its decisions can be driven with nothing on disk.
      baselinePrompt: readFileSync(resolve(parentRoot, job.config.promptFile), "utf8"),
      // The run log is the agent's log too — the library appends its raw output to the
      // path it is handed, so one work item reads back in one file.
      logPath: job.runLogPath,
      // Undefined on a fresh run, which is what the module reads as "start from the
      // baseline prompt" — the parent decides which of the two this is.
      resume: job.resume,
      // Likewise the parent's decision: present only on the ONE retry a failed item gets
      // (#39), carrying what the attempt before this died on.
      retryError: job.retryError,
    });
  } catch (err) {
    return {
      key: job.key,
      status: "failed",
      summary: err instanceof Error ? err.message : String(err),
      finishedAt: new Date().toISOString(),
    };
  }
}

/** Hand the notification over, and wait until it is actually on the wire — a child
 *  that exits with its message still buffered leaves the parent holding an exit code
 *  instead of an outcome.
 *
 *  Never rejects. A parent that has GONE (a hot-reload save, a crash, a deploy) makes
 *  the send fail for certain, and this is called at module top level where a rejection
 *  is unhandled: the child would die non-zero AFTER writing its outcome and BEFORE
 *  releasing its lock, leaving the work item wedged behind a lock nobody will clear
 *  until its pid stops reading as alive. The outcome is already durable by the time we
 *  get here and the parent applies it from the FILE, so a message nobody receives costs
 *  a boot sweep, not the work (ADR-0001). */
function report(message: Report): Promise<void> {
  const send = process.send?.bind(process);
  // Not forked (someone ran this by hand): the outcome file IS the handoff, and the
  // boot sweep picks it up.
  if (!send) return Promise.resolve();
  // `settle`, not `resolve`: this file imports `resolve` from `node:path` now, and a
  // promise callback that shadows it is one edit away from a path that never resolves.
  return new Promise((settle) => {
    send(message, (err: Error | null) => {
      // Said once, at `info`: nothing here is an incident. `error` would post a comment
      // on the issue, and the two this pipeline posts are the parent's (work started,
      // outcome applied).
      if (err) log.info(`no parent to report to — outcome left on disk (${err.message})`, about);
      settle();
    });
  });
}
