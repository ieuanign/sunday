// services/github/index.mts — everything Sunday says to GitHub, in one place. v1
// spread 39 `sh("gh", …)` call sites across the tree; V2 collapses them here so the
// shape of every write is visible at once. The spine writes exactly one thing — the
// claim — #35 adds the reads a restart re-derives its work from, and #36/#40/#42 grow
// the rest.

import { sh, shA } from "#lib/sh.mts";

/** The label that says an issue is Sunday's RIGHT NOW. It is the durable cross-restart
 *  guard: a parent that comes back up with no memory reads this off GitHub, and a
 *  delivery that arrives mid-run is rejected by admission on the strength of it. */
export const CLAIM_LABEL = "agent-working";

/** The label that says a work item failed twice and has been set aside (#39). It is the
 *  RELEASE signal as much as the record: admission refuses a quarantined item while this
 *  is on the issue, and a human takes it off to hand the item back. Seeded by
 *  `scripts/repo-init.sh` alongside the rest. */
export const QUARANTINE_LABEL = "quarantined";

/** The label that says the agent RAN and reported the failure itself — its own verdict,
 *  not something that blew up around it. Nothing retries one: the run happened, and a
 *  second one would spend a whole agent run re-deciding what it already decided. */
export const AGENT_FAILED_LABEL = "agent-failed";

/** The label that says a HUMAN has to act before this moves again: an issue run that
 *  stopped to ask, and a PR whose restack hit a conflict Sunday will not guess at (#43).
 *  One home rather than a literal per writer — this is the string a human filters on. */
export const AWAITING_HUMAN_LABEL = "awaiting-human";

/** How many open issues one repo's re-derive reads, ported unchanged from v1. Boot runs
 *  this per routed repo, so it is the ceiling on how long a restart takes to get back to
 *  work — and a repo with more open issues than this has a backlog no restart should be
 *  trying to swallow in one pass. */
const OPEN_ISSUE_LIMIT = 200;

/** How many open PRs one repo's dependent scan reads, ported unchanged from v1. It runs
 *  once per restack step (each one cascades), so it is the ceiling on how long a cascade
 *  takes — and every PR read here costs a blocker read of its own. */
const OPEN_PR_LIMIT = 100;

/** The URL `gh webhook forward` registers its own dev webhook against. Matched EXACTLY
 *  when a stranded one is dropped — the delete is the one genuinely dangerous write in
 *  the relay, and a looser match would take a child repo's real webhooks with it. */
const FORWARDER_HOOK_URL = "https://webhook-forwarder.github.com/hook";

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

/** One open pull request, as the restack's dependent scan reads them. */
export interface OpenPullRequest {
  number: number;
  /** The head branch. `feat/<n>` is one of ours; anything else is somebody's own work
   *  and the scan leaves it alone. */
  head: string;
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

/** The real one, over the `gh` CLI. `--repo` addresses the issue directly — v1 passed a
 *  child checkout as cwd instead, a field every one of its 39 call sites had to carry.
 *
 *  Left out of the smokes on purpose, like `githubDestination()`: it needs the CLI, a
 *  token and the network. What CAN be wrong is WHEN Sunday claims, releases and
 *  re-derives, and the Assignor's and Reconciler's smokes drive that over a substitute. */
export class Gh implements GitHubReconcile, GitHubRun, GitHubForwarder, GitHubLabels, GitHubRestack, GitHubPrRun {
  claim(repo: string, issue: number): void {
    sh("gh", ["issue", "edit", String(issue), "--repo", repo, "--add-label", CLAIM_LABEL]);
  }

  release(repo: string, issue: number): void {
    sh("gh", ["issue", "edit", String(issue), "--repo", repo, "--remove-label", CLAIM_LABEL]);
  }

  async releaseAsync(repo: string, issue: number): Promise<void> {
    await shA("gh", ["issue", "edit", String(issue), "--repo", repo, "--remove-label", CLAIM_LABEL]);
  }

  async listOpenIssues(repo: string): Promise<OpenIssue[]> {
    const out = await shA("gh", [
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--json",
      "number,labels",
      "--limit",
      String(OPEN_ISSUE_LIMIT),
    ]);
    const issues = JSON.parse(out) as { number: number; labels: { name: string }[] }[];
    return issues.map((it) => ({ number: it.number, labels: it.labels.map((l) => l.name) }));
  }

  async issueComments(repo: string, issue: number): Promise<IssueComment[]> {
    // Every page, not just the first: whether a summon is ANSWERED is decided by
    // comparing it against our newest reply, and the newest comments are on the LAST
    // page. Reading only page one on a long thread shows the summon without the answer
    // — which replays a summon Sunday already served, as a second agent run on real
    // quota. `--jq` with `--paginate` emits one object per line rather than one JSON
    // document (each page is filtered on its own), so the parse is line-by-line.
    const out = await shA("gh", [
      "api",
      "--paginate",
      `repos/${repo}/issues/${issue}/comments?per_page=100`,
      "--jq",
      ".[] | { id, body }",
    ]);
    return out
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as IssueComment);
  }

  async addLabels(repo: string, issue: number, labels: string[]): Promise<void> {
    // One `--add-label` per label rather than one comma-joined value: `gh` splits that
    // value on commas, so a label with a comma in its name would be applied as two
    // labels that do not exist.
    await shA("gh", [
      "issue",
      "edit",
      String(issue),
      "--repo",
      repo,
      ...labels.flatMap((label) => ["--add-label", label]),
    ]);
  }

  async removeLabels(repo: string, issue: number, labels: string[]): Promise<void> {
    await shA("gh", [
      "issue",
      "edit",
      String(issue),
      "--repo",
      repo,
      ...labels.flatMap((label) => ["--remove-label", label]),
    ]);
  }

  async readIssue(repo: string, issue: number): Promise<RunIssueDetail> {
    // The wider return satisfies `GitHub.readIssue` too — admission's blocker walk reads
    // the body off it and ignores the rest, which is one `gh` call per run instead of two.
    const out = await shA("gh", ["issue", "view", String(issue), "--repo", repo, "--json", "title,body,state,labels"]);
    const detail = JSON.parse(out) as IssueDetail & { state: string; labels: { name: string }[] };
    return {
      title: detail.title,
      body: detail.body,
      state: detail.state.toLowerCase(),
      labels: detail.labels.map((l) => l.name),
    };
  }

  async blockedBy(repo: string, issue: number): Promise<Blocker[]> {
    // No `try`, deliberately — the swallow is the defect (`listener/dag.mts:45`). The
    // endpoint answers on every routed repo, exits 0 with EMPTY stdout when an issue
    // has no dependencies, and exits non-zero with `gh: … (HTTP …)` on stderr when the
    // read fails; `shA` turns the latter into a throw, which is exactly the
    // "unknown, defer" the caller needs. A repo that genuinely lacked the endpoint
    // would 404 loudly here rather than admit silently.
    const out = await shA("gh", [
      "api",
      `repos/${repo}/issues/${issue}/dependencies/blocked_by`,
      "--jq",
      ".[] | [.number, .state] | @tsv",
    ]);
    return out
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => {
        const [number, state] = line.split("\t");
        return { number: Number(number), state: state.toLowerCase() };
      });
  }

  async issueState(repo: string, issue: number): Promise<string> {
    const out = await shA("gh", ["issue", "view", String(issue), "--repo", repo, "--json", "state", "--jq", ".state"]);
    return out.toLowerCase();
  }

  async openPrForHead(repo: string, head: string): Promise<string | undefined> {
    // `--jq` with the `// ""` fallback so "no open PR" is an empty line rather than a
    // parse of an empty array on every call.
    const url = await shA("gh", [
      "pr",
      "list",
      "--repo",
      repo,
      "--head",
      head,
      "--state",
      "open",
      "--json",
      "url",
      "--jq",
      '.[0].url // ""',
    ]);
    return url || undefined;
  }

  async listOpenPrs(repo: string): Promise<OpenPullRequest[]> {
    const out = await shA("gh", [
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--json",
      "number,headRefName",
      "--limit",
      String(OPEN_PR_LIMIT),
    ]);
    const prs = JSON.parse(out) as { number: number; headRefName: string }[];
    return prs.map((pr) => ({ number: pr.number, head: pr.headRefName }));
  }

  async mergedPrForHead(repo: string, head: string): Promise<MergedPullRequest | undefined> {
    // Newest first, so a head that merged more than once (reopened, re-merged) answers
    // with the merge that actually left the branch where it is.
    const out = await shA("gh", [
      "pr",
      "list",
      "--repo",
      repo,
      "--head",
      head,
      "--state",
      "merged",
      "--json",
      "number,headRefOid",
      "--limit",
      "1",
    ]);
    const prs = JSON.parse(out) as { number: number; headRefOid: string }[];
    return prs.length === 0 ? undefined : { number: prs[0].number, headOid: prs[0].headRefOid };
  }

  async retargetPr(repo: string, pr: number, base: string): Promise<void> {
    await shA("gh", ["pr", "edit", String(pr), "--repo", repo, "--base", base]);
  }

  async labelPr(repo: string, pr: number, labels: string[]): Promise<void> {
    // One `--add-label` per label, for the reason `addLabels` spells out.
    await shA("gh", ["pr", "edit", String(pr), "--repo", repo, ...labels.flatMap((label) => ["--add-label", label])]);
  }

  async readPr(repo: string, pr: number): Promise<PrDetail> {
    const out = await shA("gh", ["pr", "view", String(pr), "--repo", repo, "--json", "headRefName,baseRefName,state"]);
    const detail = JSON.parse(out) as { headRefName: string; baseRefName: string; state: string };
    return { head: detail.headRefName, base: detail.baseRefName, state: detail.state.toLowerCase() };
  }

  async reviewComments(repo: string, pr: number): Promise<ReviewComment[]> {
    // Paginated and parsed line-by-line for the reason `issueComments` is: whether a
    // summon is ANSWERED is decided against our newest reply, and on a long review the
    // newest comments are on the LAST page.
    //
    // `line` falls back to `original_line`: GitHub nulls `line` once the branch has moved
    // past the diff hunk a comment was left on, and that comment is still a human asking
    // for something — dropping its location would send the agent to the file with no idea
    // where in it to look.
    const out = await shA("gh", [
      "api",
      "--paginate",
      `repos/${repo}/pulls/${pr}/comments?per_page=100`,
      "--jq",
      ".[] | { id, body, path, line: (.line // .original_line) }",
    ]);
    return out
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as ReviewComment);
  }

  async replyToReviewComment(repo: string, pr: number, comment: number, body: string): Promise<void> {
    // The `/replies` endpoint, not a fresh review comment: it is the one call that puts
    // the answer in the SAME thread as the question. `-f` sends the body as a literal
    // form value, so an agent-authored reply is never read as a flag or a file.
    await shA("gh", ["api", `repos/${repo}/pulls/${pr}/comments/${comment}/replies`, "-f", `body=${body}`]);
  }

  async commentOnPr(repo: string, pr: number, body: string): Promise<void> {
    await shA("gh", ["pr", "comment", String(pr), "--repo", repo, "--body", body]);
  }

  async dropForwarderHooks(repo: string): Promise<void> {
    // `gh` keeps ONE dev webhook per repo and refuses to register a second, so a hard-
    // killed forwarder (SIGKILL, crash, power loss) strands one and every later start
    // dies on `HTTP 422 … Hook already exists` — a blackout no amount of retrying clears.
    // The read selects on gh's own forwarder URL, ported unchanged from the retired
    // `scripts/webhook-forward.sh`, so a repo's real webhooks are never in the set.
    const found = await shA("gh", [
      "api",
      `repos/${repo}/hooks`,
      "--jq",
      `.[] | select(.config.url == "${FORWARDER_HOOK_URL}") | .id`,
    ]);
    // Numeric ids only: everything after this is a DELETE against somebody else's repo,
    // and the one thing that must not be improvised is what it addresses.
    for (const id of found.split("\n").map((line) => line.trim())) {
      if (!/^\d+$/.test(id)) continue;
      await shA("gh", ["api", "-X", "DELETE", `repos/${repo}/hooks/${id}`]);
    }
  }

  async createPr(pr: NewPullRequest): Promise<string> {
    // `--head` is passed EXPLICITLY (not left to default): it is what makes `gh` skip
    // inspecting a local checkout for the branch to push and fork. The forked child's
    // cwd is Sunday's own repo, so a create that fell back to git context would open
    // the PR against the wrong repository entirely.
    return await shA("gh", [
      "pr",
      "create",
      "--repo",
      pr.repo,
      "--base",
      pr.base,
      "--head",
      pr.head,
      ...(pr.draft ? ["--draft"] : []),
      "--title",
      pr.title,
      "--body",
      pr.body,
    ]);
  }
}
