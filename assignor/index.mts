// assignor/index.mts — the Assignor: the one thing in Sunday that DECIDES. A delivery
// arrives normalised, it is routed by event type, an issue is admitted or rejected with
// a reason, and an admitted work item is claimed, queued and forked.

import type { RepoConfig } from "#config/repos.mts";
// Type-only, so the worker stays OUT of the parent's import graph (ADR-0001): the job
// shape is a contract, and the entry point itself is only ever reached by path.
import type { Job } from "#issue/run.mts";
import { readLock, releaseLock } from "#lib/lock.mts";
import { clearOutcome, readOutcome, type Outcome } from "#lib/outcome.mts";
import { CLAIM_LABEL, type GitHub } from "#services/github/index.mts";
import type { ModuleLogger } from "#services/logger.mts";
import type { Scheduler } from "./scheduler.mts";
import type { StateStore } from "./state.mts";

/** One webhook delivery, normalised — `event`, `action`, and who it is about. The
 *  receiver (`services/github/receiver.mts`) builds these and decides NOTHING; every
 *  decision taken on one is taken here. */
export interface Delivery {
  /** The `X-GitHub-Event` header: `issues`, `issue_comment`, `pull_request`, … */
  event: string;
  action: string;
  /** `repository.full_name` as the payload spelled it — untrusted until it matches a
   *  configured repo, which is what admission does (constraint 14). */
  repo: string;
  /** The issue or PR number the delivery is about. Likewise untrusted: it becomes a
   *  work-item key and a path segment. */
  number: number;
  labels: string[];
}

/** How a forked child ENDED. Not what it produced — the parent applies that from the
 *  result file (constraint 4) — but a child that exits leaving no file at all is a
 *  failed work item carrying this (constraint 6). */
export interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Why the child never RAN, when it never did — a spawn that failed has neither a code
   *  nor a signal, and `code null` on its own reads as a clean exit. */
  error?: string;
}

/** Fork one work item and settle when it EXITS, so the concurrency cap and the branch
 *  lock hold for the child's whole life. Injected: `main.mts` supplies the real one
 *  (`fork()` on `issue/run.mts` BY PATH, ADR-0001) and a test supplies one that spawns
 *  nothing. */
export type ForkWorkItem = (job: Job) => Promise<ChildExit>;

/** The `var/` layout, as `lib/paths.mts` exports it. Injected rather than imported, for
 *  the same reason the child is handed its paths (constraint 7): a smoke drives the real
 *  Assignor against a throwaway dir instead of the real `var/`. */
export interface Paths {
  resultPath(key: string): string;
  pidPath(key: string): string;
  runLogPath(fullName: string, flow: string): string;
  eventLogPath: string;
}

/** Everything the Assignor needs and constructs none of (constraint 8): the two things
 *  that reach the world (GitHub, the fork), the two that write to disk (the state store,
 *  the paths), the queue, and the Logger everything is said through. */
export interface AssignorDeps {
  repos: Record<string, RepoConfig>;
  github: GitHub;
  log: ModuleLogger;
  scheduler: Scheduler;
  state: StateStore;
  fork: ForkWorkItem;
  paths: Paths;
}

/** `issues` actions that should (re)consider an issue. NOT `unlabeled`/`edited`: those
 *  fire when WE add or remove the claim, and admitting on them re-runs a finished issue.
 *  Ported from v1's `listener/listen.mts`. */
const ADMIT_ACTIONS = new Set(["opened", "reopened", "labeled"]);

/** Event types the pipeline knows and this issue deliberately does not act on, so
 *  "not built yet" and "never heard of it" are different lines in the log: comment runs
 *  and gate resumes are #44, the DAG re-evaluation and restack cascade #42/#43. */
const KNOWN_UNBUILT = new Set(["issue_comment", "pull_request", "pull_request_review_comment"]);

/** A spec describes the shape of a feature; its child issues are the work (CONTEXT.md).
 *  The literal is ported from v1's `listener/helper.mts` rather than imported — v1 and
 *  V2 must not cross-import until cutover deletes v1. */
const SPEC_LABEL = "spec";

/** One work item's IDENTITY, resolved once at admission: what a fork, an outcome and a
 *  comment all have to agree on. (`scheduler.mts`'s `WorkItem` is the other half — the
 *  same item as something to queue, dedup and hold a branch for.) */
export interface WorkItemRef {
  /** `<owner>/<repo>#<issue>` — the scheduler's dedup key and the outcome's name. */
  key: string;
  /** The CONFIGURED repo full name (constraint 14). */
  repo: string;
  issue: number;
}

/** The inverse of the key `considerIssue` builds, for the one caller that has to go the
 *  other way: #35's boot sweep, which reads a key out of a result file left on disk.
 *  Constraint 14 applies there too and MORE so — nothing proves that file came from a
 *  child of ours, and its key becomes a path segment, an issue Sunday comments on, and a
 *  claim Sunday strips. So a key is only a work item if its repo is one this parent
 *  ROUTES and its issue is a positive integer, and the ref is rebuilt from those rather
 *  than trusted as spelled. Lives here because this is the file that spells keys — a
 *  parse that drifted from the format would resolve to the wrong work item. */
export function parseWorkItemKey(key: string, table: Record<string, RepoConfig>): WorkItemRef | undefined {
  const at = key.lastIndexOf("#");
  if (at === -1) return undefined;
  const repo = key.slice(0, at);
  const issue = Number(key.slice(at + 1));
  // `hasOwn`, not a truthiness check: `table["__proto__"]` is an object on every table
  // there is, and reading it as a routed repo is how untrusted input gets in.
  if (!Object.hasOwn(table, repo)) return undefined;
  if (!Number.isInteger(issue) || issue <= 0) return undefined;
  const ref: WorkItemRef = { key: `${repo}#${issue}`, repo, issue };
  // Rebuilt and compared, so a key that only LOOKS canonical (`#0057`, `#57.0`) cannot
  // name one work item on disk and a different one in the state file.
  return ref.key === key ? ref : undefined;
}

export type Admission = { admit: true } | { admit: false; reason: string };

/** Is this issue Sunday's to work? Its repo must be routed, it must not already be
 *  claimed, it must not be a spec, and ALL of its repo's trigger labels must be present.
 *
 *  PURE, and the ORDER is load-bearing: the spec check precedes the trigger check, so a
 *  spec mis-labelled for the agent is rejected whatever else is on it — admitted, it
 *  would be relabelled and run (#35). Ported from v1's `listener/listen.mts`. */
export function admitIssue(
  repo: string,
  labels: string[],
  table: Record<string, RepoConfig>,
): Admission {
  const cfg = table[repo];
  if (!cfg) return { admit: false, reason: `${repo} not in config/repos.json` };
  const present = new Set(labels);
  if (present.has(CLAIM_LABEL)) return { admit: false, reason: `already claimed (${CLAIM_LABEL})` };
  if (present.has(SPEC_LABEL)) return { admit: false, reason: "spec issue — a manifest, not implementable" };
  const missing = cfg.triggerLabels.filter((label) => !present.has(label));
  if (missing.length > 0) return { admit: false, reason: `missing trigger label(s) [${missing.join(", ")}]` };
  return { admit: true };
}

export class Assignor {
  // Declared, not parameter properties: Node runs `.mts` in strip-only mode, which
  // rejects `constructor(private x)`.
  private readonly repos: Record<string, RepoConfig>;
  private readonly github: GitHub;
  private readonly log: ModuleLogger;
  private readonly scheduler: Scheduler;
  private readonly state: StateStore;
  private readonly fork: ForkWorkItem;
  private readonly paths: Paths;

  constructor(deps: AssignorDeps) {
    this.repos = deps.repos;
    this.github = deps.github;
    this.log = deps.log;
    this.scheduler = deps.scheduler;
    this.state = deps.state;
    this.fork = deps.fork;
    this.paths = deps.paths;
  }

  /** Route one delivery. EVERY one leaves a line behind, including the event types this
   *  issue does not handle (constraint 10): a work item dropped in silence is the defect
   *  class this rewrite exists to kill. */
  handle(delivery: Delivery): void {
    const { event, action, repo, number, labels } = delivery;
    const what = `${event}${action ? `.${action}` : ""}`;
    this.log.info(`← ${what} ${repo}#${number}${labels.length > 0 ? ` [${labels.join(", ")}]` : ""}`);
    if (event === "issues" && ADMIT_ACTIONS.has(action)) {
      this.considerIssue(delivery);
      return;
    }
    this.log.info(
      KNOWN_UNBUILT.has(event)
        ? `· ${what} — recognised, and not the spine's to handle (#42/#43/#44)`
        : `· ${what} — no route`,
    );
  }

  /** Admit an issue, or say why not. Four guards, cheapest and most durable first: is it
   *  Sunday's work at all, is the number one, is the item already somewhere in its life,
   *  and is a process still on it. */
  private considerIssue({ repo, number, labels }: Delivery): void {
    const decision = admitIssue(repo, labels, this.repos);
    if (!decision.admit) {
      this.log.info(`· skip ${repo}#${number} — ${decision.reason}`);
      return;
    }
    // Constraint 14: a work-item key and the path segments built from it come from the
    // CONFIGURED repo name (admission is the exact match that proved it) and a number
    // that IS one — never from a raw payload string.
    if (!Number.isInteger(number) || number <= 0) {
      this.log.info(`· skip ${repo} — ${JSON.stringify(number)} is not an issue number`);
      return;
    }
    const item: WorkItemRef = { key: `${repo}#${number}`, repo, issue: number };
    // A `failed` item is retried when a human re-labels it; anything else is already
    // somewhere in its life and must not be started again.
    const prior = this.state.get(item.key);
    if (prior && prior.status !== "failed") {
      this.log.info(`· skip ${item.key} — state=${prior.status}`);
      return;
    }
    // The guard the in-memory queue cannot be: children deliberately outlive the parent
    // (hot-reload, crash, deploy — ADR-0001), so a live lock means someone IS on this
    // item whatever this process remembers.
    const lock = readLock(this.paths.pidPath(item.key));
    if (lock?.alive) {
      this.log.info(`· skip ${item.key} — pid ${lock.pid} is still on it`);
      return;
    }
    // Claim BEFORE the queue: the claim is what the NEXT delivery reads, and it may
    // arrive long before this item reaches the front of a full lane.
    this.github.claim(item.repo, item.issue);
    this.state.set(item.key, { status: "in-flight" });
    const cfg = this.repos[item.repo]; // admission passed, so the repo is routed
    this.scheduler.enqueue({ key: item.key, branch: `feat/${item.issue}`, run: () => this.run(item, cfg) });
  }

  /** One work item, from the fork to its applied outcome. Handed to the scheduler, and
   *  it settles when the CHILD exits — so the cap and the branch lock hold for the
   *  child's whole life rather than just for the fork call. */
  private async run(item: WorkItemRef, cfg: RepoConfig): Promise<void> {
    const job: Job = {
      key: item.key,
      repo: item.repo,
      issue: item.issue,
      config: cfg,
      // Every path the child writes is resolved HERE (constraint 7). The child derives
      // none, which is what lets a smoke fork the real entry point into a temp dir.
      resultPath: this.paths.resultPath(item.key),
      pidPath: this.paths.pidPath(item.key),
      runLogPath: this.paths.runLogPath(item.repo, String(item.issue)),
      eventLogPath: this.paths.eventLogPath,
    };
    // Milestone 1 of exactly two (constraint 12) — every one posts a comment on the
    // issue, so a third is thread spam.
    this.log.milestone("▶ work started", { repo: item.repo, target: item.issue });
    // The IPC report the child sends on the way out is deliberately not waited for: it
    // says an outcome is READY, and the file it points at is what gets applied.
    this.applyOutcome(item, await this.fork(job));
  }

  /** The pid of the process still working this item, or `undefined` when nobody is. The
   *  Assignor owns the PID lock — #35's boot sweep and reconcile ASK, and neither reads
   *  `var/running/` for itself, so the one guard that stops two agents running the same
   *  issue has exactly one reading of it. */
  liveChild(key: string): number | undefined {
    const lock = readLock(this.paths.pidPath(key));
    return lock?.alive === true ? lock.pid : undefined;
  }

  /** Apply a finished work item's outcome, FROM THE FILE the child left (constraint 4).
   *  #35's boot sweep applies through this same method — one path is what stops the live
   *  and recovery paths drifting apart, which is exactly how v1's restack lost its
   *  guards. `exit` is how the child ended, known only to a process that watched it. */
  applyOutcome(item: WorkItemRef, exit?: ChildExit): void {
    const read = readOutcome(this.paths.resultPath(item.key));
    if (read.state === "unreadable") {
      // Parseable is not usable. Recording it failed and clearing it is the only way the
      // item does not sit in-flight with its claim on it forever.
      this.record(item, "failed", `unreadable outcome — ${read.detail}`);
      return;
    }
    if (read.state === "absent") {
      // No file and the item is no longer in-flight: it was applied and cleared already.
      // The file's presence IS the idempotency guard, so this is the common answer and
      // the reason a second apply comments once.
      if (this.state.get(item.key)?.status !== "in-flight") {
        this.log.info(`· nothing to apply for ${item.key}`);
        return;
      }
      // Constraint 6: a child that dies is an exit code, not a dead pipeline. Recorded
      // failed carrying it, never left in-flight; classifying it is #39's job.
      this.record(item, "failed", describeChildFailure(exit));
      return;
    }
    this.record(item, read.outcome.status, read.outcome.summary);
  }

  /** The apply ORDER, spelled once (constraint 5): durable state, the milestone, the
   *  result file, the lock, then the claim. A crash part-way through re-applies on the
   *  next boot rather than losing the outcome — a repeated comment is a visible harmless
   *  failure, a lost one is silent. */
  private record(item: WorkItemRef, status: Outcome["status"], summary: string): void {
    this.state.set(item.key, { status });
    // Milestone 2 of exactly two (constraint 12).
    this.log.milestone(`${status === "done" ? "✓" : "✗"} ${status} — ${summary}`, {
      repo: item.repo,
      target: item.issue,
    });
    clearOutcome(this.paths.resultPath(item.key));
    releaseLock(this.paths.pidPath(item.key));
    // Last, because it is the most durable of the four: while the claim is on, a delivery
    // arriving in the middle of all this reads the issue as taken.
    this.github.release(item.repo, item.issue);
  }
}

/** How a child failed its work item, for the human reading the comment. A signal is not
 *  an exit code and a child that never started is neither: "code null" says nothing
 *  about a SIGKILL and less about a fork that never got a process at all. */
function describeChildFailure(exit?: ChildExit): string {
  if (!exit) return "no outcome, and no exit recorded";
  if (exit.error) return `child never started — ${exit.error}`;
  return `child exited ${exit.signal ? `on ${exit.signal}` : `with code ${exit.code}`} leaving no outcome`;
}
