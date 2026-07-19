// listener/reconcile.mts — reconcile-on-restart (M2, step 7).
//
// GitHub is the truth; the in-memory state (deferred set, restack queue, branch
// locks) is disposable and NOTHING about restack is persisted. On boot we
// re-derive ALL pending work from GitHub, driving it through the SAME live-path
// callbacks (admit, summon, resume, PR-comment, restack) so there's no drift
// between "caught live" and "recovered on restart". An outage is a delay, not a
// loss; the `.scratch/state.json` save-data only adds the `sessionId` that lets a
// gated run resume instead of restarting.
//
// Covers: new labelled issues · orphaned `agent-working` claims · the deferred
// set · missed gate replies · missed @sunday mentions (issue + PR) · missed
// PR-merge restacks (delegated to restack.mts) · terminal-PR local branches.
//
// The decision helpers are pure + exported so a no-quota smoke can drive them
// with synthetic comments/labels (the I/O orchestration below reads GitHub via
// `gh`, so its end-to-end path is user-driven, like the 6c restack e2e).

import { resolve } from "node:path";

import {
  sh,
  isSummon,
  localFeatBranches,
  deleteLocalBranch,
  SUNDAY_MARKER,
} from "./helper.mts";
import { getIssue, readState, type IssueStatus } from "./state.mts";
import type { RepoConfig } from "#config/repos.mts";

const parentRoot = resolve(import.meta.dirname, "..");

// ── Pure decision helpers (unit-tested; no I/O) ──────────────────────────────

export interface CommentRef {
  id: number;
  body: string;
}

/** The human reply that should resume a gated issue: the newest non-marker
 *  comment posted AFTER our last gate marker. GitHub comment ids are monotonic,
 *  so "id greater than our gate's" == "posted after we gated". null when the
 *  human hasn't replied since (or there's no gate anchor to measure against). */
export function pickResumeReply(comments: CommentRef[], marker: string): string | null {
  const gateId = comments.reduce((m, c) => (c.body.includes(marker) && c.id > m ? c.id : m), 0);
  if (gateId === 0) return null;
  const replies = comments.filter((c) => !c.body.includes(marker) && c.id > gateId);
  return replies.length ? replies.reduce((a, b) => (b.id > a.id ? b : a)).body : null;
}

/** Does one comment stream carry an @sunday summon we haven't answered? True iff
 *  the newest summon id exceeds the newest marker (our reply) id. Idempotent
 *  across restarts: an @sunday already answered before the crash has a lower id
 *  than our reply, so it never re-fires. Call per stream (conversation, inline) —
 *  each self-contains its mentions and our replies to them. */
export function hasUnaddressedSunday(
  comments: CommentRef[],
  marker: string,
  summon: (body: string) => boolean,
): boolean {
  const maxMarker = comments.reduce((m, c) => (c.body.includes(marker) && c.id > m ? c.id : m), 0);
  const maxSunday = comments.reduce((m, c) => (summon(c.body) && c.id > m ? c.id : m), 0);
  return maxSunday > maxMarker;
}

export type IssueAction = "admit" | "summon" | "skip";

/** What reconcile does with one admissible-or-not open issue. On boot NOTHING is
 *  genuinely in-flight, so — unlike the live handler, which skips an in-flight
 *  claim as a duplicate — an `in-flight` state here is an orphaned crash and
 *  re-admits (restarting from scratch; the session was never persisted). `done`
 *  is finished and `awaiting-human` is the gate pass's job, so both skip. `failed`
 *  and fresh re-admit. A non-admissible issue short only its trigger labels but
 *  carrying a human @sunday is a missed summon. */
export function issueAction(
  admitted: boolean,
  missingTriggersOnly: boolean,
  prior: { status: IssueStatus } | undefined,
  hasSunday: boolean,
): IssueAction {
  if (admitted) {
    return prior && (prior.status === "done" || prior.status === "awaiting-human") ? "skip" : "admit";
  }
  if (missingTriggersOnly && hasSunday) return "summon";
  return "skip";
}

// ── I/O orchestration (reads GitHub; drives the live callbacks) ──────────────

export interface ReconcileDeps {
  repos: Record<string, RepoConfig>;
  /** The live label-admission check (from listen.mts) — reused so reconcile and
   *  the webhook path can't diverge. */
  admitIssue: (repo: string, labels: string[], table: Record<string, RepoConfig>) => { admit: boolean; reason?: string };
  admitOrDefer: (fullName: string, cfg: RepoConfig, issue: string) => void;
  summon: (fullName: string, cfg: RepoConfig, issue: string, labels: string[]) => void;
  resumeGate: (fullName: string, cfg: RepoConfig, issue: string, sessionId: string, reply: string) => void;
  enqueuePrComments: (fullName: string, cfg: RepoConfig, pr: string) => void;
  reconcileRestacks: (fullName: string, cfg: RepoConfig) => void;
}

/** Re-derive and re-enqueue every outstanding piece of work from GitHub. Runs
 *  once on boot. Each pass is isolated so a failure in one repo/pass doesn't abort
 *  the rest — GitHub stays the truth, so the next restart tries again. */
export function reconcile(deps: ReconcileDeps): void {
  const names = Object.keys(deps.repos);
  console.log(`⟲ reconcile: re-deriving pending work from GitHub for ${names.length} repo(s)…`);
  for (const fullName of names) {
    const cfg = deps.repos[fullName];
    const childDir = resolve(parentRoot, cfg.path);
    safe(`issues ${fullName}`, () => reconcileIssues(fullName, cfg, childDir, deps));
    safe(`gates ${fullName}`, () => reconcileGates(fullName, cfg, childDir, deps));
    safe(`pr-comments ${fullName}`, () => reconcilePrComments(fullName, cfg, childDir, deps));
    safe(`restacks ${fullName}`, () => deps.reconcileRestacks(fullName, cfg));
    safe(`branches ${fullName}`, () => reconcileBranches(fullName, childDir));
  }
  console.log("⟲ reconcile: done.");
}

function safe(label: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.log(`✗ reconcile ${label}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** New labelled issues + orphaned `agent-working` + the deferred set + missed
 *  @sunday summons — all fall out of one open-issue scan run through the same
 *  admission the webhook path uses. */
function reconcileIssues(fullName: string, cfg: RepoConfig, childDir: string, deps: ReconcileDeps): void {
  const issues = JSON.parse(
    sh("gh", ["issue", "list", "--state", "open", "--json", "number,labels", "--limit", "200"], childDir),
  ) as { number: number; labels: { name: string }[] }[];

  for (const it of issues) {
    const issue = String(it.number);
    const key = `${fullName}#${issue}`;
    let labels = it.labels.map((l) => l.name);

    // A lingering `agent-working` is orphaned by definition — boot means nothing
    // is in-flight. Clear it (admission rejects the claim) so the issue can be
    // reconsidered; state below decides whether it actually re-runs.
    if (labels.includes("agent-working")) {
      sh("gh", ["issue", "edit", issue, "--remove-label", "agent-working"], childDir);
      console.log(`  ⟲ reconcile: cleared orphaned agent-working on ${key}`);
      labels = labels.filter((l) => l !== "agent-working");
    }

    const decision = deps.admitIssue(fullName, labels, deps.repos);
    const prior = getIssue(key);
    const missingTriggersOnly =
      !decision.admit && (decision.reason ?? "").startsWith("missing trigger label");
    const hasSunday = missingTriggersOnly && hasHumanSunday(fullName, childDir, issue);

    switch (issueAction(decision.admit, missingTriggersOnly, prior, hasSunday)) {
      case "admit":
        deps.admitOrDefer(fullName, cfg, issue);
        break;
      case "summon":
        console.log(`  ⟲ reconcile: replaying missed @sunday summon on ${key}`);
        deps.summon(fullName, cfg, issue, labels);
        deps.admitOrDefer(fullName, cfg, issue); // don't wait for the labeled webhook
        break;
      // "skip": already in-flight/done/awaiting-human, or not ours — leave it.
    }
  }
}

/** Any open issue with a human @sunday comment (the missed-summon signal). */
function hasHumanSunday(fullName: string, childDir: string, issue: string): boolean {
  const bodies = JSON.parse(
    sh("gh", ["api", `repos/${fullName}/issues/${issue}/comments`, "--jq", "[.[] | .body]"], childDir),
  ) as string[];
  return bodies.some((b) => isSummon(b));
}

/** Gated issues (`awaiting-human` + a `sessionId`) whose human replied while we
 *  were down → resume with that reply. The sessionId comes from the durable state
 *  save-data; the reply is re-read from GitHub. */
function reconcileGates(fullName: string, cfg: RepoConfig, childDir: string, deps: ReconcileDeps): void {
  for (const [key, s] of Object.entries(readState())) {
    if (s.status !== "awaiting-human" || !s.sessionId) continue;
    const hash = key.lastIndexOf("#");
    if (hash < 0) continue;
    const issue = key.slice(hash + 1);
    if (key.slice(0, hash) !== fullName || !/^\d+$/.test(issue)) continue; // this repo; issue keys only
    const comments = JSON.parse(
      sh("gh", ["api", `repos/${fullName}/issues/${issue}/comments`, "--jq", "[.[] | { id, body }]"], childDir),
    ) as CommentRef[];
    const reply = pickResumeReply(comments, SUNDAY_MARKER);
    if (reply) {
      console.log(`  ⟲ reconcile: resuming gated ${key} — human replied while down`);
      deps.resumeGate(fullName, cfg, issue, s.sessionId, reply);
    }
  }
}

/** Open PRs with an @sunday mention we never answered → run the PR-comment fix.
 *  Checked per comment stream (conversation vs inline) so the monotonic-id compare
 *  stays within one id space and old, answered mentions never re-fire. */
function reconcilePrComments(fullName: string, cfg: RepoConfig, childDir: string, deps: ReconcileDeps): void {
  const prs = JSON.parse(
    sh("gh", ["pr", "list", "--state", "open", "--json", "number", "--limit", "100"], childDir),
  ) as { number: number }[];

  for (const p of prs) {
    const pr = String(p.number);
    const conv = JSON.parse(
      sh("gh", ["api", `repos/${fullName}/issues/${pr}/comments`, "--jq", "[.[] | { id, body }]"], childDir),
    ) as CommentRef[];
    const inline = JSON.parse(
      sh("gh", ["api", `repos/${fullName}/pulls/${pr}/comments`, "--jq", "[.[] | { id, body }]"], childDir),
    ) as CommentRef[];
    if (
      hasUnaddressedSunday(conv, SUNDAY_MARKER, isSummon) ||
      hasUnaddressedSunday(inline, SUNDAY_MARKER, isSummon)
    ) {
      console.log(`  ⟲ reconcile: unanswered @sunday on PR #${pr}`);
      deps.enqueuePrComments(fullName, cfg, pr);
    }
  }
}

/** Sweep local `feat/*` branches whose PRs are all terminal (merged/closed) — the
 *  terminal-branch cleanup a `pull_request.closed` fired while we were down. Keeps
 *  a branch with an open PR (active) or none yet (unpushed) and, critically, a
 *  gated branch (`awaiting-human` = the only copy of its commits; resume needs it). */
function reconcileBranches(fullName: string, childDir: string): void {
  for (const branch of localFeatBranches(childDir)) {
    const issue = branch.slice("feat/".length);
    if (getIssue(`${fullName}#${issue}`)?.status === "awaiting-human") continue;
    const prs = JSON.parse(
      sh("gh", ["pr", "list", "--head", branch, "--state", "all", "--json", "state", "--limit", "10"], childDir),
    ) as { state: string }[];
    if (prs.length === 0) continue; // never pushed a PR → could be pre-push work; keep
    if (prs.some((p) => p.state.toLowerCase() === "open")) continue; // active PR → keep
    deleteLocalBranch(childDir, branch);
  }
}
