# PR stacking is kept, anchored on a stored fork point

A dependent issue whose blocker has an open PR branches off that blocker's branch and
targets it, rather than waiting for the blocker to merge. This is the single most
intricate part of Sunday — roughly 500 lines of dependency reading, cascade rebasing
and in-sandbox conflict resolution — and dropping it was seriously considered during
the rewrite. Deferring instead would have deleted all of it, but it puts human
review latency on the critical path: a chain of three dependent issues could not
start work until each PR before it had been reviewed and merged. Throughput won.

Stacking is kept, but the fragility that motivated dropping it is fixed at the root.
v1 used the **blocker's final tip** (from the merge webhook payload) as the rebase
upstream. Sunday stores the **fork point** — the commit the dependent actually branched
from, captured at branch creation — in the dependent's durable state.

## Considered options

**Defer until the blocker merges.** Deletes the restack cascade, the conflict-fix
agent, the second scheduler lane, the per-branch lock, and every stacked-base race.
Rejected because dependent work would serialise behind human review.

**Per-repo opt-in flag.** Rejected as strictly worse than either: it keeps all the
code and adds a branch, giving two paths to test instead of one.

## Consequences

- The fork point is anchored in the dependent's *own* ancestry, so it survives the
  blocker's branch being deleted on merge (true on two of three routed repos) and
  survives the blocker being force-pushed. The final-tip approach survives neither —
  after a force-push it silently replays the blocker's old commits onto the dependent
  and force-pushes the result.
- Durable state lives under `var/`, but it is still disposable by design. The
  permanent `refs/pull/<n>/head` ref stays as the recovery path when a fork point
  cannot be read back.
- These are merge-race code paths that are hard to trigger by hand, so the rewrite adds a
  local bare-origin git fixture harness. Merge, squash-merge, branch deletion and
  force-push become scripted scenarios in a temp directory — no Docker, no agent, no
  network. Confidence here has to come from tests, not from argument.
