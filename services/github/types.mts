// services/github/types.mts — every shape the GitHub service speaks in, split out of
// `index.mts` and `forwarder.mts` per CLAUDE.md §7. Declarations only: `index.mts`
// re-exports them (`export * from "./types.mts"`), so no caller's import path changes.

import type { ChildProcess } from "node:child_process";

import type { ModuleLogger } from "#services/logger.mts";

/** What the Assignor is allowed to do to GitHub. Narrow deliberately: it is the seam a
 *  test substitutes, and every write on it is a real edit to a real repo. The reads
 *  answer ONE question — what blocks this issue, and can it be stacked on — which is
 *  the only thing admission asks the network (#42). */
export interface GitHub {
  /** Take the issue. A claim applied without a run starting strands the issue until
   *  #35's orphan sweep, so it is taken as late as it can be and released as early. */
  claim(repo: string, issue: number): void;
  /** Give it back. NEVER while a child may still be alive — a released claim readmits
   *  the issue, and a second agent on it is a duplicate run and real quota. */
  release(repo: string, issue: number): void;
  /** Every issue that blocks this one, each with its state inline — GitHub's native
   *  dependency links, in one call.
   *
   *  THROWS when the read fails, and that is the contract: admission cannot tell a
   *  502 from an answer, so it defers rather than guesses. v1 swallowed the failure
   *  into an empty list (`listener/dag.mts:45`), which reads as "nothing blocks this"
   *  and admitted a blocked issue onto `main` — a silent wrong answer that starts a
   *  real agent run. An EMPTY result is a different answer entirely: this repo has no
   *  native links, and the body fallback still gets its turn. */
  blockedBy(repo: string, issue: number): Promise<Blocker[]>;
  /** One issue's state, lowercased. The body fallback resolves each ref it finds
   *  through this — the native read already carries state inline. */
  issueState(repo: string, issue: number): Promise<string>;
  /** The issue as text, for the `## Blocked by` fallback when a repo has no native
   *  links. Redeclared rather than inherited from `GitHubRun`, the way `addLabels`
   *  is: a run reads an issue to title its PR and admission reads one to find its
   *  blockers, and `Gh` still implements it exactly once. */
  readIssue(repo: string, issue: number): Promise<IssueDetail>;
  /** The open PR for this head, if there already is one. Stacking's gate: a blocker
   *  with no PR open has no branch worth forking from yet. Redeclared for the same
   *  reason `readIssue` is. */
  openPrForHead(repo: string, head: string): Promise<string | undefined>;
  /** The labels this issue wears RIGHT NOW — what a release tells the two parked states
   *  apart on, and the list it re-admits with (#66). Its own method rather than widening
   *  `readIssue` to `RunIssueDetail`: that would rewrite every per-case `readIssue`
   *  override in the smokes, where `Gh` answers this off the read it already makes. */
  issueLabels(repo: string, issue: number): Promise<string[]>;
  /** Take labels off — the parked label a release lifts (#66). Redeclared from `GitHubRun`
   *  the way `readIssue` is: a resuming run drops `awaiting-human` and a release drops
   *  `quarantined`/`agent-failed`, and `Gh` still implements it exactly once. */
  removeLabels(repo: string, issue: number, labels: string[]): Promise<void>;
  /** The pull request a summon landed on (#44) — read for its HEAD BRANCH, which is
   *  what admission holds the scheduler's branch lock on. Nothing else can answer it:
   *  a PR's conversation comment arrives as an `issue_comment` carrying no branch at
   *  all, and a comment run that pushed to a branch an issue run is also on is two
   *  processes in one checkout. Redeclared for the same reason `readIssue` is —
   *  `GitHubPrRun` names it too, and `Gh` implements it exactly once. */
  readPr(repo: string, pr: number): Promise<PrDetail>;
}

/** One open issue, as re-deriving work needs to see it — the number a work item is keyed
 *  off and the labels admission decides on. Deliberately the same shape the receiver
 *  normalises a webhook delivery into, so the recovery path hands admission exactly what
 *  the live path does and the two cannot drift on their input. */
export interface OpenIssue {
  number: number;
  labels: string[];
}

/** One comment on an issue. `id` is GitHub's own and monotonic, which is what makes
 *  "answered" decidable without any state of ours: a summon older than our newest reply
 *  has already been dealt with, on this boot and on every boot after it. */
export interface IssueComment {
  id: number;
  body: string;
}

/** One issue that blocks another. */
export interface Blocker {
  number: number;
  /** Lowercased issue state ("open" | "closed"). Normalised HERE because the two
   *  reads it can come from disagree on casing — the REST dependencies endpoint says
   *  `open`, `gh issue view --json state` says `OPEN` — and a caller comparing
   *  against the wrong one silently sees every blocker as unclosed. */
  state: string;
}

/** What re-deriving outstanding work from GitHub is allowed to do: read what is open,
 *  read one thread, and replay the labels a missed summon should have applied — plus the
 *  claim writes above, because an orphaned claim is released here. Separate from
 *  `GitHub` so the Assignor's seam stays exactly the two writes it takes, and so a test
 *  substituting one is never made to stub the other.
 *
 *  Every method is async: these run in a loop over every routed repo on the parent's own
 *  event loop, and v1's synchronous version of this sweep starved the readiness probe
 *  until the supervisor killed the process (ADR-0001). */
export interface GitHubReconcile extends GitHub {
  /** Every open issue in a routed repo, capped (`OPEN_ISSUE_LIMIT`) so boot's duration is
   *  never a function of somebody else's backlog. */
  listOpenIssues(repo: string): Promise<OpenIssue[]>;
  /** One issue's conversation, oldest first. */
  issueComments(repo: string, issue: number): Promise<IssueComment[]>;
  /** Apply labels to an issue — the missed summon, replayed as the label the human would
   *  have had to add. Admission then reaches it through its ordinary path. */
  addLabels(repo: string, issue: number, labels: string[]): Promise<void>;
  /** Every open pull request in a routed repo, capped (`OPEN_PR_LIMIT`) — the other half
   *  of a repo's pass (#44). Redeclared rather than inherited from `GitHubRestack`, the
   *  way `addLabels` is: a restack asks what is open to find dependents and a re-derive
   *  asks to find unanswered summons, and `Gh` still implements it exactly once. */
  listOpenPrs(repo: string): Promise<OpenPullRequest[]>;
  /** One pull request's INLINE comments, oldest first. Read alongside `issueComments`
   *  because a summon lands on either stream, and neither can answer for the other. */
  reviewComments(repo: string, pr: number): Promise<ReviewComment[]>;
  /** Give the claim back, OFF the event loop — the async twin of `release`, and the only
   *  one re-deriving may use. Both edit the same label; what differs is how many of them
   *  there can be. The Assignor's `release` is reached once per item it is applying an
   *  outcome for, and those cannot outnumber `maxConcurrency`. Re-deriving reaches this
   *  one once per open issue wearing a claim nobody is on — and nothing anywhere caps
   *  that. A cutover, or any restart after a hard kill, faces a whole backlog of them at
   *  once; a blocking round-trip each is a parent that answers no readiness probe until
   *  the sweep ends, which is the SIGKILL/restart loop of ADR-0001. */
  releaseAsync(repo: string, issue: number): Promise<void>;
}

/** One open pull request, as the restack's dependent scan and #44's re-derive read them. */
export interface OpenPullRequest {
  number: number;
  /** The head branch. `feat/<n>` is one of ours; anything else is somebody's own work
   *  and the scan leaves it alone. */
  head: string;
  /** The labels on it right now. REQUIRED, for the reason `WorkItemRef.kind` is (#44
   *  constraint 2): a re-derived pull request is handed to the same admission the live
   *  delivery reaches, and that admission refuses a QUARANTINED item on the strength of
   *  this list. An empty default would re-admit an item set aside after failing twice —
   *  on every boot, every blackout catch-up and every repo recheck. */
  labels: string[];
}

/** A merged pull request's head — the fork-point recovery's last resort (ADR-0003).
 *  GitHub keeps `headRefOid` after the branch is deleted, and the matching
 *  `refs/pull/<number>/head` still holds the commit, which is why both are needed. */
export interface MergedPullRequest {
  number: number;
  headOid: string;
}

/** What a RESTACK is allowed to do to GitHub. Extends `GitHub` rather than standing
 *  alone because the dependent scan asks the same question admission does — what blocks
 *  this issue (`assignor/dag.mts`) — and reuses that read rather than a second copy of it.
 *
 *  Every write here addresses a PULL REQUEST, not an issue: what a restack moves is a
 *  branch, and by the time one runs its dependent's issue may well be done. */
export interface GitHubRestack extends GitHub {
  /** Every open PR in a routed repo, capped (`OPEN_PR_LIMIT`). The FORWARD edge of the
   *  dependent scan: GitHub's `.../dependencies/blocks` 404s, so nobody can ask "what
   *  does this unblock" — the only way to find dependents is to read what is open and
   *  ask each one what blocks IT. */
  listOpenPrs(repo: string): Promise<OpenPullRequest[]>;
  /** The merged PR that shipped this head, if there was one. `undefined` is a real
   *  answer — the head never merged through a PR — and the caller treats it as "no
   *  recoverable anchor", never as a licence to guess one. */
  mergedPrForHead(repo: string, head: string): Promise<MergedPullRequest | undefined>;
  /** Point a PR at a different base. A dependent whose blocker merged targets a branch
   *  that no longer exists; without this the PR is unmergeable and its diff shows the
   *  blocker's commits as its own. */
  retargetPr(repo: string, pr: number, base: string): Promise<void>;
  /** Label a PR — `awaiting-human` when a restack cannot be replayed. Separate from
   *  `addLabels` because that one addresses an ISSUE, and the stuck thing here is a
   *  branch whose issue may already be closed. */
  labelPr(repo: string, pr: number, labels: string[]): Promise<void>;
}

/** What the FAILURE POLICY is allowed to do to GitHub: apply a label, and nothing else.
 *  Its own seam for the same reason `GitHubForwarder` is one — the policy sits on every
 *  failure path, and a wider seam is a wider set of writes a handled failure could make.
 *  `Gh` implements it exactly once, as `addLabels`. */
export interface GitHubLabels {
  /** Mark the issue: `quarantined` when a work item is set aside, `agent-failed` when the
   *  agent reported its own defeat. BEST-EFFORT at the call site — durable state is what
   *  actually stops the item being re-admitted (#39 constraint 9). */
  addLabels(repo: string, issue: number, labels: string[]): Promise<void>;
  /** …and the same marks on a PULL REQUEST, for a comment run that failed (#44). A
   *  separate call because `gh issue edit <n>` addresses the ISSUE numbered `n`, which
   *  for a PR item is an unrelated issue that happens to share the number. Redeclared
   *  from `GitHubRestack` rather than inherited, the way `addLabels` is — `Gh`
   *  implements it exactly once. */
  labelPr(repo: string, pr: number, labels: string[]): Promise<void>;
}

/** What the forwarder supervisor is allowed to do to GitHub: drop the dev webhook a
 *  hard-killed `gh webhook forward` left behind, and nothing else. Its own seam, as
 *  narrow as it gets — the one method is a DELETE against somebody else's repo, and the
 *  supervisor reaching `gh` any other way would take the smoke offline with it. */
export interface GitHubForwarder {
  /** Drop every hook of gh's own forwarder on this repo. Matched on that URL exactly: a
   *  looser match deletes a child repo's REAL webhooks. */
  dropForwarderHooks(repo: string): Promise<void>;
}

/** One issue as READING it needs it: what the agent is told to work on, and what its
 *  pull request is titled. */
export interface IssueDetail {
  title: string;
  body: string;
}

/** One issue as a RUN needs it — the above, plus the two facts a run re-asserts before
 *  it starts (#38): is this issue still open, and does it still wear the labels it was
 *  admitted on. Wider than `IssueDetail` rather than in place of it because a run reads
 *  an issue ONCE for all three uses, while admission's blocker walk reads a body and
 *  nothing else. */
export interface RunIssueDetail extends IssueDetail {
  /** Lowercased issue state ("open" | "closed"), normalised HERE for the reason
   *  `Blocker.state` is: `gh issue view --json state` shouts where the dependencies
   *  endpoint whispers, and a caller comparing against the wrong casing reads every
   *  open issue as closed. */
  state: string;
  /** Label names, flattened as `listOpenIssues` flattens them — what a caller compares
   *  a repo's trigger labels against. */
  labels: string[];
}

/** A pull request to open, fully composed by the caller. `base` is the LOGICAL branch
 *  name (`main`), not the `origin/…` ref the run started the agent from — GitHub
 *  resolves it on the remote and knows nothing about a local checkout's refs. */
export interface NewPullRequest {
  repo: string;
  base: string;
  head: string;
  title: string;
  body: string;
  /** Anything short of the agent saying `ready` opens as a draft: a human decides
   *  whether a run it is not sure about is worth reviewing. */
  draft: boolean;
}

/** What ONE ISSUE RUN performs against GitHub. Separate from `GitHub` for the same
 *  reason `GitHubReconcile` is: the Assignor's seam stays the two writes it takes, and
 *  a test substituting a run's GitHub is never made to stub a claim it cannot reach.
 *  `addLabels` is redeclared rather than inherited — the run applies `awaiting-human`
 *  and the sweep replays a missed summon, which are different jobs on the same `gh`
 *  call, and `Gh` still implements it exactly once.
 *
 *  All async: a run holds an agent for minutes and awaits it, so nothing here has a
 *  reason to block a loop (ADR-0001). */
export interface GitHubRun {
  /** The issue the run is working on. Read on every run — fresh and on a gate resume —
   *  because the PR the resume finally opens is titled from it, and because the run
   *  asserts on its state and labels before it starts (#38). ONE read serves all three:
   *  `gh issue view` answers them in the same call. */
  readIssue(repo: string, issue: number): Promise<RunIssueDetail>;
  /** Apply labels — the run applies `awaiting-human` when the agent gates. */
  addLabels(repo: string, issue: number, labels: string[]): Promise<void>;
  /** Take labels off — the resuming run removes `awaiting-human` itself, so the
   *  Assignor never grows a third write for it. */
  removeLabels(repo: string, issue: number, labels: string[]): Promise<void>;
  /** The open PR for this head, if there already is one. A retried run whose first
   *  attempt already opened the PR must ADOPT it: `gh pr create` dies on "a pull
   *  request already exists", which would turn a recoverable GitHub blip into a
   *  human-only stop. */
  openPrForHead(repo: string, head: string): Promise<string | undefined>;
  /** Open it, and hand back its URL. */
  createPr(pr: NewPullRequest): Promise<string>;
}

/** One pull request as a PR-COMMENT RUN needs it: the branch it fixes and pushes, the
 *  branch that PR targets, and whether it is still open. The state is what the run
 *  re-asserts immediately before the push (#38) — a whole agent run elapses in between,
 *  and pushing into a merged or closed PR is a write nobody asked for. */
export interface PrDetail {
  /** The head branch — what the agent works on and what the host pushes. */
  head: string;
  /** The base branch, as the PR targets it. The prompt tells the agent what its diff is
   *  measured against. */
  base: string;
  /** Lowercased PR state ("open" | "closed" | "merged"), normalised HERE for the reason
   *  `RunIssueDetail.state` is: `gh pr view --json state` shouts, and a caller comparing
   *  against the wrong casing reads every open PR as closed. */
  state: string;
}

/** One INLINE review comment — the Files-changed tab, as opposed to the conversation
 *  timeline that `issueComments` reads. `id` is GitHub's own and monotonic within this
 *  stream, which is what makes "answered" decidable against our newest reply. */
export interface ReviewComment {
  id: number;
  body: string;
  /** The file the comment sits on. */
  path: string;
  /** The line in the diff, or `null` when GitHub has none to give — a comment on a file
   *  as a whole, or one whose lines the branch has since moved past. Reported as-is
   *  rather than defaulted to a number: a wrong line in the prompt sends the agent to
   *  the wrong place in the file. */
  line: number | null;
}

/** What ONE PR-COMMENT RUN performs against GitHub — read the pull request, read both
 *  comment streams, answer each of them. Its own seam for the same reason `GitHubRun` is
 *  one: the run cannot reach a claim it has no business taking (constraint 3), and a test
 *  substituting it stubs only what the lane actually calls.
 *
 *  `issueComments` is redeclared rather than reached through `GitHubReconcile`: a PR's
 *  conversation IS its issue thread, and `Gh` still implements it exactly once — the
 *  paginated read is what makes the newest reply visible on a long thread. */
export interface GitHubPrRun {
  /** The pull request the run is answering. Read at the start for the branches, and
   *  again before the push for the state. */
  readPr(repo: string, pr: number): Promise<PrDetail>;
  /** The inline review comments, oldest first. */
  reviewComments(repo: string, pr: number): Promise<ReviewComment[]>;
  /** The conversation timeline, oldest first — every page. */
  issueComments(repo: string, pr: number): Promise<IssueComment[]>;
  /** Answer an inline comment INSIDE its own thread, so the reply sits against the line
   *  it is about rather than at the bottom of the conversation. */
  replyToReviewComment(repo: string, pr: number, comment: number, body: string): Promise<void>;
  /** Answer a conversation comment. GitHub's PR conversation does not thread, so the
   *  reply quotes what it answers and the composition is the caller's. */
  commentOnPr(repo: string, pr: number, body: string): Promise<void>;
}

/** How one repo's forwarder is actually started. Injected so a smoke can drive the real
 *  supervisor over a child that is not `gh`. */
export type SpawnForwarder = (repo: string, url: string) => ChildProcess;

/** Re-derive ONE repo's outstanding work — `assignor/reconcile.mts`'s `Reconciler.repo`,
 *  injected as a function. It is that pass rather than a second re-derive route because a
 *  live path and a recovery path that drift are the defect class this rewrite exists to
 *  kill (constraint 7), and it is per repo because a forwarder that dropped for one repo
 *  missed events for that repo alone — sweeping the table would spend every other repo's
 *  rate limit on a gap they never had. */
export type ReconcileRepo = (repo: string) => Promise<void>;

export interface ForwardersDeps {
  /** The routed repos, `<owner>/<repo>` — the routing table's own keys. Names only: a
   *  forwarder cares about nothing else in a repo's config. */
  repos: string[];
  /** The port the receiver ACTUALLY bound, so the forwarders can never be pointed at a
   *  socket nothing is listening on. */
  port: number;
  github: GitHubForwarder;
  /** What a recovered forwarder's repo is caught up with — the missed work a blackout
   *  leaves behind, which v1 re-derived only on boot and therefore never. */
  reconcile: ReconcileRepo;
  log: ModuleLogger;
  retryMs?: number;
  settleMs?: number;
  spawn?: SpawnForwarder;
}
