// assignor/reconcile.mts — re-deriving outstanding work from GitHub, which is always the
// truth (CONTEXT.md). Sunday's own record of what is outstanding is disposable: a parent
// dies mid-run, a forwarder is down for an hour, a human labels an issue while the
// pipeline is stopped. GitHub replays none of that, so without this pass the work it
// represents is simply lost — an outage becomes a loss rather than a delay.
//
// It DECIDES NOTHING. Every issue and every pull request it finds is handed to the same
// admission seam a live webhook delivery goes through, so the recovery path and the live
// path cannot drift — which is the exact defect class this rewrite exists to kill, and the
// reason the seam is exposed rather than a `Delivery` synthesised here (a synthetic one
// would put an event in the log that never happened).
//
// A repo's pass has two halves, and the second is #44's: an `@sunday` comment on a PULL
// REQUEST is its own work item, and the webhook that carries one fires exactly as many
// times as the one on an issue does — once. What makes it re-derivable with no state of
// ours is the reply marker: a summon newer than Sunday's newest reply is outstanding.
//
// Two things are true of the recovery path and not the live one, and both happen BEFORE
// the hand-off:
//   · a claim nobody is on. The `agent-working` label is Sunday's cross-restart mutual
//     exclusion, so a parent that died holding it leaves an issue no delivery can ever
//     re-admit. Released here — but ONLY when no process is on the item, because a
//     cleared claim re-admits the issue and a second agent on live work is real quota
//     spent twice (the one genuinely dangerous write in this file).
//   · a summon nobody answered. `@sunday` in a comment while the pipeline was down fires
//     no webhook Sunday will ever see again, and the issue is short only the labels a
//     human would have added; they are applied here so admission reaches it by its
//     ordinary path.

import { admitIssue, type Assignor } from "#assignor/index.mts";
import type { RepoConfig } from "#config/repos.mts";
import { isSummon, SUNDAY_MARKER, unansweredSummons } from "#lib/markers.mts";
import {
  CLAIM_LABEL,
  type GitHubReconcile,
  type IssueComment,
  type OpenIssue,
  type OpenPullRequest,
} from "#services/github/index.mts";
import type { ModuleLogger } from "#services/logger.mts";

/** Everything reconcile needs and constructs none of: the routing table it sweeps, the
 *  GitHub reads it re-derives from, the Assignor whose admission seam every issue is
 *  handed to (constraint 3), and the Logger. */
export interface ReconcilerDeps {
  repos: Record<string, RepoConfig>;
  github: GitHubReconcile;
  assignor: Assignor;
  log: ModuleLogger;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class Reconciler {
  // Declared, not parameter properties: Node runs `.mts` in strip-only mode, which
  // rejects `constructor(private x)`.
  private readonly repos: Record<string, RepoConfig>;
  private readonly github: GitHubReconcile;
  private readonly assignor: Assignor;
  private readonly log: ModuleLogger;

  constructor(deps: ReconcilerDeps) {
    this.repos = deps.repos;
    this.github = deps.github;
    this.assignor = deps.assignor;
    this.log = deps.log;
  }

  /** Every routed repo, once. Isolated per repo — inside `repo()` itself, so one repo that
   *  cannot be read costs that repo its pass and nothing more, whichever caller asked. */
  async run(): Promise<void> {
    for (const repo of Object.keys(this.repos)) await this.repo(repo);
  }

  /** One repo's pass, both halves of it: the open issues, then the open pull requests
   *  (#44). Two reads and two loops rather than one, and ISOLATED from each other — a
   *  `gh issue list` that 502s says nothing about the pull requests, and a work item lost
   *  because the other half's read failed is exactly the outage-becomes-loss this module
   *  exists to prevent.
   *
   *  Public because a blackout is per repo: a forwarder that dropped for one repo missed
   *  events for that repo alone, and sweeping the whole table to catch it up spends every
   *  other repo's rate limit on a gap they never had. It is THIS pass rather than a second
   *  re-derive route, so the recovery path and boot's path cannot drift (constraint 3).
   *
   *  It THROWS NOTHING, and that belongs here rather than in `run()`: GitHub is somebody
   *  else's service and it 502s, and one repo that cannot be read must cost that repo its
   *  pass and no more — for the sweep, the repos behind it, and for a blackout recovery,
   *  the parent itself. That caller is a timer with nobody above it, where a rejection is
   *  an unhandled one and the process dies under `restart: always` (ADR-0001). GitHub
   *  stays the truth either way, so the next pass simply asks again. */
  async repo(repo: string): Promise<void> {
    await this.issues(repo);
    await this.pullRequests(repo);
  }

  /** One repo's open issues, in one bounded read (`OPEN_ISSUE_LIMIT`) — boot's duration
   *  must not be a function of somebody else's backlog. Isolated per issue as well as per
   *  repo: reconsidering one reaches GitHub too. */
  private async issues(repo: string): Promise<void> {
    try {
      const issues = await this.github.listOpenIssues(repo);
      this.log.info(`⟲ ${repo}: re-deriving from ${issues.length} open issue(s)`);
      for (const issue of issues) {
        try {
          await this.issue(repo, issue);
        } catch (err) {
          this.log.error(`✗ ${repo}#${issue.number} not reconsidered — ${describe(err)}`, { repo });
        }
      }
    } catch (err) {
      this.log.error(`✗ ${repo} not re-derived — ${describe(err)}`, { repo });
    }
  }

  /** The same, for one repo's open pull requests (`OPEN_PR_LIMIT`): a comment run is a
   *  work item like any other, and the summon that starts one arrives as a webhook that
   *  fires exactly once. Down, restarted, blacked out — and a human's request is gone.
   *
   *  Isolated per pull request as well as per repo, for the reason the issue half is:
   *  deciding one reads two comment streams and then admission reads the PR itself, all of
   *  it somebody else's service. */
  private async pullRequests(repo: string): Promise<void> {
    try {
      const prs = await this.github.listOpenPrs(repo);
      this.log.info(`⟲ ${repo}: re-deriving from ${prs.length} open pull request(s)`);
      for (const pr of prs) {
        try {
          await this.pullRequest(repo, pr);
        } catch (err) {
          this.log.error(`✗ ${repo}#pr${pr.number} not reconsidered — ${describe(err)}`, { repo });
        }
      }
    } catch (err) {
      this.log.error(`✗ ${repo} pull requests not re-derived — ${describe(err)}`, { repo });
    }
  }

  /** One open pull request: hand it to admission if — and only if — a summon on it is
   *  still outstanding. The read is the DERIVATION and not a guard, which is why nothing
   *  of admission's is repeated here (constraint 3): what the sweep answers is the one
   *  question a delivery answered by existing at all, and every question after it belongs
   *  to the same `considerPrComment` the live route reaches.
   *
   *  PUBLIC because the sweep is not the only thing that has to ask it. An EDITED comment
   *  and a comment run that just settled both need "is anything on this pull request still
   *  outstanding?" and neither may answer it for itself — a second reading of what
   *  "answered" means is how one of them drifts into re-running served work on real quota.
   *
   *  Both streams, filtered SEPARATELY: GitHub's ids are monotonic only inside one id
   *  space, so an inline comment's id says nothing about a conversation reply's. The
   *  conversation goes first and short-circuits — most summons are written there, and the
   *  inline read is a round-trip that then buys nothing.
   *
   *  "Answered" is the REPLY marker and never `SUNDAY_MARKER` (constraint 7): the two
   *  milestone comments a work item posts land on this same thread, and counting one as an
   *  answer buries a summon that arrived mid-run under a comment that never addressed it —
   *  where the issue half's `hasUnansweredSummon` has no reply of its own to compare
   *  against and reads any comment of ours as the answer. */
  async pullRequest(repo: string, open: Pick<OpenPullRequest, "number" | "labels">): Promise<void> {
    const conversation = await this.github.issueComments(repo, open.number);
    const outstanding =
      unansweredSummons(conversation).length > 0 ||
      unansweredSummons(await this.github.reviewComments(repo, open.number)).length > 0;
    if (!outstanding) return;
    this.log.info(`⟲ ${repo}#pr${open.number} — a summon nobody has replied to`, { repo });
    // AWAITED, and the labels are the pull request's OWN (#44 constraint 2): admission
    // reaches GitHub, so a floating rejection would settle outside the per-PR catch above
    // and take the parent down (ADR-0001) — and an item quarantined after failing twice is
    // refused on the strength of these labels, which an empty list would hand straight
    // back to an agent on every pass.
    await this.assignor.considerPrComment({ repo, number: open.number, labels: open.labels });
  }

  /** One open issue: release the claim nobody is on, then hand it to the admission seam
   *  and let the Assignor decide. `undefined` back from the unclaim means somebody is on
   *  this issue right now and reconcile has no business touching it at all. */
  private async issue(repo: string, open: OpenIssue): Promise<void> {
    const labels = await this.unclaim(repo, open);
    if (!labels) return;
    // AWAITED (#42): admission asks GitHub what blocks the issue, so it is async now and a
    // floating one would settle outside the caller's per-issue try/catch — an unhandled
    // rejection takes the parent down under `restart: always` (ADR-0001). Waiting also
    // keeps the sweep serial, which is what stops a 200-issue backlog opening 200
    // concurrent `gh` reads at once.
    await this.assignor.considerIssue({ repo, number: open.number, labels: await this.replaySummon(repo, open.number, labels) });
  }

  /** Apply the labels a missed summon should have caused, and answer with the labels the
   *  issue now carries. `@sunday` while the pipeline was down fires a webhook once and
   *  never again, so an issue asked for in a comment sits there short exactly the labels
   *  a human would have had to add — replayed here, it reaches admission by its ordinary
   *  path rather than through a second, privileged way in.
   *
   *  "Short ONLY its triggers" is decided by asking the real admission rule twice, not by
   *  reading its refusal text or re-deriving what is missing here (constraint 3): refused
   *  as it stands, admitted with its triggers added. A spec, a claim, an unrouted repo —
   *  everything admission refuses for a reason the labels cannot fix — fails the second
   *  ask too, so none of them is ever relabelled.
   *
   *  The comment read is LAST because it is a network round-trip per issue, and only the
   *  issues that are one label away pay for it. */
  private async replaySummon(repo: string, issue: number, labels: string[]): Promise<string[]> {
    if (admitIssue(repo, labels, this.repos).admit) return labels;
    // Routed by construction — the sweep iterates the table's own keys.
    const missing = this.repos[repo].triggerLabels.filter((label) => !labels.includes(label));
    if (!admitIssue(repo, [...labels, ...missing], this.repos).admit) return labels;
    if (!hasUnansweredSummon(await this.github.issueComments(repo, issue))) return labels;
    this.log.info(`⟲ ${repo}#${issue} — replaying a missed @sunday summon as [${missing.join(", ")}]`, { repo });
    await this.github.addLabels(repo, issue, missing);
    return [...labels, ...missing];
  }

  /** Strip a claim nobody is behind, and answer with the labels the issue REALLY carries
   *  as far as admission is concerned. Admission rejects a claimed issue outright, so an
   *  orphaned claim is an issue no delivery can ever re-admit — and it is invisible,
   *  because on GitHub it looks precisely like an issue being worked right now.
   *
   *  Which is why the lock decides and the label never does (constraint 6): children
   *  outlive the parent by design (ADR-0001), so a LIVE lock means the claim is telling
   *  the truth and this issue is somebody's work in progress. Releasing it there re-admits
   *  the issue underneath a run still going — two agents on one work item, on real quota,
   *  both pushing the same branch. The Assignor is asked rather than `var/running/` read
   *  here (constraint 5): one owner for the lock is what stops two readings of it drifting.
   *
   *  The release goes through `releaseAsync` and never the Assignor's synchronous
   *  `release` (constraint 9). How many of these a boot performs is bounded by how many
   *  open issues wear a stale claim, and nothing caps that — a cutover, or a restart after
   *  a hard kill, meets a whole backlog of them. One blocking `gh` round-trip each is a
   *  parent that answers no readiness probe until the sweep ends, and the supervisor
   *  SIGKILLs it into the restart loop ADR-0001 exists to stop. */
  private async unclaim(repo: string, open: OpenIssue): Promise<string[] | undefined> {
    if (!open.labels.includes(CLAIM_LABEL)) return open.labels;
    const pid = this.assignor.liveChild(`${repo}#${open.number}`);
    if (pid !== undefined) {
      this.log.info(`· ${repo}#${open.number} left alone — pid ${pid} is still on it`, { repo });
      return undefined;
    }
    this.log.info(`⟲ ${repo}#${open.number} — released an orphaned ${CLAIM_LABEL}: nothing is on it`, { repo });
    await this.github.releaseAsync(repo, open.number);
    return open.labels.filter((label) => label !== CLAIM_LABEL);
  }
}

/** Does this thread carry a summon Sunday has not answered yet? Decidable with no state
 *  of ours because GitHub's comment ids are monotonic: a summon older than our newest
 *  reply was dealt with, on this boot and on every boot after it. Without that compare a
 *  served summon re-fires on every restart — each one a real agent run on real quota.
 *
 *  PURE, and per stream: ids are only comparable inside one id space. Ported from v1's
 *  `listener/reconcile.mts` (`hasUnaddressedSunday`), with the marker and the summon rule
 *  taken from `lib/markers.mts` rather than passed in — there is one of each. */
export function hasUnansweredSummon(comments: IssueComment[]): boolean {
  return newest(comments, (c) => isSummon(c.body)) > newest(comments, (c) => c.body.includes(SUNDAY_MARKER));
}

/** The highest id among the comments that match, or 0 when none do — so "nobody has
 *  replied" compares as older than any real comment. */
function newest(comments: IssueComment[], match: (c: IssueComment) => boolean): number {
  return comments.reduce((max, c) => (match(c) && c.id > max ? c.id : max), 0);
}
