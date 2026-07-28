# Architecture — the Sunday pipeline

> **Status: pipeline built (M1–M5), live-hardening in progress.** This is the design of record —
> *why* the pipeline has the shape it has — written from the code and the ADRs. Running it,
> watching it and tuning its cost belong to [`supervision.md`](supervision.md),
> [`operability.md`](operability.md) and [`resource-management.md`](resource-management.md); the
> ordered build record is [`implementation-plan.md`](implementation-plan.md).

## What this is

A local, event-driven pipeline that turns GitHub issues into autonomous, sandbox-isolated
code implementations that open PRs. It runs on **your** hardware, not GitHub Actions.

## Chosen shape

```
GitHub event
   → gh webhook forward   one per routed repo, started in-process by the parent
   → receiver :8787       local only — no public endpoint, no replay
   → Assignor             route · admit · resolve base · claim · enqueue
   → scheduler            regular lane, cap 3, per-branch lock
   → fork issue/run.mts | pr/run.mts        one child process per work item (ADR-0001)
   → Docker sandbox       credential-free; the agent implements and commits locally
   → the host pushes, opens the PR, comments and labels
   → var/results/<key>.json  →  the parent applies it
```

- **The forwarders** are `gh webhook forward`, one per routed repo, started **in-process by the
  parent** and relaying to the local receiver on `SUNDAY_PORT` (default 8787). No inbound port, no
  public server. There is **no replay** — a *blackout* is re-derived afterwards (*State &
  recovery*).
- **The parent** (`main.mts`) is a singleton. It owns the services, the Assignor, the queue and both
  ends of the event pipe, and it **owns no work**: every work item runs in a forked child
  ([ADR-0001](adr/0001-fork-per-work-item.md)), so a synchronous `gh` or `git` call blocks only that
  child and never the socket the parent answers on.
- **Two work-item lanes, one scheduler.** An **issue run** (`issue/`) takes one issue from admission
  to a pull request; a **PR-comment run** (`pr/`) addresses the outstanding `@sunday` summons on one
  pull request. Distinct work-item keys, distinct workers, the same queue, cap and branch lock.
- **The sandbox is credential-free.** It is per-child (`repos/<child>/.sandcastle/Dockerfile`,
  running a non-root `agent` user) and what it contains is that child's own `.sandcastle/`'s to
  decide — onboarding is in [`README.md`](../README.md#onboarding-a-repo). The agent decides and
  **commits locally**; the **host** performs every push, pull request, comment and label.

## Trigger

**Trigger labels are per-repo**, from `config/repos.json`'s `triggerLabels`, and **all** of a repo's
must be present (AND). The shipped example is `ready-for-agent` + `auto-dev`.

Admission refuses in order: an unrouted repo, an issue already carrying the claim label, a **`spec`**
(the shape of a feature — its child issues are the work), then any missing trigger label. The spec
check precedes the trigger check deliberately: a mislabelled spec is refused whatever else is on it.

### Event sources

| Event | Purpose |
|---|---|
| `issues` | admission on `opened` / `reopened` / `labeled`; a `closed` one re-evaluates what was deferred on it |
| `issue_comment` | on a **pull request** → a PR-comment run; on an **issue** → a gate reply |
| `pull_request_review_comment` | an inline `@sunday` on the Files-changed tab → a PR-comment run |
| `pull_request` | `opened` / `reopened` / `closed` re-evaluates deferred items; a `closed` **merged** one also drives the restack |

## Label state machine

GitHub labels are the **human-visible source of truth**.

```
trigger labels (all), no claim, not a spec   (admitted)
        → agent-working
            ├── awaiting-human   gate: the agent asked a question, resumes on the reply
            ├── quarantined      failed twice: set aside for a human, everything else runs on
            ├── agent-failed     the agent's own verdict: draft PR + diagnosis. Nothing retries
            │                    it — a human removes the label to hand it back
            └── PR opened        ready on a clean sign-off, draft on anything else
```

- Trigger labels stay until the PR merges.
- **What stops a second start is not a label list.** It is three things together: the claim label
  `agent-working`, the durable record in `var/state.json`, and a live PID lock in `var/running/`.
  Reconcile releases a stale claim only when no process is on the item.
- **The parked labels are the exception.** `quarantined` and `agent-failed` are refused before
  anything starts, so no boot sweep, blackout catch-up or re-label runs one again. Taking the label
  off is the release signal; the item comes back on the next trigger re-label or reconcile pass —
  or straight away from the phone, where `/fix <owner>/<repo>#<n> [steer]` takes the label off and
  hands the item back through admission with a note for the agent
  ([`operability.md`](operability.md#commands)).

## Preconditions

A whole queue wait separates admission from the child's first line, and a whole agent run separates
that first line from the push — so a run **re-asserts its invariants** rather than trusting the
state it was handed (`CONTEXT.md`).

- **Before it writes anything**, five assertions in cost order: the issue is still open, every
  trigger label is still present, no pull request is already open for its branch, the base still
  exists **on the origin**, and the sandbox image is still on the host.
- **Before it ships**, one more — is the base still there? Minutes of agent run have passed since
  the fetch, and the origin is what a pull request has to target.
- Every assertion **fails closed**: the run ends with a durable outcome naming which invariant went,
  and nothing is pushed.

## In-sandbox discipline

Every run injects a fixed baseline: **plan → test-first implementation → review →
debug-on-red → sign-off → PR**, bounded at **2 fix attempts per finding**, always deferring
to the child repo's own rules. The full prompt is [`sandbox-prompt.md`](sandbox-prompt.md).

Those phases dispatch to Sunday's **floor** — the sub-agents and skills assembled per run and
mounted into the sandbox, which a child's own `.claude/` overrides
([`resource-management.md`](resource-management.md)).

## Dependency DAG & stacking

- **Blockers** are GitHub's **native dependency links**, falling back — only where a repo populates
  none — to a **`## Blocked by` heading** in the issue body. Heading-scoped deliberately: prose that
  happens to say "blocked by" is not a dependency.
- **A read that failed is not an answer.** Unreadable blockers — a failed request, or a heading
  naming something this repo cannot resolve — **defer**, never admit. Every unknown here resolves
  toward waiting, because the alternative starts a real agent run on a wrongly-chosen base.
- **More than one open blocker → defer.** A branch has one base, and picking either would ship the
  other's work unreviewed.
- **Stacking:** one open blocker whose **PR is open** → the dependent branches off `feat/<blocker>`
  and its PR targets that branch. No open PR yet → defer; there is nothing worth forking from.
- **On the blocker's merge**, the **parent** drives the restack, off the dependent's **stored fork
  point** and never the blocker's tip ([ADR-0003](adr/0003-keep-pr-stacking.md)). Each step replays
  `forkPoint..HEAD` onto the new base in a detached worktree under `var/restack/`, pushes
  `--force-with-lease`, retargets the PR, and cascades parent-before-child.
- **Global invariant: rebase only, never merge.** History stays linear; PR merges are
  squash/rebase.
- **A conflict gates the PR.** The step stops there — nothing is pushed, the branch has not moved —
  and the PR gets `awaiting-human` plus a comment saying what conflicted. A human rebases by hand.
  There is no in-sandbox conflict-fix agent.

## Concurrency

**Two lanes.** Regular runs (issue + PR-comment) share a **global cap (default 3)** — a semaphore
across *all* repos, because every run shares one agent quota (see *Auth*). Not per-repo. Set via
`MAX_CONCURRENCY` in `.env`.

**Restack work runs in a separate, *uncapped* lane** — a queue of per-branch steps walked
parent-before-child. Uncapped because a restack unblocks a stuck merge and conflicts are rare
(concurrent fresh sessions are fine on the Max plan).

**One shared, two-way per-branch lock** spans both lanes: neither lane touches a branch while the
other is on it. A restack step waits on a busy branch; a regular run whose branch has a restack in
flight is skipped and retried when it frees. Draining is event-driven — the moment any run finishes.

A slot and its branch lock are held for the **forked child's whole life**, not just for the fork
call: the work item settles when the child exits.

## Human gate

The **issue comment thread is the gate.** When a run needs a human, the agent:

1. posts its question with a **dual sign** — a hidden marker `<!-- sunday:gate -->` (so Sunday
   skips its own comment rather than answering itself) plus a visible header
   (`🤖 **Sunday** · autonomous agent`) so a human can tell the agent authored it (Sunday and you
   post under the same account). The visible attribution also marks the PR body.
2. applies the `awaiting-human` label,
3. exits.

Your plain-English reply is picked up by the **Assignor**, which re-forks the run with the
`sessionId` held in `var/state.json` and clears the label.

A **second marker**, `<!-- sunday:reply -->`, rides only on comments that *answer* a summon — how a
PR-comment run tells an answered summon from an outstanding one. Sunday's milestone comments land on
the same thread, and judged by the first marker alone one of those would bury a summon forever.

## Failure handling

Every failure carries a **scope**, not a severity that means halt — what recognises each class, and
what an operator then sees, is [ADR-0002](adr/0002-failure-scope-not-global-halt.md) and
[`operability.md`](operability.md).

- **`pipeline`** — a spent **quota**, a refused **credential**, and a dead container daemon. Only
  these three stop everything, because every run would fail identically. A quota that named its
  reset lifts itself shortly after it; one that did not waits for a human.
- **`repo`** — a sandbox image that cannot be built or created. That **one repo** stops and every
  other keeps running. It rechecks itself on a timer and, when the image builds clean, re-derives
  that repo's outstanding work through the same per-repo pass a blackout uses.
- **`item`** — only this work item is stuck. It gets **one** retry (an `unknown` carries its own
  error back into the next run's prompt; a `transient` carries nothing — somebody else's 502 in the
  prompt is noise). An `unknown` that then fails the same way is **quarantined**: labelled,
  notified, and left untouched until a human removes the label. A `transient` is not — a blip is
  nothing to set aside, so it stops at `failed`, unlabelled, and the next reconcile re-admits it.
  Everything else keeps running.
- **`run-failed`** is the agent's own verdict and the one item-scope class with no retry — it ran,
  and a second run would spend real quota re-deciding what it already decided. It gets
  `agent-failed`, which admission then refuses, and the human is told wherever they are standing —
  the notification carries the agent's own diagnosis of what it failed on, and names the label to
  remove to hand it back.

## PR output

- **Ready** on a clean pass with a clean sign-off (including clean stacked PRs on an as-yet
  unmerged base).
- **Draft** on any doubt or open gate.

## State & recovery

- **GitHub is the truth.** Labels and hidden comment markers are the durable, human-visible record;
  everything below is re-derivable from them.
- **`var/` is the durable state root** (layout under *Process & state model*). **`.scratch/` is
  throwaway** — the only thing in it is the floor assembled for a run, and it is `rm -rf`-able at
  any time.
- **Double-launch guard:** the claim label, the durable record in `var/state.json`, and a live PID
  lock in `var/running/`.
- **A child outlives its parent by design.** It writes its outcome to `var/results/` *before* it
  reports, so the next boot's sweep applies whatever finished and **adopts** the survivors still
  holding a lock — a parent that dies mid-run loses nothing.
- **Reconcile** re-derives both halves — every open issue, and every open pull request carrying an
  unanswered summon — and hands each to the **same admission seam** a live delivery goes through, so
  the recovery path cannot drift from the live one.
- **A blackout** is what a dropped forwarder means: GitHub replays nothing. A respawned forwarder
  catches its own repo up, and boot's reconcile covers whatever was missed while the parent was
  down. An outage is a *delay, not a loss*.

## Resource management

Cost per run is tuned in three places, all of them
[`resource-management.md`](resource-management.md)'s:

- The **floor** — Sunday's sub-agents and skills, each carrying the per-phase model/effort row
  `config/roster.json` gives it — is assembled per run and mounted into the sandbox. A child repo's
  own `.claude/` overrides it by presence, so it is a floor and not an override.
- The **token report** is host-side and free (no dollar figures anywhere), and lands under
  `var/log/<owner>/<repo>/token-report/`.
- The context-threshold **[handoff](resource-management.md#handoff-at-threshold)** keeps a gate
  cycle from resuming a session it has outgrown: past `HANDOFF_CTX_THRESHOLD` one bounded turn
  compacts that session into a note, and a fresh one takes the human's reply instead.

## Process & state model

```
sunday                       the parent — singleton: services, Assignor, queue, receiver
├── gh webhook forward       one in-process child per routed repo → the receiver
└── work-item child × ≤ cap  forked per work item: issue/run.mts | pr/run.mts
    └── Docker sandbox       one per run, against repos/<child>, credential-free
```

```
var/                          durable runtime state (gitignored)
├── state.json                per-work-item state — status, session, base, fork point
├── pause.json                why the pipeline is paused, and until when
├── results/<key>.json        a finished child's outcome, for the parent to apply
├── running/<key>.pid         the PID lock a live work item holds
├── restack/<repo>#<branch>/  the detached worktree one restack step rebases in
└── log/
    ├── events.jsonl          append-only: milestones, alerts, errors
    ├── sunday.log            lines with no work item to attribute them to
    ├── <owner>/<repo>/<issue|pr-n>/run.log
    └── <owner>/<repo>/token-report/
```

The parent holds **one** Sandcastle install, the routing table, the floor and `var/`. Children are
independent clones with their own `origin` and their own `.sandcastle/`, and Sunday never tracks
them. The concurrency cap is global across the workspace. The source tree itself is
[`README.md`](../README.md#repository-structure)'s.

## Host & supervision

- **Toolchain:** provisioned by `devbox.json` (node, gh, git, …), identical on macOS and Linux.
  Docker's daemon is a separate host-level install.
- **One supervised host process** under process-compose (`devbox services up`): `restart: always`,
  readiness-probed on the receiver's port. It runs on the host, not in a container, so it spawns
  sandboxes on the host daemon directly.
- **Singleton.** The queue, the claim label and the parent's own children all assume one process —
  the supervisor restarts it on death but never replicates it.
- **It starts its own forwarders**, so there is no second supervised process and no launcher script
  between them. Startup ordering, restart recovery and rollback are
  [`supervision.md`](supervision.md).

## Auth

Agent-agnostic. **Claude is the default** (auth via a Max subscription token —
`claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN` in the sandbox — for $0 marginal cost, or an
API key). Configured in `.env` (`AGENT`, `MODEL`, `MODEL_EFFORT`, and the auth var). All runs
share one quota, which is why the concurrency cap is global.

Agent-agnostic within one limit: the agent must run **headless inside the Docker sandbox**. It lives
behind a seam (`services/agent/index.mts`) that names no library type in its request or its result,
so a second agent is a new file behind that seam rather than a refactor of every caller — but it
still has to be runnable in the box first, which is more than a config line.

> A subscription-token automation path may warrant checking the agent vendor's current terms.

## Accepted risks

- **Quota ceiling** — ~5 agents/issue × cap 3 on one shared plan may hit rate limits; levers: lower
  the cap, thin the roster.
- **Ready stacked PRs on unreviewed bases.**
- **Sandcastle is early / solo-maintained** — and it is a committed dependency
  (`@ai-hero/sandcastle` 0.12.0), not a spike.
- **`gh webhook forward` has no replay** — a **blackout** is re-derived by reconcile and by the
  per-repo catch-up a respawned forwarder runs.
