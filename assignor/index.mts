// assignor/index.mts — the Assignor: the one thing in Sunday that DECIDES. A delivery
// arrives normalised, it is routed by event type, an issue is admitted or rejected with
// a reason, and an admitted work item is claimed, queued and forked.

import type { RepoConfig } from "#config/repos.mts";
// Type-only, so the worker stays OUT of the parent's import graph (ADR-0001): the job
// shape is a contract, and the entry point itself is only ever reached by path.
import type { Job } from "#issue/run.mts";
import { readLock, releaseLock } from "#lib/lock.mts";
import { isSummon, SUNDAY_MARKER } from "#lib/markers.mts";
import { clearOutcome, OUTCOME_STATUSES, readOutcome, type Outcome } from "#lib/outcome.mts";
import { CLAIM_LABEL, type GitHub } from "#services/github/index.mts";
import type { ModuleLogger } from "#services/logger.mts";
import type { Scheduler } from "./scheduler.mts";
import type { StateStore } from "./state.mts";

/** One issue, as ADMISSION needs to see it: which repo, which number, and the labels on
 *  it right now. `Delivery` is a superset of exactly this, which is the point — the live
 *  route and #35's reconcile hand `considerIssue` the SAME shape, so there is one
 *  admission path rather than a live one and a recovery one that drift. */
export interface IssueCandidate {
  /** `repository.full_name` as the payload spelled it — untrusted until it matches a
   *  configured repo, which is what admission does (constraint 14). */
  repo: string;
  /** The issue number this is about. Likewise untrusted: it becomes a work-item key and
   *  a path segment. */
  number: number;
  labels: string[];
}

/** One webhook delivery, normalised — `event`, `action`, and who it is about. The
 *  receiver (`services/github/receiver.mts`) builds these and decides NOTHING; every
 *  decision taken on one is taken here. */
export interface Delivery extends IssueCandidate {
  /** The `X-GitHub-Event` header: `issues`, `issue_comment`, `pull_request`, … */
  event: string;
  action: string;
  /** What the comment said, when the delivery is one. It is the human's REPLY on a gate
   *  resume, so it is carried whole and judged here rather than in the receiver. */
  comment?: string;
  /** Is the subject a pull request rather than an issue? Required, not optional: a
   *  comment on a PR is #44's work and never an issue run's, and a field left off would
   *  default to the dangerous answer — an issue run resumed from a PR thread. */
  onPullRequest: boolean;
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

/** The event a gate resume arrives on, spelled once for both readings of it below: a
 *  `created` one is routed, and every other action on it is recognised-and-unbuilt. Two
 *  spellings drift into a comment that routes nowhere while the log calls it recognised. */
const COMMENT_EVENT = "issue_comment";

/** Event types the pipeline knows and this issue deliberately does not act on, so
 *  "not built yet" and "never heard of it" are different lines in the log: PR-comment
 *  runs are #44, the DAG re-evaluation and restack cascade #42/#43. A created comment is
 *  routed above (a gate resume); every other comment action lands here. */
const KNOWN_UNBUILT = new Set([COMMENT_EVENT, "pull_request", "pull_request_review_comment"]);

/** A spec describes the shape of a feature; its child issues are the work (CONTEXT.md).
 *  The literal is ported from v1's `listener/helper.mts` rather than imported — v1 and
 *  V2 must not cross-import until cutover deletes v1. */
const SPEC_LABEL = "spec";

/** How each way of finishing opens the comment it is posted as. `⏸` is the same mark
 *  boot and the scheduler use for "held, awaiting a human" — a gate is that, on one work
 *  item. */
const MARK: Record<Outcome["status"], string> = { done: "✓", failed: "✗", "awaiting-human": "⏸" };

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
    if (event === COMMENT_EVENT && action === "created") {
      this.considerReply(delivery);
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
   *  and is a process still on it.
   *
   *  PUBLIC because it is the admission SEAM (constraint 3): #35's reconcile re-derives
   *  open issues from GitHub and hands each one straight to this, rather than carrying a
   *  second copy of these four guards that drifts from this one — which is exactly how
   *  v1's live and recovery paths came apart. It takes an `IssueCandidate` and not a
   *  `Delivery` for the same reason: reconcile has no webhook event to name, and a
   *  synthetic one would put an event in the log that never happened. */
  considerIssue({ repo, number, labels }: IssueCandidate): void {
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

  /** A comment on an issue, which is how a gated run gets its answer. The item is picked
   *  back up only when the pipeline is actually waiting on one: it is a routed issue (not
   *  a pull request), a human wrote it (not Sunday), and durable state says this item
   *  gated with a session to continue.
   *
   *  Everything past those guards is the SAME claim-enqueue-fork path an admitted issue
   *  takes — a resume is an issue run, and a second way in that could drift from the
   *  first is the defect class this rewrite exists to kill. */
  private considerReply({ repo, number, comment = "", onPullRequest }: Delivery): void {
    const key = `${repo}#${number}`;
    // Constraint 14, and the resume's own need: a run works from its repo's config, so a
    // repo that left the routing table between the question and the answer has nothing to
    // run against. The state file outlives an edit to `config/repos.json`; this decides.
    const cfg = this.repos[repo];
    if (!cfg) {
      this.log.info(`· skip ${key} — ${repo} not in config/repos.json`);
      return;
    }
    // Sunday's own comment, coming straight back as a delivery. It has to be told from a
    // human's by the MARKER and never by the author, because both post under the same
    // account — and the gate question is itself a comment Sunday posts on an issue that
    // is already `awaiting-human`, so unguarded every gate answers its own question with
    // its own question, on real quota.
    if (comment.includes(SUNDAY_MARKER)) {
      this.log.info(`· ${key} — Sunday's own comment, not an answer to it`);
      return;
    }
    // A PR's conversation comment arrives as an `issue_comment` too, so the SUBJECT is
    // the only thing separating the two flows — and answering @sunday on a pull request
    // is #44's run, not a gate resume.
    if (onPullRequest) {
      this.log.info(`· ${key} — a comment on a pull request, which is #44's run and not this one`);
      return;
    }
    const prior = this.state.get(key);
    if (prior?.status !== "awaiting-human") {
      // Most comments are this: humans talking to each other. A summon among them is not
      // this issue's work either, and saying so is the difference between a decision and
      // a delivery that vanished (constraint 10).
      const summon = isSummon(comment) ? " — an @sunday summon is replayed by the next boot's reconcile (#35)" : "";
      this.log.info(`· ${key} — a comment, and nothing here is waiting on an answer${summon}`);
      return;
    }
    const session = prior.sessionId;
    if (!session) {
      // Fresh work, not a resume: the human is answering a question this pipeline can no
      // longer continue from, and starting over would spend a whole new quota deciding
      // what they already answered. Said out loud, because they are waiting on a reply
      // that is otherwise never coming.
      this.log.info(`· skip ${key} — awaiting-human with no session to resume`);
      return;
    }
    this.github.claim(repo, number);
    // The whole record is replaced, so the handle is written back deliberately
    // (constraint 12): dropped here, a run that dies mid-resume leaves a gated item with
    // nothing left to resume from.
    this.state.set(key, { status: "in-flight", sessionId: session });
    const item: WorkItemRef = { key, repo, issue: number };
    this.scheduler.enqueue({
      key,
      branch: `feat/${number}`,
      run: () => this.run(item, cfg, { sessionId: session, reply: comment }),
    });
  }

  /** One work item, from the fork to its applied outcome. Handed to the scheduler, and
   *  it settles when the CHILD exits — so the cap and the branch lock hold for the
   *  child's whole life rather than just for the fork call. */
  private async run(item: WorkItemRef, cfg: RepoConfig, resume?: Job["resume"]): Promise<void> {
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
      resume,
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
    // A file still on disk for an item ALREADY recorded terminal is a `record()` that was
    // killed part-way through (ADR-0001: at any instant), between the milestone and the
    // clear. The issue carries both of its comments already, so recording it again is a
    // third (constraint 12) — and #35's boot sweep finds exactly this file and applies it.
    // Leaving it alone is no answer either: the claim, the lock and the file are all still
    // there, so the item would stay taken forever. Finish the tail, say nothing.
    // `awaiting-human` counts as recorded alongside the other two: a gate is FINISHED
    // work, so re-recording it asks the human the same question a second time and, worse,
    // re-writes the state entry their reply is routed on.
    // Which statuses are terminal comes off OUTCOME_STATUSES rather than a list spelled
    // again here: a status the outcome grows is one this guard has to count, or the
    // interrupted apply it names is re-recorded and the issue gets its comment twice.
    // `in-flight` and an item never recorded at all are what still falls through.
    const recorded = this.state.get(item.key)?.status;
    if (OUTCOME_STATUSES.some((status) => status === recorded)) {
      this.log.info(`· ${item.key} is already ${recorded} — clearing what its interrupted apply left behind`);
      this.settle(item);
      return;
    }
    this.record(item, read.outcome.status, read.outcome.summary, read.outcome.sessionId);
  }

  /** The apply ORDER, spelled once (constraint 5): durable state, the milestone, then the
   *  tail. A crash part-way through is re-applied by the next boot rather than losing the
   *  outcome — losing one is silent, where the re-apply is caught by the guard above and
   *  costs the issue nothing.
   *
   *  `sessionId` is carried into durable state because the outcome file is cleared in the
   *  tail below: a gated item's handle would otherwise be gone before the human it is
   *  waiting on has read the question. */
  private record(item: WorkItemRef, status: Outcome["status"], summary: string, sessionId?: string): void {
    this.state.set(item.key, { status, sessionId });
    // Milestone 2 of exactly two (constraint 12). A gate is neither tick nor cross — it
    // asks the human something, and rendering it as a failure tells them work broke when
    // what actually happened is that they are being waited on.
    this.log.milestone(`${MARK[status]} ${status} — ${summary}`, {
      repo: item.repo,
      target: item.issue,
    });
    this.settle(item);
  }

  /** The tail of an apply: the result file, the lock, then the claim. Its own method
   *  because an interrupted record is finished by exactly this and nothing else — the
   *  state and the comment are already done, and only these three are outstanding.
   *  The claim is last because it is the most durable of the three: while it is on, a
   *  delivery arriving in the middle of all this reads the issue as taken. */
  private settle(item: WorkItemRef): void {
    clearOutcome(this.paths.resultPath(item.key));
    releaseLock(this.paths.pidPath(item.key));
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
