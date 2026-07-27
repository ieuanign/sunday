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

/** How many open issues one repo's re-derive reads, ported unchanged from v1. Boot runs
 *  this per routed repo, so it is the ceiling on how long a restart takes to get back to
 *  work — and a repo with more open issues than this has a backlog no restart should be
 *  trying to swallow in one pass. */
const OPEN_ISSUE_LIMIT = 200;

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

/** What the forwarder supervisor is allowed to do to GitHub: drop the dev webhook a
 *  hard-killed `gh webhook forward` left behind, and nothing else. Its own seam, as
 *  narrow as it gets — the one method is a DELETE against somebody else's repo, and the
 *  supervisor reaching `gh` any other way would take the smoke offline with it. */
export interface GitHubForwarder {
  /** Drop every hook of gh's own forwarder on this repo. Matched on that URL exactly: a
   *  looser match deletes a child repo's REAL webhooks. */
  dropForwarderHooks(repo: string): Promise<void>;
}

/** One issue as a RUN needs to read it: what the agent is told to work on, and what its
 *  pull request is titled. */
export interface IssueDetail {
  title: string;
  body: string;
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
   *  because the PR the resume finally opens is titled from it. */
  readIssue(repo: string, issue: number): Promise<IssueDetail>;
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

/** The real one, over the `gh` CLI. `--repo` addresses the issue directly — v1 passed a
 *  child checkout as cwd instead, a field every one of its 39 call sites had to carry.
 *
 *  Left out of the smokes on purpose, like `githubDestination()`: it needs the CLI, a
 *  token and the network. What CAN be wrong is WHEN Sunday claims, releases and
 *  re-derives, and the Assignor's and Reconciler's smokes drive that over a substitute. */
export class Gh implements GitHubReconcile, GitHubRun, GitHubForwarder {
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

  async readIssue(repo: string, issue: number): Promise<IssueDetail> {
    const out = await shA("gh", ["issue", "view", String(issue), "--repo", repo, "--json", "title,body"]);
    return JSON.parse(out) as IssueDetail;
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
