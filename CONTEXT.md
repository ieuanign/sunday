# Sunday

Sunday turns labelled GitHub issues into sandboxed coding-agent runs that open pull
requests, on your own hardware. This file is the project's shared vocabulary — what
each term *is*, not how it is built.

## Work

**Work item**:
One unit of schedulable work with a stable identity — an issue run or a PR-comment
run. The thing the scheduler queues, dedups, and holds a branch lock for.
_Avoid_: job, task, ticket

**Issue run**:
A work item that takes one issue from admission through to a pull request.

**PR-comment run**:
A work item that addresses the outstanding `@sunday` comments on one pull request.

**Admission**:
The decision that an issue is Sunday's to work — its repo is routed, all of its
trigger labels are present, and it is not already claimed.
_Avoid_: acceptance, intake

**Deferred**:
Admitted in principle but held back because a blocker is not yet satisfied.
Re-evaluated whenever a blocker's state could have changed.

**Milestone**:
A state change in a work item's life that is worth reporting back to the humans
watching the issue or PR.

## Failure

**Failure scope**:
How far a failure reaches — `pipeline` (every run would fail the same way),
`repo` (this child repo is broken), or `item` (only this work item is stuck).
_Avoid_: severity, blast radius

**Quarantine**:
The state of a work item that failed, was retried once with its own error, and
failed again. It is set aside and left untouched until a human releases it. The rest
of the pipeline keeps running.
_Avoid_: blocked, stuck, parked

**Halt**:
A pipeline-scope stop. No new work starts anywhere until it is lifted.
_Avoid_: pause (a pause is a halt that lifts itself at a known time)

**Blackout**:
A period during which GitHub events were not delivered to Sunday. GitHub does not
replay them, so the work they represent must be re-derived afterwards.
_Avoid_: outage, downtime

**Reconcile**:
Re-deriving all outstanding work from GitHub, which is always the source of truth.
Recovers a blackout and rebuilds anything the local state lost.

## Dependencies

**Blocker**:
An issue that must be closed before another issue can proceed.

**Stacking**:
Basing a dependent's branch on its blocker's branch rather than on `main`, so the
dependent can start before the blocker has merged.

**Fork point**:
The commit a stacked branch branched from. Fixed for the life of the branch, and the
boundary between the blocker's commits and the dependent's own.
_Avoid_: base commit, upstream, merge base

**Restack**:
Rebasing a dependent's own commits onto a new base after its blocker merges, and
retargeting its pull request. Cascades to that dependent's own dependents.

## The sandbox

**Sandbox**:
The credential-free container one agent run happens inside. It decides; it cannot
push. The host performs every write to GitHub.

**Floor**:
The discipline — sub-agents and skills — mounted into every sandbox so each run is
held to the same standard regardless of which repo it is working in.

**Gate**:
The agent stopping to ask a human a question, leaving its session open so the human's
reply resumes the same session rather than starting over.

**Handoff**:
Compacting a session that has grown too large into a note that seeds a fresh session,
so long-running work is not capped by one session's context.

**Precondition**:
An invariant a module asserts still holds before it starts work, and again before it
ships. Modules do not trust the state they were handed.

## GitHub surface

**Forwarder**:
One long-lived `gh webhook forward` process relaying a single repo's events to
Sunday. One per routed repo.

**Summon**:
A human writing `@sunday` to hand a piece of work over.

**Spec**:
An issue that describes the shape of a feature rather than a unit of work. Never
implemented directly — its child issues are.
_Avoid_: epic, manifest, tracker

**Marker**:
The hidden comment tag that lets Sunday recognise its own comments, since Sunday and
the human post under the same account.
