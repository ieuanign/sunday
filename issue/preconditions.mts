// issue/preconditions.mts — what a run ASSERTS before it starts, and re-asserts before
// it ships (#38). A whole queue wait elapses between the Assignor's admission decision
// and the child's first line, and a whole agent run elapses between the agent starting
// and the host pushing: in either window the issue can be closed, its trigger label
// pulled, a pull request opened for its branch, or its base merged and deleted. This is
// where the run stops trusting what it was handed.
//
// Pure decisions over injected services, like `issue/index.mts` itself: no path is
// resolved, no file opened and no service constructed here, which is what lets all six
// assertions be driven with no git, no gh, no docker and no network.
//
// Every one of them fails CLOSED. A read that throws is not "the condition holds" — it
// leaves this module as a throw, and the run's own catch records it as the ordinary
// failure it is, which is how a dead docker daemon stays a pipeline-wide incident
// instead of one repo's missing image.

import type { Outcome, OutcomeStatus, PreconditionReason } from "#lib/outcome.mts";
import type { Git } from "#services/git.mts";
import type { GitHubRun, RunIssueDetail } from "#services/github/index.mts";
import type { IssueRunInput } from "./index.mts";

/** Is this repo's sandbox image on the host? A plain function, injected, so nothing in
 *  `issue/` imports the sandbox library or names one of its types (#34 constraint 7) —
 *  and so a smoke answers it without docker. `services/sandbox.mts` implements it. */
export type ImagePresent = (imageName: string) => Promise<boolean>;

/** The world the before-work set asks, and NOTHING more: two reads and a probe. Narrow
 *  deliberately, the way the GitHub seams are — this runs before a run has committed to
 *  anything, so a wider seam here is a wider set of writes a refusal could make. */
export interface PreconditionDeps {
  github: Pick<GitHubRun, "openPrForHead">;
  git: Pick<Git, "remoteBranchExists">;
  imagePresent: ImagePresent;
}

/** What each reason MEANS, spelled ONCE: how the work item ends, and the sentence the
 *  human reads on the issue thread. The reason→status map lives HERE rather than in the
 *  Assignor because the CHILD reports what a run ended as and the parent records what
 *  the child reported — two readings of that is the drift this rewrite exists to kill.
 *
 *  `pull-request-open` is the one `done`: a pull request for this issue's branch is
 *  already serving the issue, so re-forking the item on every reconcile would post a
 *  second comment and spend a second agent run to arrive back here. The other four are
 *  `failed` — and safe as one, because nothing re-admits an item whose condition still
 *  holds (a closed issue is not listed, an unlabelled one is refused by admission). */
const STOPS: Record<PreconditionReason, { status: OutcomeStatus; says: string }> = {
  "issue-closed": { status: "failed", says: "the run did not start: the issue is no longer open" },
  "labels-missing": { status: "failed", says: "the run did not start: the trigger label(s) it was admitted on are no longer on the issue" },
  "pull-request-open": { status: "done", says: "the run did not start: a pull request for this issue's branch is already open" },
  // Phase-neutral, because both phases report it and the detail says which: before the
  // run, nothing was started; after the agent, nothing was pushed.
  "base-missing": { status: "failed", says: "the base branch is gone from the origin" },
  "image-missing": { status: "failed", says: "the run did not start: this repo's sandbox image is not on this host" },
};

/** The outcome a stopped run hands back — the SAME durable outcome every other ending
 *  returns (ADR-0001), carrying the typed reason beside the prose. Never a throw and
 *  never an exit code of its own: the parent applies from the file, and it reacts to
 *  each reason on its own terms rather than pattern-matching a summary Sunday composed.
 *
 *  `Omit<Outcome, "finishedAt">` because the run stamps that, as it does for every other
 *  ending it returns. */
function stop(key: string, reason: PreconditionReason, detail: string): Omit<Outcome, "finishedAt"> {
  const { status, says } = STOPS[reason];
  return { key, status, summary: `${says} — ${detail}.`, precondition: reason };
}

/** The five assertions a run makes BEFORE it writes anything: no label removed, no
 *  `.git/info/exclude` appended, no fetch, no agent. Answers the outcome that ends the
 *  run, or `undefined` to carry on.
 *
 *  In cost order — the two off the issue the run already read are free, then a `gh`
 *  read, then the origin, then docker — so an item that must not start spends as little
 *  as the answer allows.
 *
 *  It does NOT re-run `admitIssue` (constraint 2): that refuses on the claim label, and
 *  the Assignor applied exactly that to this item before forking it. What can change
 *  under a queued item is its state and its trigger labels, and those are what this asks. */
export async function beforeWork(
  deps: PreconditionDeps,
  input: IssueRunInput,
  branch: string,
  issue: RunIssueDetail,
): Promise<Omit<Outcome, "finishedAt"> | undefined> {
  // What was READ rather than "closed": the state is normalised in `Gh` and anything
  // that is not `open` is a run that must not start, whatever GitHub called it.
  if (issue.state !== "open") return stop(input.key, "issue-closed", `state: ${issue.state}`);
  // ALL of them, as admission required them (AND), and WHICH ones are gone travels in the
  // summary: "a trigger label is missing" sends the human looking for which.
  const missing = input.triggerLabels.filter((label) => !issue.labels.includes(label));
  if (missing.length > 0) return stop(input.key, "labels-missing", `missing: ${missing.join(", ")}`);
  // The same read #36's ship-time adoption performs, asked at the other end of the run:
  // adoption is for a PR that appears WHILE the agent works (the create racing), and this
  // is for one that was already there before it started — a second run on it would spend
  // an agent to arrive at a pull request the issue already has.
  const open = await deps.github.openPrForHead(input.repo, branch);
  if (open) return stop(input.key, "pull-request-open", open);
  // The ORIGIN, before the fetch that would create the local ref: a base that merged and
  // was deleted while this item waited is gone from GitHub, which is where the PR this
  // run is heading for has to target it.
  if (!(await deps.git.remoteBranchExists(input.childDir, input.base))) {
    return stop(input.key, "base-missing", `${input.base}, and nothing was started`);
  }
  // Last, because it is the only one that asks the host rather than GitHub: boot built
  // this image and hours of queue can pass before the item runs — long enough for a
  // prune to take it, which the agent library reports as an obscure container error.
  if (!(await deps.imagePresent(input.imageName))) return stop(input.key, "image-missing", input.imageName);
  return undefined;
}

/** The ONE assertion a run makes again immediately before it pushes: is the base still
 *  there? A whole agent run has elapsed since the check above and since the fetch — the
 *  captured 2026-07-25 race merged an item's base 25 seconds after its `fetch -p` and
 *  three minutes before its create — so the local `origin/<base>` this run measured
 *  against is minutes stale and the ORIGIN is what a pull request has to target.
 *
 *  A refusal here ships NOTHING: no push, no create, and no retarget to `main` either. A
 *  branch stacked on a base that merged has to be REBASED onto its new base before it can
 *  target it (ADR-0003: v1 retargeted naively, which after a squash merge shows the
 *  blocker's commits as the dependent's own), and rebasing is #43's machinery, not a
 *  run's. It costs this run's commits — one agent run of quota, in a rare race. */
export async function beforeShip(
  git: Pick<Git, "remoteBranchExists">,
  input: IssueRunInput,
): Promise<Omit<Outcome, "finishedAt"> | undefined> {
  if (await git.remoteBranchExists(input.childDir, input.base)) return undefined;
  return stop(
    input.key,
    "base-missing",
    `${input.base} went while the agent worked, so nothing was pushed and no pull request was opened`,
  );
}
