// assignor/reconcile.mts — re-deriving outstanding work from GitHub, which is always the
// truth (CONTEXT.md). Sunday's own record of what is outstanding is disposable: a parent
// dies mid-run, a forwarder is down for an hour, a human labels an issue while the
// pipeline is stopped. GitHub replays none of that, so without this pass the work it
// represents is simply lost — an outage becomes a loss rather than a delay.
//
// It DECIDES NOTHING. Every issue it finds is handed to the same admission seam a live
// webhook delivery goes through, so the recovery path and the live path cannot drift —
// which is the exact defect class this rewrite exists to kill, and the reason the seam is
// exposed rather than a `Delivery` synthesised here (a synthetic one would put an event
// in the log that never happened).
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
import { isSummon, SUNDAY_MARKER } from "#lib/markers.mts";
import { CLAIM_LABEL, type GitHubReconcile, type IssueComment, type OpenIssue } from "#services/github/index.mts";
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

  /** Every routed repo, once. Isolated per repo: GitHub is somebody else's service and it
   *  502s, so one repo that cannot be read must not cost every repo behind it its whole
   *  backlog. GitHub stays the truth, so the next boot simply tries again. */
  async run(): Promise<void> {
    for (const repo of Object.keys(this.repos)) {
      try {
        await this.repo(repo);
      } catch (err) {
        this.log.error(`✗ ${repo} not re-derived — ${describe(err)}`, { repo });
      }
    }
  }

  /** One repo's open issues, in one bounded read (`OPEN_ISSUE_LIMIT`) — boot's duration
   *  must not be a function of somebody else's backlog. Isolated per issue as well as per
   *  repo: reconsidering one reaches GitHub too. */
  private async repo(repo: string): Promise<void> {
    const issues = await this.github.listOpenIssues(repo);
    this.log.info(`⟲ ${repo}: re-deriving from ${issues.length} open issue(s)`);
    for (const issue of issues) {
      try {
        await this.issue(repo, issue);
      } catch (err) {
        this.log.error(`✗ ${repo}#${issue.number} not reconsidered — ${describe(err)}`, { repo });
      }
    }
  }

  /** One open issue: release the claim nobody is on, then hand it to the admission seam
   *  and let the Assignor decide. `undefined` back from the unclaim means somebody is on
   *  this issue right now and reconcile has no business touching it at all. */
  private async issue(repo: string, open: OpenIssue): Promise<void> {
    const labels = this.unclaim(repo, open);
    if (!labels) return;
    this.assignor.considerIssue({ repo, number: open.number, labels: await this.replaySummon(repo, open.number, labels) });
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
   *  here (constraint 5): one owner for the lock is what stops two readings of it drifting. */
  private unclaim(repo: string, open: OpenIssue): string[] | undefined {
    if (!open.labels.includes(CLAIM_LABEL)) return open.labels;
    const pid = this.assignor.liveChild(`${repo}#${open.number}`);
    if (pid !== undefined) {
      this.log.info(`· ${repo}#${open.number} left alone — pid ${pid} is still on it`, { repo });
      return undefined;
    }
    this.log.info(`⟲ ${repo}#${open.number} — released an orphaned ${CLAIM_LABEL}: nothing is on it`, { repo });
    this.github.release(repo, open.number);
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
