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

/** What the Assignor is allowed to do to GitHub. Narrow deliberately: it is the seam a
 *  test substitutes, and every method on it is a real edit to a real repo. */
export interface GitHub {
  /** Take the issue. A claim applied without a run starting strands the issue until
   *  #35's orphan sweep, so it is taken as late as it can be and released as early. */
  claim(repo: string, issue: number): void;
  /** Give it back. NEVER while a child may still be alive — a released claim readmits
   *  the issue, and a second agent on it is a duplicate run and real quota. */
  release(repo: string, issue: number): void;
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
}

/** The real one, over the `gh` CLI. `--repo` addresses the issue directly — v1 passed a
 *  child checkout as cwd instead, a field every one of its 39 call sites had to carry.
 *
 *  Left out of the smokes on purpose, like `githubDestination()`: it needs the CLI, a
 *  token and the network. What CAN be wrong is WHEN Sunday claims, releases and
 *  re-derives, and the Assignor's and Reconciler's smokes drive that over a substitute. */
export class Gh implements GitHubReconcile {
  claim(repo: string, issue: number): void {
    sh("gh", ["issue", "edit", String(issue), "--repo", repo, "--add-label", CLAIM_LABEL]);
  }

  release(repo: string, issue: number): void {
    sh("gh", ["issue", "edit", String(issue), "--repo", repo, "--remove-label", CLAIM_LABEL]);
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
}
