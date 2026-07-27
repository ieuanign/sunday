// assignor/index.mts — the Assignor: the one thing in Sunday that DECIDES. A delivery
// arrives normalised, it is routed by event type, an issue is admitted or rejected with
// a reason, and an admitted work item is claimed, queued and forked.

import type { RepoConfig } from "#config/repos.mts";
// Type-only, so the worker stays OUT of the parent's import graph (ADR-0001): the job
// shape is a contract, and the entry point itself is only ever reached by path. Both
// lanes' workers are named exactly this way (#44 constraint 4).
import type { Job } from "#issue/run.mts";
import type { PrJob } from "#pr/run.mts";
import { readLock, releaseLock } from "#lib/lock.mts";
import { isSummon, SUNDAY_MARKER } from "#lib/markers.mts";
import { clearOutcome, OUTCOME_STATUSES, readOutcome, type Outcome } from "#lib/outcome.mts";
import { CLAIM_LABEL, QUARANTINE_LABEL, type GitHub } from "#services/github/index.mts";
import type { ModuleLogger } from "#services/logger.mts";
import { resolveBase, type BaseDecision } from "./dag.mts";
// Type-only: the policy is a shape here (it is injected, constraint 8), so `failure.mts`
// never reaches this module's runtime import graph.
import type { FailurePolicy } from "./failure.mts";
import type { Scheduler } from "./scheduler.mts";
import type { StateStore } from "./state.mts";
import type {
  Admission,
  AssignorDeps,
  ChildExit,
  Delivery,
  ForkWorkItem,
  IssueCandidate,
  Paths,
  PrCandidate,
  RestackOnMerge,
  WorkItemKind,
  WorkItemRef,
} from "./types.mts";

// The declarations moved out (CLAUDE.md §7) come back through here, so every caller
// still imports them from `#assignor/index.mts`.
export * from "./types.mts";

/** `issues` actions that should (re)consider an issue. NOT `unlabeled`/`edited`: those
 *  fire when WE add or remove the claim, and admitting on them re-runs a finished issue.
 *  Ported from v1's `listener/listen.mts`. */
const ADMIT_ACTIONS = new Set(["opened", "reopened", "labeled"]);

/** The event a gate resume arrives on, spelled once for both readings of it below: a
 *  `created` one is routed, and every other action on it is recognised-and-unbuilt. Two
 *  spellings drift into a comment that routes nowhere while the log calls it recognised. */
const COMMENT_EVENT = "issue_comment";

/** The event an INLINE comment arrives on — the Files-changed tab (#44). Always about a
 *  pull request, where `issue_comment` is about either and says which. */
const REVIEW_COMMENT_EVENT = "pull_request_review_comment";

/** Event types the pipeline knows and deliberately does not act on, so "not built yet"
 *  and "never heard of it" are different lines in the log. A created comment on either
 *  stream is routed above (a gate resume, or #44's PR run), and a `pull_request` action
 *  that could have changed a blocker's state — or merged one — is routed below (#42,
 *  #43); every other action on any of them lands here. */
const KNOWN_UNBUILT = new Set([COMMENT_EVENT, "pull_request", REVIEW_COMMENT_EVENT]);

/** The actions after which a deferred item's answer could be different: a blocker's PR
 *  appearing is what a dependent with nothing to stack on is waiting for, and one closing
 *  or merging changes what it should stack on. `closed` covers a merge — GitHub sends no
 *  `merged` action. Ported from v1's `PR_REEVAL_ACTIONS`. */
const PR_REEVAL_ACTIONS = new Set(["opened", "reopened", "closed"]);

/** A spec describes the shape of a feature; its child issues are the work (CONTEXT.md).
 *  The literal is ported from v1's `listener/helper.mts` rather than imported — v1 and
 *  V2 must not cross-import until cutover deletes v1. */
const SPEC_LABEL = "spec";

/** A head branch of Sunday's, and the issue behind it. `feat/<n>` is the only branch
 *  shape this pipeline creates, and the number in it is the ISSUE — which is what a
 *  merge is restacked on (#43). Anything else that merges is a human's own branch. */
const FEAT_BRANCH = /^feat\/(\d+)$/;

/** How each way of finishing opens the comment it is posted as. `⏸` is the same mark
 *  boot and the scheduler use for "held, awaiting a human" — a gate is that, on one work
 *  item. */
const MARK: Record<Outcome["status"], string> = { done: "✓", failed: "✗", "awaiting-human": "⏸" };

/** How often an ADOPTED child's lock is re-read. Polled and not watched, because the lock
 *  DISAPPEARING is the one signal covering both ways a survivor can end — it wrote an
 *  outcome, or it died without writing anything — and it costs one `existsSync` plus one
 *  signal-0 against a deadline measured in minutes. */
const ADOPT_POLL_MS = 250;

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
  const subject = key.slice(at + 1);
  // `#pr<n>` is the PR lane's spelling (#44 constraint 1). Read here rather than guessed
  // by the caller: this is the file that SPELLS keys, and a sweep that resolved a `#pr`
  // key as an issue would settle a work item that does not exist — releasing a claim and
  // commenting on whatever issue shares the number.
  const kind: WorkItemKind = subject.startsWith("pr") ? "pr" : "issue";
  const issue = Number(kind === "pr" ? subject.slice(2) : subject);
  // `hasOwn`, not a truthiness check: `table["__proto__"]` is an object on every table
  // there is, and reading it as a routed repo is how untrusted input gets in.
  if (!Object.hasOwn(table, repo)) return undefined;
  if (!Number.isInteger(issue) || issue <= 0) return undefined;
  const ref: WorkItemRef = { key: workItemKey(repo, issue, kind), repo, issue, kind };
  // Rebuilt and compared, so a key that only LOOKS canonical (`#0057`, `#57.0`, `#pr 4`)
  // cannot name one work item on disk and a different one in the state file.
  return ref.key === key ? ref : undefined;
}

/** How a work-item key is SPELLED, in the one file that decides it — the parse above is
 *  its inverse, and the two drifting apart is a key that names one item on disk and
 *  another in the state file. */
function workItemKey(repo: string, number: number, kind: WorkItemKind): string {
  return `${repo}#${kind === "pr" ? "pr" : ""}${number}`;
}

/** One item admitted in principle and held back until its blockers change (CONTEXT.md
 *  — "Deferred"). The candidate is kept whole so a re-evaluation re-runs the SAME
 *  admission the delivery got, and the reason is kept so a repeat of it can be said
 *  quietly (constraint 5). */
interface Deferred {
  candidate: IssueCandidate;
  reason: string;
}

/** Why a deferred item is waiting, as `assignor/dag.mts` answered it. */
type Refusal = Extract<BaseDecision, { admit: false }>;

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
  private readonly restack: RestackOnMerge;
  private readonly failure: FailurePolicy;
  /** Items waiting on a blocker, by work-item key. IN MEMORY ONLY (constraint 6):
   *  GitHub is the truth and #35's reconcile hands every open issue back to admission,
   *  so a restart rebuilds this map from the world rather than from a file that could
   *  disagree with it. */
  private readonly deferred = new Map<string, Deferred>();

  constructor(deps: AssignorDeps) {
    this.repos = deps.repos;
    this.github = deps.github;
    this.log = deps.log;
    this.scheduler = deps.scheduler;
    this.state = deps.state;
    this.fork = deps.fork;
    this.paths = deps.paths;
    this.restack = deps.restack;
    this.failure = deps.failure;
  }

  /** Route one delivery. EVERY one leaves a line behind, including the event types this
   *  issue does not handle (constraint 10): a work item dropped in silence is the defect
   *  class this rewrite exists to kill. */
  handle(delivery: Delivery): void {
    const { event, action, repo, number, labels } = delivery;
    const what = `${event}${action ? `.${action}` : ""}`;
    this.log.info(`← ${what} ${repo}#${number}${labels.length > 0 ? ` [${labels.join(", ")}]` : ""}`);
    if (event === "issues" && ADMIT_ACTIONS.has(action)) {
      // Fired, not awaited, and with its OWN catch: this method stays `void` because the
      // receiver calls it synchronously inside a try/catch that cannot see a rejection —
      // an admission that throws would be an unhandled one and take the parent down
      // (ADR-0001). Admission reaches GitHub now (#42), so it really can reject.
      void this.considerIssue(delivery).catch((err: unknown) =>
        this.log.error(`✗ ${repo}#${number} not considered — ${describe(err)}`, { repo }),
      );
      return;
    }
    // A comment on a PULL REQUEST is #44's run, whichever stream it came in on: the
    // conversation arrives as an `issue_comment` whose subject carries a `pull_request`,
    // and an inline one on a file line arrives as its own event. An `issue_comment` on an
    // actual issue is the other thing entirely — a human answering a gate.
    if ((event === COMMENT_EVENT || event === REVIEW_COMMENT_EVENT) && action === "created") {
      if (delivery.onPullRequest) this.considerSummon(delivery);
      else this.considerReply(delivery);
      return;
    }
    // A blocker's PR appeared or its issue closed, so what an item deferred on may have
    // changed (#42). Fired with its own catch for the same reason admission is.
    if ((event === "pull_request" && PR_REEVAL_ACTIONS.has(action)) || (event === "issues" && action === "closed")) {
      // …and if it MERGED, every branch stacked on it is now stacked on a base that is
      // gone (#43). A merge is both things at once: an item deferred on it can start, and
      // an item already stacked on it has to move.
      if (event === "pull_request" && action === "closed" && delivery.merged) this.seedRestack(delivery);
      void this.reevaluate(repo).catch((err: unknown) =>
        this.log.error(`✗ ${repo} deferred items not re-evaluated — ${describe(err)}`, { repo }),
      );
      return;
    }
    this.log.info(
      KNOWN_UNBUILT.has(event)
        ? `· ${what} — recognised, and no action of this pipeline's`
        : `· ${what} — no route`,
    );
  }

  /** A merged pull request, as something to RESTACK (#43). The merged issue comes off the
   *  HEAD BRANCH and never off `delivery.number`: that is the pull request's own number,
   *  and a restack keyed on it would go hunting for branches stacked on an issue nobody
   *  merged. A head that is not one of ours names no issue at all, so nothing this
   *  pipeline created can be stacked on it. */
  private seedRestack({ repo, head = "" }: Delivery): void {
    const ours = FEAT_BRANCH.exec(head);
    if (!ours) {
      this.log.info(`· ${repo} merged ${head || "an unnamed branch"} — not one of Sunday's, so nothing is stacked on it`);
      return;
    }
    const merged = Number(ours[1]);
    // Fired, not awaited, and with its OWN catch — exactly as the two above are, and for
    // the same reason: `handle` is called synchronously inside the receiver's try/catch,
    // which cannot see a rejection, so an escaped one would take the parent down
    // (ADR-0001). What the restack does about its own failures is its funnel's business
    // (#43); this catches only what got past it.
    void this.restack(repo, merged).catch((err: unknown) =>
      this.log.error(`✗ ${repo}#${merged} merged, and what is stacked on it was not restacked — ${describe(err)}`, { repo }),
    );
  }

  /** Admit an issue, or say why not. Five guards, cheapest and most durable first: is it
   *  Sunday's work at all, is the number one, is the item already somewhere in its life,
   *  is a process still on it — and only then, does anything still BLOCK it (#42). That
   *  last one is the only question this method asks the network, which is why it goes
   *  last (constraint 4): ahead of the others, every unlabelled issue in a 200-issue
   *  reconcile pass would pay for a `gh` round-trip to be told it was never Sunday's
   *  work. It is also the one that can answer "not yet" rather than "no" — a deferred
   *  item is held in memory and re-asked when a blocker's state could have changed.
   *
   *  PUBLIC because it is the admission SEAM (constraint 3): #35's reconcile re-derives
   *  open issues from GitHub and hands each one straight to this, rather than carrying a
   *  second copy of these four guards that drifts from this one — which is exactly how
   *  v1's live and recovery paths came apart. It takes an `IssueCandidate` and not a
   *  `Delivery` for the same reason: reconcile has no webhook event to name, and a
   *  synthetic one would put an event in the log that never happened. */
  async considerIssue({ repo, number, labels }: IssueCandidate): Promise<void> {
    const decision = admitIssue(repo, labels, this.repos);
    if (!decision.admit) {
      this.log.info(`· skip ${repo}#${number} — ${decision.reason}`);
      return;
    }
    // The repo's environment is broken, so an agent started here would die on the same
    // create failure this repo was stopped for — on a busy repo, once per item, until
    // somebody notices (#39). In memory and ahead of the network read for the same reason
    // every guard above it is: a whole backlog re-derived into a stopped repo must not pay
    // a `gh` round-trip each to be told nothing can run yet. The policy's recheck clears
    // this by itself and re-derives the repo, so nothing here has to be remembered.
    if (this.failure.isStopped(repo)) {
      this.log.info(`· skip ${repo}#${number} — ${repo} is stopped until its sandbox image builds again`);
      return;
    }
    // Constraint 14: a work-item key and the path segments built from it come from the
    // CONFIGURED repo name (admission is the exact match that proved it) and a number
    // that IS one — never from a raw payload string.
    if (!Number.isInteger(number) || number <= 0) {
      this.log.info(`· skip ${repo} — ${JSON.stringify(number)} is not an issue number`);
      return;
    }
    const item: WorkItemRef = { key: workItemKey(repo, number, "issue"), repo, issue: number, kind: "issue" };
    const prior = this.state.get(item.key);
    // A quarantined item is the one state a DELIVERY can lift (#39): it failed twice, and
    // a human takes the `quarantined` label off to hand it back. The label's absence IS the
    // release signal — `labeled` and reconcile are the only two ways a label change reaches
    // admission, and both hand over the issue's CURRENT labels, so this one guard serves
    // the live path and the re-derive alike. Everything below then runs as it does for any
    // other admission, which is what gives the released item its retry budget back.
    if (prior?.status === "quarantined" && labels.includes(QUARANTINE_LABEL)) {
      this.log.info(`· skip ${item.key} — state=quarantined (remove the \`${QUARANTINE_LABEL}\` label to hand it back)`);
      return;
    }
    // A `failed` item is retried when a human re-labels it; anything else is already
    // somewhere in its life and must not be started again.
    if (prior && prior.status !== "failed" && prior.status !== "quarantined") {
      this.log.info(`· skip ${item.key} — state=${prior.status}`);
      return;
    }
    // The guard the in-memory queue cannot be: children deliberately outlive the parent
    // (hot-reload, crash, deploy — ADR-0001), so a live lock means someone IS on this
    // item whatever this process remembers.
    const pid = this.liveChild(item.key);
    if (pid !== undefined) {
      this.log.info(`· skip ${item.key} — pid ${pid} is still on it`);
      return;
    }
    const base = await resolveBase(this.github, item.repo, item.issue);
    if (!base.admit) {
      this.defer(item, labels, base);
      return;
    }
    this.deferred.delete(item.key);
    // Claim BEFORE the queue: the claim is what the NEXT delivery reads, and it may
    // arrive long before this item reaches the front of a full lane.
    this.github.claim(item.repo, item.issue);
    this.state.set(item.key, { status: "in-flight", base: base.base });
    const cfg = this.repos[item.repo]; // admission passed, so the repo is routed
    this.scheduler.enqueue({ key: item.key, branch: `feat/${item.issue}`, run: () => this.run(item, cfg, base.base) });
  }

  /** Re-run admission for everything this repo is holding back, because a blocker's PR
   *  just appeared or its issue closed. FORWARD edge, like v1's `reevaluateDeferred`:
   *  GitHub's `dependencies/blocks` endpoint 404s, so nobody can ask "what does this
   *  unblock?" — each deferred item re-asks its own blockers instead.
   *
   *  SERIALLY, and per repo: a repo with a queue of deferred items would otherwise fire a
   *  burst of `gh` reads at once on every PR event in it. Nothing here starts a run
   *  directly — `considerIssue` re-applies every guard, on the labels captured when the
   *  item was deferred (a trigger removed while it waited is #38's precondition, not
   *  this).
   *
   *  Start-up needs none of this: #35's reconcile hands every open issue to the same
   *  admission seam, so the map rebuilds itself from GitHub on every boot. */
  private async reevaluate(repo: string): Promise<void> {
    for (const [key, held] of [...this.deferred]) {
      if (held.candidate.repo !== repo) continue;
      // Somewhere in its life already — in-flight, done, or waiting on a human. Whatever
      // it is, it is no longer waiting on a blocker, so it stops being tracked as such.
      const prior = this.state.get(key);
      if (prior && prior.status !== "failed") {
        this.deferred.delete(key);
        continue;
      }
      await this.considerIssue(held.candidate);
    }
  }

  /** Hold an item back, and remember it so a blocker's state changing can pick it up
   *  again. Nothing else happens: not claimed, not queued, nothing durable written
   *  (constraint 6) — a deferred issue is exactly as available as it was before.
   *
   *  How LOUD it is said is the whole of constraint 5. A blocker that has not landed is
   *  the mechanism working, so it is `info`. A read Sunday could not perform is somebody
   *  else's service being down and only an operator can act on it — but it carries the
   *  repo and NO target, so it reaches the phone and never the issue: a work item gets
   *  exactly two comments and a deferred one has not started. The same reason repeating
   *  drops back to `info`, so a re-evaluation storm across one repo's PR events cannot
   *  page anybody once per event for a single outage. */
  private defer(item: WorkItemRef, labels: string[], refusal: Refusal): void {
    const held = this.deferred.get(item.key);
    // Built from the VALIDATED item rather than kept from the payload (constraint 14):
    // this candidate is what a re-evaluation minutes later admits on.
    this.deferred.set(item.key, { candidate: { repo: item.repo, number: item.issue, labels }, reason: refusal.reason });
    const line = `⏸ defer ${item.key} — ${refusal.reason}`;
    if (refusal.unreadable && held?.reason !== refusal.reason) this.log.error(line, { repo: item.repo });
    else this.log.info(line);
  }

  /** A comment on an ISSUE, which is how a gated run gets its answer — `handle` routes on
   *  the subject, so a comment on a pull request reaches the PR lane and never here. The
   *  item is picked back up only when the pipeline is actually waiting on one: the repo is
   *  routed, a human wrote it (not Sunday), and durable state says this item gated with a
   *  session to continue.
   *
   *  Everything past those guards is the SAME claim-enqueue-fork path an admitted issue
   *  takes — a resume is an issue run, and a second way in that could drift from the
   *  first is the defect class this rewrite exists to kill. */
  private considerReply({ repo, number, comment = "" }: Delivery): void {
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
    // What the item was admitted on. A resume decides no base of its own: the branch is
    // already there and the blockers are re-read for FRESH work only — what this run
    // still does is open the PR the gate never opened, and that targets where the work
    // was stacked (#42 constraint 8). Absent for an item admitted before this existed.
    const base = prior.base ?? "main";
    this.github.claim(repo, number);
    // The whole record is replaced, so the handle, the base and the fork point are all
    // written back deliberately (constraint 12): dropped here, a run that dies mid-resume
    // leaves a gated item with nothing left to resume from, no base to resume onto, and
    // no commit for #43 to restack its branch off.
    this.state.set(key, { status: "in-flight", sessionId: session, base, forkPoint: prior.forkPoint });
    const item: WorkItemRef = { key, repo, issue: number, kind: "issue" };
    this.scheduler.enqueue({
      key,
      branch: `feat/${number}`,
      run: () => this.run(item, cfg, base, { sessionId: session, reply: comment }),
    });
  }

  /** A comment on a PULL REQUEST, live (#44). One guard, and it is the whole trigger:
   *  did a HUMAN summon Sunday? `isSummon` reads the marker first, so Sunday's own
   *  comments — the two milestones a work item posts, and every reply a run leaves —
   *  cannot summon it to answer itself, forever, each round a real agent run on real
   *  quota (constraint 13).
   *
   *  Everything past it is `considerPrComment`, which the reconcile sweep reaches with
   *  the same candidate: this method's whole job is to turn a delivery into one and to
   *  decide that a comment IS a summon, which is a question a re-derive has already
   *  answered against the reply watermark. */
  private considerSummon({ repo, number, labels, comment = "" }: Delivery): void {
    if (!isSummon(comment)) {
      this.log.info(`· ${repo}#${number} — a comment on a pull request, and not a summon`);
      return;
    }
    // Fired, not awaited, and with its OWN catch, exactly as `considerIssue` is: `handle`
    // is called synchronously inside the receiver's try/catch, which cannot see a
    // rejection — and this reads the pull request, so it really can reject (ADR-0001).
    void this.considerPrComment({ repo, number, labels }).catch((err: unknown) =>
      this.log.error(`✗ ${repo}#pr${number} not considered — ${describe(err)}`, { repo }),
    );
  }

  /** Admit a PR-comment run, or say why not (#44). The ADMISSION SEAM for the PR lane,
   *  public for the same reason `considerIssue` is (constraint 6): the reconcile sweep
   *  re-derives pull requests whose summons are unanswered and hands each one straight to
   *  this, rather than carrying a second copy of these guards that drifts from it.
   *
   *  Three differences from an issue's admission, each deliberate:
   *
   *  · NO CLAIM (constraint 3). `agent-working` is an issue label, and reconcile's
   *    orphan-claim sweep walks issues only — one left on a pull request is a state
   *    nothing releases. Mutual exclusion is the durable state, the PID lock and the
   *    scheduler's key dedup, which are the same three guards an issue run has.
   *  · A FINISHED item is admissible again. A trigger label sits on an issue until a human
   *    removes it, so re-admitting a `done` issue re-runs work that is over; a summon is a
   *    fresh request every time it is written, and refusing one because this PR has been
   *    answered before is a human's question dropped in silence.
   *  · The branch lock is the PR's HEAD, read here. It is the only way a comment run and
   *    an issue run cannot end up in one child checkout on one branch at once — and it is
   *    kept in durable state, because a retry and an adoption both need it later. */
  async considerPrComment({ repo, number, labels }: PrCandidate): Promise<void> {
    const cfg = this.repos[repo];
    // Constraint 14, first and cheapest: the key and the paths built from it come from the
    // CONFIGURED repo name, and the run needs that repo's config to have anything to run.
    if (!cfg) {
      this.log.info(`· skip ${repo}#pr${number} — ${repo} not in config/repos.json`);
      return;
    }
    // The repo's image will not build, so this run would fork and die on the same create
    // failure every other item in it just died on (#39). In memory and ahead of the
    // network read, exactly as `considerIssue` has it.
    if (this.failure.isStopped(repo)) {
      this.log.info(`· skip ${repo}#pr${number} — ${repo} is stopped until its sandbox image builds again`);
      return;
    }
    if (!Number.isInteger(number) || number <= 0) {
      this.log.info(`· skip ${repo} — ${JSON.stringify(number)} is not a pull request number`);
      return;
    }
    const item: WorkItemRef = { key: workItemKey(repo, number, "pr"), repo, issue: number, kind: "pr" };
    const prior = this.state.get(item.key);
    // Set aside after failing twice, and the LABEL is what hands it back (#39) — the same
    // release signal an issue item has, read off the labels both the live delivery and the
    // re-derive carry.
    if (prior?.status === "quarantined" && labels.includes(QUARANTINE_LABEL)) {
      this.log.info(`· skip ${item.key} — state=quarantined (remove the \`${QUARANTINE_LABEL}\` label to hand it back)`);
      return;
    }
    // The only state that refuses a summon: somebody is already on this pull request, and
    // whatever landed while they work is picked up by the run that is going (it gathers
    // what is unanswered at the moment it starts) or by the next reconcile pass. Every
    // other state — done, failed, released from quarantine — is admissible, because a
    // summon is a new request rather than a label left on from last time.
    if (prior?.status === "in-flight") {
      this.log.info(`· skip ${item.key} — state=in-flight`);
      return;
    }
    // The guard the in-memory queue cannot be: children outlive the parent by design
    // (ADR-0001), so a live lock means someone IS on this item whatever this process
    // remembers — including across the restart that emptied the queue.
    const pid = this.liveChild(item.key);
    if (pid !== undefined) {
      this.log.info(`· skip ${item.key} — pid ${pid} is still on it`);
      return;
    }
    // The one read admission makes here, and the reason it is made in the PARENT: the
    // scheduler's branch lock is two-way across both lanes, so the comment run and an
    // issue run (or a restack) on `feat/<n>` take turns instead of meeting in one checkout.
    const { head } = await this.github.readPr(repo, number);
    // Written BEFORE the enqueue and carrying the head, for the reason every other durable
    // write here is: a retry and an adopted survivor both need the branch to lock, and
    // neither can ask GitHub for it again (one runs off a failure path, the other off a
    // key found on disk).
    this.state.set(item.key, { status: "in-flight", head });
    this.scheduler.enqueue({ key: item.key, branch: head, run: () => this.runPr(item, cfg) });
  }

  /** Start a work item AGAIN, after a failure the policy decided is worth one more run
   *  (#39). Shaped like `considerReply`'s tail and for the same reasons: claim, write
   *  `in-flight` carrying what the item already knows, enqueue. Nothing is re-derived —
   *  a retry re-runs on the base the item was ADMITTED on, because re-asking GitHub on a
   *  failure path buys an answer #38's before-work precondition re-asserts anyway.
   *
   *  The claim and the durable write happen NOW and the enqueue on the next turn. The
   *  policy is reached from inside the run being applied, and the scheduler still counts
   *  that key as in-flight until this run's promise settles — an enqueue here would be
   *  deduped away as "already queued", and the retry would silently never happen. Claiming
   *  synchronously is what closes the window the deferral opens: `settle` has just handed
   *  the claim back, and a delivery landing in between would otherwise start a second run
   *  on the same item. */
  private restart(item: WorkItemRef, retryError?: string): void {
    const cfg = this.repos[item.repo];
    // The table can lose a repo between the run and its failure (a human edits
    // `config/repos.json`); a retry with no config has nothing to run against.
    if (!cfg) {
      this.log.info(`· skip ${item.key} — ${item.repo} not in config/repos.json`);
      return;
    }
    const prior = this.state.get(item.key);
    const base = prior?.base ?? "main";
    // …and never for a PR-comment run, which took none (constraint 3).
    if (item.kind === "issue") this.github.claim(item.repo, item.issue);
    // The whole record is replaced (constraint 12), so the fork point, the head branch and
    // the SPENT RETRY are written back deliberately: without the retry the ladder never
    // reaches the quarantine and this item retries for as long as anything keeps failing
    // it, and without the head a retried comment run has no branch left to lock. No
    // session: a retry is a fresh run with the error in its prompt, not a resume.
    this.state.set(item.key, {
      status: "in-flight",
      // What the item was ADMITTED on, carried rather than the `main` fallback the run
      // below uses: an item that never recorded a base has none, and a PR-comment run
      // stacks on nothing at all — a `main` written here reads as a decision nobody took.
      base: prior?.base,
      forkPoint: prior?.forkPoint,
      head: prior?.head,
      retried: prior?.retried,
    });
    const branch = this.branch(item);
    setTimeout(
      () =>
        this.scheduler.enqueue({
          key: item.key,
          branch,
          run: () => (item.kind === "pr" ? this.runPr(item, cfg, retryError) : this.run(item, cfg, base, undefined, retryError)),
        }),
      0,
    );
  }

  /** The branch a work item HOLDS while it runs — the scheduler's two-way lock, so no two
   *  runs are ever in one child checkout on one branch. An issue run creates `feat/<n>`;
   *  a comment run works the pull request's own head, which admission read once and left
   *  in durable state. The fallback is the item's key: unique to this item, so a PR whose
   *  head is somehow unrecorded still cannot start twice — it just holds a branch nothing
   *  else names. */
  private branch(item: WorkItemRef): string {
    if (item.kind === "issue") return `feat/${item.issue}`;
    return this.state.get(item.key)?.head ?? item.key;
  }

  /** One work item, from the fork to its applied outcome. Handed to the scheduler, and
   *  it settles when the CHILD exits — so the cap and the branch lock hold for the
   *  child's whole life rather than just for the fork call. */
  private async run(
    item: WorkItemRef,
    cfg: RepoConfig,
    base: string,
    resume?: Job["resume"],
    retryError?: string,
  ): Promise<void> {
    const job: Job = {
      key: item.key,
      repo: item.repo,
      issue: item.issue,
      config: cfg,
      base,
      // Every path the child writes is resolved HERE (constraint 7). The child derives
      // none, which is what lets a smoke fork the real entry point into a temp dir.
      resultPath: this.paths.resultPath(item.key),
      pidPath: this.paths.pidPath(item.key),
      runLogPath: this.paths.runLogPath(item.repo, String(item.issue)),
      eventLogPath: this.paths.eventLogPath,
      resume,
      retryError,
    };
    // Milestone 1 of exactly two (constraint 12) — every one posts a comment on the
    // issue, so a third is thread spam.
    this.log.milestone("▶ work started", { repo: item.repo, target: item.issue });
    // The IPC report the child sends on the way out is deliberately not waited for: it
    // says an outcome is READY, and the file it points at is what gets applied.
    this.applyOutcome(item, await this.fork(job));
  }

  /** One PR-COMMENT run, the same way (#44): fork, and settle when the child exits. Its
   *  own method rather than a branch inside `run` because the job is a different shape —
   *  there is no base to stack on and no session to resume, and the run log goes under
   *  `pr-<n>` so a comment run and an issue run on the same number do not interleave in
   *  one file. The child is reached only through `fork`, which picks the worker off THIS
   *  shape (constraint 4). */
  private async runPr(item: WorkItemRef, cfg: RepoConfig, retryError?: string): Promise<void> {
    const job: PrJob = {
      key: item.key,
      repo: item.repo,
      pr: item.issue,
      config: cfg,
      // Every path the child writes is resolved HERE (constraint 7), off the PR's own key.
      resultPath: this.paths.resultPath(item.key),
      pidPath: this.paths.pidPath(item.key),
      runLogPath: this.paths.runLogPath(item.repo, `pr-${item.issue}`),
      eventLogPath: this.paths.eventLogPath,
      retryError,
    };
    // The same two milestones every work item posts, on the pull request's own thread —
    // `gh issue comment` addresses a PR as well as an issue. They carry the ordinary
    // Sunday marker and NOT the reply marker, so neither is ever mistaken for an answer to
    // a summon (#44 constraint 7).
    this.log.milestone("▶ work started", { repo: item.repo, target: item.issue });
    this.applyOutcome(item, await this.fork(job));
  }

  /** The pid of the process still working this item, or `undefined` when nobody is. The
   *  Assignor owns the PID lock — #35's boot sweep and reconcile ASK, and neither reads
   *  `var/running/` for itself, so the one guard that stops two agents running the same
   *  issue has exactly one reading of it. */
  liveChild(key: string): number | undefined {
    const lock = readLock(this.paths.pidPath(key));
    return lock?.alive ? lock.pid : undefined;
  }

  /** Take over a child THIS parent never forked — one that outlived the parent that did
   *  (a hot-reload save, a crash, a deploy — ADR-0001). #35's boot sweep found it holding
   *  a live lock and could only leave it alone, which strands the item until some LATER
   *  boot happens to find it finished; adopting it means the outcome is applied by the
   *  parent that is up.
   *
   *  It goes on the scheduler under the item's own key and branch, so every property this
   *  needs falls out of seams that already exist rather than a second mechanism: the cap
   *  counts the survivor (a restart with N of them cannot run `cap + N` agents against one
   *  quota), its branch stays held for the rest of its life, and its key dedups anything
   *  else routed to the same item. */
  adopt(item: WorkItemRef): void {
    this.scheduler.enqueue({
      key: item.key,
      branch: this.branch(item),
      run: async () => {
        // No timeout, by design: an adopted child that hangs holds its slot exactly as a
        // locally forked one does, and there is nothing to apply until it lets go. It is
        // also the whole guard against constraint 6 — while the lock is there, the claim,
        // the result file, the lock and the state entry are all left alone.
        while (this.liveChild(item.key) !== undefined) await new Promise((tick) => setTimeout(tick, ADOPT_POLL_MS));
        // No `ChildExit` to hand over: this parent never watched the child start, so how
        // it ended is knowable only from what it left on disk — and a survivor that left
        // nothing is recorded failed by that same path.
        this.applyOutcome(item);
      },
    });
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
      this.record(item, { status: "failed", summary: `unreadable outcome — ${read.detail}` });
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
      this.record(item, { status: "failed", summary: describeChildFailure(exit) });
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
    // The outcome ITSELF, not four fields off it: what the child reported is what the
    // parent records, and a field the child grows must not need a fifth argument here.
    this.record(item, read.outcome);
  }

  /** The apply ORDER, spelled once (constraint 5): durable state, the milestone, then the
   *  tail. A crash part-way through is re-applied by the next boot rather than losing the
   *  outcome — losing one is silent, where the re-apply is caught by the guard above and
   *  costs the issue nothing.
   *
   *  `sessionId` is carried into durable state because the outcome file is cleared in the
   *  tail below: a gated item's handle would otherwise be gone before the human it is
   *  waiting on has read the question. */
  private record(item: WorkItemRef, outcome: Omit<Outcome, "key" | "finishedAt">): void {
    const prior = this.state.get(item.key);
    // The base is carried forward rather than re-derived: the whole record is replaced,
    // and a gated item that loses it resumes onto `main` — which would open a stacked
    // item's PR against the wrong branch, carrying its blocker's commits as its own.
    // The fork point is carried the same way, and falls back one step further: a resumed
    // run creates no branch, so it reports none — and a resumed child that DIES reports
    // nothing at all. Either would otherwise erase the commit #43 restacks against.
    this.state.set(item.key, {
      status: outcome.status,
      sessionId: outcome.sessionId,
      base: prior?.base,
      forkPoint: outcome.forkPoint ?? prior?.forkPoint,
      // Carried for the same reason the base is: the whole record is replaced, and a PR
      // item that loses its head has no branch for the retry (or the next boot's
      // adoption) to hold the lock on.
      head: prior?.head,
      // Carried the same way, and for the sharpest version of the same reason (#39
      // constraint 8): this is the record the retry ladder reads. Dropped here, every
      // failure looks like the item's first, and an item that cannot be run successfully
      // retries on real quota for as long as anything keeps re-admitting it.
      retried: prior?.retried,
    });
    // Milestone 2 of exactly two (constraint 12). A gate is neither tick nor cross — it
    // asks the human something, and rendering it as a failure tells them work broke when
    // what actually happened is that they are being waited on.
    this.log.milestone(`${MARK[outcome.status]} ${outcome.status} — ${outcome.summary}`, {
      repo: item.repo,
      target: item.issue,
    });
    this.settle(item);
    // Every failed work item, live or swept up by the next boot, reaches the policy HERE
    // and nowhere else (#39 constraint 1): this is the one sink both paths already share,
    // so there is no second reading of what a failure means that could drift from this
    // one. AFTER `settle`, deliberately — settle hands the claim back, and the retry the
    // policy may start takes it again.
    // The text handed over is the child's own summary (a provider's message, a tool's
    // error, the parent's dead-child line) and NEVER prose Sunday composed: "the agent ran
    // and reported this itself" travels as the typed flag beside it (constraint 3).
    if (outcome.status !== "failed") return;
    // A run that refused to START (#38) is not a failure to classify. It reports WHICH
    // assertion stopped it as a typed field, exactly as `agentFailed` is typed, because the
    // summary beside it is prose Sunday composed: `classify()` matches none of it, falls
    // through to `unknown`, and an issue whose trigger label a human simply pulled is run
    // again on real quota and then quarantined (#39 constraint 3). So a precondition
    // bypasses the policy entirely — the condition is a fact about the ISSUE, and nothing
    // about it changes by spending another agent on it.
    if (outcome.precondition) {
      // …with exactly ONE exception (constraint 6): a missing image is not this item's
      // condition, it is the repo's ENVIRONMENT — every item in it would fork and die the
      // same way, one at a time. Handed over as `setup` (the class, never a wording the
      // regex happens to match), which is the repo stop plus timed rebuild plus per-repo
      // reconcile the policy already has (ADR-0002). No retry: what would fix this run is
      // the image coming back, and the policy's own recheck is what re-derives the repo
      // once it does.
      if (outcome.precondition === "image-missing") {
        this.failure.failed({ text: outcome.summary, repo: item.repo, item, fallback: "setup" });
      }
      return;
    }
    this.failure.failed({
      text: outcome.summary,
      repo: item.repo,
      item,
      agentFailed: outcome.agentFailed,
      // The one way a work item is started again after a failure (constraint 10). Handed
      // over rather than reached for: the policy decides WHETHER there is another run in
      // this item, and every (re)start still goes through a claim.
      retry: (retryError) => this.restart(item, retryError),
    });
  }

  /** The tail of an apply: the result file, the lock, then the claim. Its own method
   *  because an interrupted record is finished by exactly this and nothing else — the
   *  state and the comment are already done, and only these three are outstanding.
   *  The claim is last because it is the most durable of the three: while it is on, a
   *  delivery arriving in the middle of all this reads the issue as taken. */
  private settle(item: WorkItemRef): void {
    clearOutcome(this.paths.resultPath(item.key));
    releaseLock(this.paths.pidPath(item.key));
    // …and the claim only where one was ever taken (#44 constraint 3). A PR-comment run
    // takes none, and `gh issue edit --remove-label agent-working` against the PR's number
    // strips the claim off an UNRELATED issue that happens to share it — mid-run, which
    // re-admits it to a second agent on real quota. This is what `kind` exists for.
    if (item.kind === "issue") this.github.release(item.repo, item.issue);
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** How a child failed its work item, for the human reading the comment. A signal is not
 *  an exit code and a child that never started is neither: "code null" says nothing
 *  about a SIGKILL and less about a fork that never got a process at all. */
function describeChildFailure(exit?: ChildExit): string {
  if (!exit) return "no outcome, and no exit recorded";
  if (exit.error) return `child never started — ${exit.error}`;
  return `child exited ${exit.signal ? `on ${exit.signal}` : `with code ${exit.code}`} leaving no outcome`;
}
