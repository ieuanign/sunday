// issue/run-one.mts — drive ONE work item by hand, without the parent (#38 AC5).
//
//   npm run run-one -- acme/finance#57
//   node --env-file=.env issue/run-one.mts acme/finance#57
//
// For a repo whose webhooks are not wired yet, an item the operator wants to re-run after
// fixing something by hand, and the cutover (#45). It forks the REAL entry point through
// the same `assignor/fork.mts` the parent uses, so a hand run is the same run — same
// preconditions, same agent, same push, same outcome file — and never a second pipeline
// that drifts from the one on duty.
//
// What it deliberately does NOT do (constraint 12): it never claims the issue and never
// applies the outcome. The result file is left exactly where a dead parent's leftovers
// are left, and #35's boot sweep applies it through `Assignor.applyOutcome` — the one
// apply path. And it refuses outright while another process holds the item's lock: two
// agents on one issue is duplicate quota and a duplicate pull request.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveBase } from "#assignor/dag.mts";
import { createForkWorkItem } from "#assignor/fork.mts";
import { parseWorkItemKey, type Paths } from "#assignor/index.mts";
import { loadRepos, type RepoConfig } from "#config/repos.mts";
import { readLock } from "#lib/lock.mts";
import { eventLogPath, fallbackLogPath, pidPath, resultPath, runLogPath } from "#lib/paths.mts";
import { createLogger } from "#services/destinations.mts";
import { Gh, type GitHub } from "#services/github/index.mts";
// Type-only, exactly as the parent names it (ADR-0001): the job shape is a contract and
// the entry point is only ever reached BY PATH. A value import here would RUN it.
import type { Job } from "./run.mts";

/** What a hand-typed key resolves to: the job to fork, or why this run is refused. */
export type HandRun = { job: Job } | { refuse: string };

/** Everything the decision needs and constructs none of, for the reason every other
 *  module here takes its services injected (#34 constraint 7): a driver that reached the
 *  real routing table, the real `gh` and the real `var/` could not be driven offline. */
export interface HandRunDeps {
  repos: Record<string, RepoConfig>;
  github: GitHub;
  paths: Paths;
}

/** Resolve one hand-typed work-item key into the job the child is forked with — the
 *  whole decision, and the only part of this file that is not wiring.
 *
 *  The base comes from the SAME `resolveBase` admission uses, and a deferral refuses the
 *  run rather than falling back to `main` (#42): an item whose blocker is still open
 *  opens a pull request carrying somebody else's commits. */
export async function planRun(key: string, deps: HandRunDeps): Promise<HandRun> {
  // The key is typed by a human and becomes a path segment, an issue a real agent is
  // pointed at, and a branch pushed to an origin. It is a work item only if this
  // workspace routes its repo — the same reading of a key #35's sweep applies to a file
  // nothing proves came from us.
  const item = parseWorkItemKey(key, deps.repos);
  if (!item) return { refuse: `${JSON.stringify(key)} is not a work item this workspace routes — expected <owner>/<repo>#<issue> naming a repo in config/repos.json` };
  // `#pr<n>` parses as a work item too (#44), and this driver forks the ISSUE worker: run
  // one and a real agent is pointed at whatever issue happens to be numbered `n`, opening
  // a pull request for work nobody asked about. A comment run is the parent's — it is
  // triggered by a summon and re-derived by reconcile, so there is nothing to drive here.
  if (item.kind === "pr") return { refuse: `${item.key} is a pull-request comment run, which this driver does not start — comment @sunday on the pull request instead` };

  // BEFORE the reads, and it is the guard this driver exists behind: the parent may
  // already have a child on this item (or an operator may have started one in another
  // terminal), and a second agent on one issue is duplicate quota, two pushes to one
  // branch and a duplicate pull request. `alive`, not mere presence — a lock left behind
  // by a killed child is not a holder, and reading it as one wedges the item for good.
  const lock = readLock(deps.paths.pidPath(item.key));
  if (lock?.alive) return { refuse: `${item.key} is already being worked by pid ${lock.pid}` };

  const base = await resolveBase(deps.github, item.repo, item.issue);
  if (!base.admit) return { refuse: `${item.key} is not ready to run — ${base.reason}` };

  return {
    job: {
      key: item.key,
      repo: item.repo,
      issue: item.issue,
      config: deps.repos[item.repo],
      base: base.base,
      // Resolved HERE and carried, exactly as the Assignor resolves them: the child
      // derives no path of its own (#34 constraint 7).
      resultPath: deps.paths.resultPath(item.key),
      pidPath: deps.paths.pidPath(item.key),
      runLogPath: deps.paths.runLogPath(item.repo, String(item.issue)),
      eventLogPath: deps.paths.eventLogPath,
    },
  };
}

// The CLI half, guarded so the smoke can import the decision above without running one
// — the idiom the lint script in `scripts/` already uses for the same reason. Wiring
// only: the real routing table, the real `gh`, the real `var/` layout and a real fork.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  // The driver's own lines, at `info` and nowhere else (constraint 12): `milestone` and
  // `error` post a comment on the issue and reach the phone, and a hand run must not
  // speak as the pipeline. The run's OWN log is the child's, at the path in the job.
  const log = createLogger({ runLog: fallbackLogPath, eventLog: eventLogPath }).child("run-one");
  const key = process.argv[2];
  if (!key) {
    log.info("usage: npm run run-one -- <owner>/<repo>#<issue>");
    process.exit(1);
  }

  const planned = await planRun(key, {
    repos: loadRepos(),
    github: new Gh(),
    paths: { resultPath, pidPath, runLogPath, eventLogPath },
  });
  if ("refuse" in planned) {
    log.info(`· refusing to run — ${planned.refuse}`);
    process.exit(1);
  }

  const { job } = planned;
  const about = { repo: job.repo, target: job.issue };
  log.info(`▶ ${job.key} by hand — on ${job.base}`, about);
  const exit = await createForkWorkItem()(job);
  // Applied by nobody here (constraint 12): the outcome file is left where a dead
  // parent's leftovers are left, and the next boot's sweep settles it — claim released,
  // state recorded, comment posted — through the one apply path.
  log.info(`· exit code ${exit.code ?? "none"}${exit.error ? ` — ${exit.error}` : ""} — outcome left at ${job.resultPath} for the next boot to apply`, about);
  process.exit(exit.code ?? 1);
}
