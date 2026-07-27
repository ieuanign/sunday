// assignor/types.mts — every shape the Assignor decides in, split out of `index.mts` and
// `failure.mts` per CLAUDE.md §7. Declarations only: `index.mts` re-exports them
// (`export * from "./types.mts"`), so no caller's import path changes.

import type { RepoConfig } from "#config/repos.mts";
// Type-only, so the worker stays OUT of the parent's import graph (ADR-0001): the job
// shape is a contract, and the entry point itself is only ever reached by path. Both
// lanes' workers are named exactly this way (#44 constraint 4).
import type { Job } from "#issue/run.mts";
import type { PrJob } from "#pr/run.mts";
import type { GitHub, GitHubLabels } from "#services/github/index.mts";
import type { ModuleLogger } from "#services/logger.mts";
import type { FailurePolicy } from "./failure.mts";
import type { PauseStore } from "./pause.mts";
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

/** One pull request, as PR-COMMENT ADMISSION needs to see it (#44): which repo, which
 *  pull request, and the labels on it right now — the quarantine label is what a human
 *  removes to hand a set-aside item back, and it must read the same whether the summon
 *  arrived live or was re-derived. Mirrors `IssueCandidate` and stays separate from it:
 *  the number is a PULL REQUEST's, and the two are different work items even when they
 *  are the same integer. */
export interface PrCandidate {
  repo: string;
  /** The pull request number. Untrusted until admission matches its repo, exactly as an
   *  issue's is: it becomes a work-item key and a path segment. */
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
  /** Did this pull request MERGE? Required for the same reason `onPullRequest` is, and
   *  more sharply: it is the whole of #43's trigger — GitHub sends no `merged` action,
   *  only `closed` with this flag — and a field left off would default to force-pushing
   *  every branch stacked on a PR that was closed unmerged. */
  merged: boolean;
  /** The head branch of the pull request this delivery is about, when it is one.
   *  `feat/<n>` names the ISSUE that merged, which `number` does not: that is the PR's
   *  own number, and a restack aimed at it would move somebody else's branches. */
  head?: string;
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
 *  (`fork()` on `issue/run.mts` or `pr/run.mts` BY PATH, ADR-0001) and a test supplies
 *  one that spawns nothing. Which worker runs is read off the JOB (`assignor/fork.mts`),
 *  so the Assignor decides the lane by building one shape or the other and nothing here
 *  names a file. */
export type ForkWorkItem = (job: Job | PrJob) => Promise<ChildExit>;

/** A blocker MERGED, so everything stacked on it has to move (#43). Injected as a
 *  function rather than as the `Restacker` itself, so this class never reaches the
 *  restack module: what the Assignor decides is WHICH repo and WHICH issue landed, and
 *  everything after that — the dependent scan, the rebase, the retarget, the cascade —
 *  belongs to `assignor/restack.mts`. */
export type RestackOnMerge = (repo: string, mergedIssue: number) => Promise<void>;

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
  /** Where a merged blocker goes (#43). */
  restack: RestackOnMerge;
  /** What a failed work item MEANS and what is done about it (#39). Injected rather than
   *  constructed for the same reason everything else here is — and because the policy
   *  reaches back into this object for the retry, so one of the two has to be built
   *  first. */
  failure: FailurePolicy;
}

/** Which lane a work item runs in: an issue run (`issue/run.mts`) or a comment run on a
 *  pull request (`pr/run.mts`, #44). What a work item IS decides three things nothing
 *  else can answer — which worker is forked, whether settling hands a claim back, and
 *  whether a label is written with `gh issue edit` or `gh pr edit`. */
export type WorkItemKind = "issue" | "pr";

/** One work item's IDENTITY, resolved once at admission: what a fork, an outcome and a
 *  comment all have to agree on. (`scheduler.mts`'s `WorkItem` is the other half — the
 *  same item as something to queue, dedup and hold a branch for.) */
export interface WorkItemRef {
  /** `<owner>/<repo>#<issue>`, or `<owner>/<repo>#pr<n>` for a PR-comment run — the
   *  scheduler's dedup key and the outcome's name. The two spellings are DISTINCT on
   *  purpose (#44 constraint 1): issue 12 and pull request 12 would otherwise share one
   *  state entry, one PID lock, one result file and one agent floor dir. */
  key: string;
  /** The CONFIGURED repo full name (constraint 14). */
  repo: string;
  /** The issue number — or the PULL REQUEST number when `kind` is `pr`. */
  issue: number;
  /** REQUIRED, never optional (#44 constraint 2). The dangerous default is real: an
   *  absent kind reading as `issue` makes `settle()` run `gh issue edit --remove-label
   *  agent-working` against whatever unrelated issue happens to share the PR's number. */
  kind: WorkItemKind;
}

export type Admission = { admit: true } | { admit: false; reason: string };

/** quota: the subscription's window is spent — every run would hit the same wall.
 *  auth: the credential is process-wide, so every run fails identically and instantly.
 *  setup: the sandbox could not be built or created — one repo's environment, unless the
 *    container daemon itself is down.
 *  transient: a blip (429, 5xx, network, a branch briefly checked out elsewhere).
 *  run-failed: the agent RAN and reported the failure itself.
 *  unknown: matched nothing. Not a halt any more — one work item is stopped, retried once
 *    with its own error, and quarantined if it fails again. */
export type FailureClass = "quota" | "auth" | "setup" | "transient" | "run-failed" | "unknown";

/** How far a failure reaches (CONTEXT.md): `pipeline` — every run would fail the same way;
 *  `repo` — this child repo is broken; `item` — only this work item is stuck. */
export type FailureScope = "pipeline" | "repo" | "item";

export interface Failure {
  class: FailureClass;
  scope: FailureScope;
  /** One-line headline of WHAT happened — the pause reason, and the head of the act
   *  layer's line. What Sunday is DOING about it is the act layer's to say. */
  summary: string;
  /** The failure text, tail-bounded: the capture that tightens these patterns. */
  excerpt: string;
  /** Absolute reset time (epoch ms) for a quota that named one. Absent → the pause has
   *  nothing to lift itself on and waits for a human. */
  resetAt?: number;
}

export interface ClassifyOptions {
  /** The class for text that matches nothing. `unknown` (one item, retried once, then
   *  quarantined) unless the caller knows better: boot passes `setup`, because a failure
   *  that came out of an image build is that repo's environment whatever docker said. */
  fallback?: FailureClass;
  /** The agent RAN and reported the failure itself. A typed fact off the outcome, never a
   *  pattern: the text on that path is prose SUNDAY composed around the agent's own
   *  description, so matching it would both break the day that wording changes and let
   *  anything the agent happened to write stop the pipeline. */
  agentFailed?: boolean;
}

/** Start this work item again, carrying the error the last run died on when there is one
 *  to carry. Handed to `failed()` BY THE CALLER rather than held as a dependency: the
 *  Assignor owns every (re)start of a work item and takes this policy in its constructor,
 *  so the one restart there is passed in per failure — which is also what makes a caller
 *  with nothing to restart (boot's image sweep) unable to ask for one by accident. */
export type RestartWorkItem = (retryError?: string) => void;

/** One failure, as the path that caught it has it. */
export interface FailureInput {
  /** The failure's own text — an agent seam's flattened message, a build's output tail,
   *  the parent's dead-child line. Never prose Sunday composed (constraint 3). */
  text: string;
  /** Which repo it happened in. The only context a repo-scope line carries, and the
   *  reason it is separate from `item`: boot's image build has no work item at all. */
  repo: string;
  /** The work item it happened to, when it happened to one. */
  item?: WorkItemRef;
  /** The agent RAN and reported this itself — a typed fact off the outcome. */
  agentFailed?: boolean;
  /** The class for text that matches nothing; boot passes `setup`. */
  fallback?: FailureClass;
  /** How this work item is started again, for the one retry an item-scope failure gets.
   *  Absent from a caller that has no work item to restart at all. */
  retry?: RestartWorkItem;
}

/** How a stopped repo heals, injected as a pair because neither half is any use alone:
 *  rebuild the image, and when it comes back clean re-derive that repo's outstanding work.
 *  Absent from a construction with no repo to heal (the smokes that only drive one scope).
 *
 *  Both halves are per-REPO and neither is reached for: the rebuild is `SandboxService`
 *  (docker, minutes) and the re-derive is #40's `Reconciler.repo` — the same per-repo pass
 *  the forwarder's blackout catch-up uses, so a repair and a blackout cannot drift into two
 *  ways of bringing a repo back. Constraint 13 as well: `assignor/` names neither module. */
export interface RepoRecheck {
  /** Build this repo's image again, and answer with why it is STILL broken — or nothing
   *  at all, which is the signal the repair landed. Never rejects in production; a
   *  rejection is treated as "still broken" all the same. */
  rebuild: (repo: string) => Promise<string | undefined>;
  /** Re-derive this repo's outstanding work from GitHub, once it can run again. */
  reconcile: (repo: string) => Promise<void>;
  /** Constraint 11: injected with a real default, so the suite drives the recheck with a
   *  real timer at millisecond scale instead of waiting out five minutes. */
  everyMs?: number;
}

/** Everything the policy needs and constructs none of: the durable pause it arms, the
 *  queue it stops, and the Logger it says everything through. */
export interface FailurePolicyDeps {
  pause: PauseStore;
  scheduler: Scheduler;
  /** Where the retry budget and the quarantine LIVE (constraint 7). Both are read and
   *  written here rather than kept in memory: a spent retry that died with the process
   *  hands every restart another agent run on real quota, and a quarantine that did not
   *  survive is re-admitted by the next reconcile. */
  state: StateStore;
  /** The one label write the policy makes. Best-effort, always. */
  github: GitHubLabels;
  log: ModuleLogger;
  /** Constraint 11: injected with a real default, so the suite drives the auto-resume
   *  with a real timer at millisecond scale instead of waiting out a quota window. */
  resumeGraceMs?: number;
  /** How a stopped repo heals. Without it a repo stop holds until the next restart —
   *  which is still only that repo, and is what a caller with no builder gets. */
  recheck?: RepoRecheck;
}
