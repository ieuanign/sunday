// services/github/index.mts — everything Sunday says to GitHub, in one place. v1
// spread 39 `sh("gh", …)` call sites across the tree; they are collapsed here so the
// shape of every write is visible at once. The spine writes exactly one thing — the
// claim — #35 adds the reads a restart re-derives its work from, and #36/#40/#42 grow
// the rest.

import { sh, shA } from "#lib/sh.mts";
import { CLAIM_LABEL } from "./constants.mts";
import type {
  Blocker,
  GitHubForwarder,
  GitHubLabels,
  GitHubPrRun,
  GitHubReconcile,
  GitHubRestack,
  GitHubRun,
  IssueComment,
  IssueDetail,
  MergedPullRequest,
  NewPullRequest,
  OpenIssue,
  OpenPullRequest,
  PrDetail,
  ReviewComment,
  RunIssueDetail,
} from "./types.mts";

// The declarations moved out (CLAUDE.md §7) come back through here, so every caller
// still imports them from `#services/github/index.mts`.
export * from "./constants.mts";
export * from "./types.mts";

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

  async issueLabels(repo: string, issue: number): Promise<string[]> {
    // Off the read that already answers it — no second `gh` call for a fact one view has.
    return (await this.readIssue(repo, issue)).labels;
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
      "number,headRefName,labels",
      "--limit",
      String(OPEN_PR_LIMIT),
    ]);
    const prs = JSON.parse(out) as { number: number; headRefName: string; labels: { name: string }[] }[];
    return prs.map((pr) => ({ number: pr.number, head: pr.headRefName, labels: pr.labels.map((l) => l.name) }));
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
