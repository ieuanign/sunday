# Architecture — the Sunday pipeline

> **Design phase.** Nothing here is built yet. This document ports a design reached through
> a grilling session into the template. The load-bearing [Sandcastle](https://github.com/mattpocock/sandcastle)
> assumptions (git isolation via `run({cwd})`, branch strategy with a non-`main` base,
> session capture/resume) are **unverified** and should be spiked before anyone bets the
> pipeline on them. Concrete choices below (a Go/mysql/redis child, an Ubuntu mini-PC host)
> are **examples/defaults** for one instance, not requirements of the template.

## What this is

A local, event-driven pipeline that turns GitHub issues into autonomous, sandbox-isolated
code implementations that open PRs. It runs on **your** hardware, not GitHub Actions.

## Chosen shape

```
GitHub issue (labelled)
   → gh webhook forward   GitHub → your machine (relay; no public server, no cron)
   → listener             Node process: routes repo → config, enforces concurrency
   → sandcastle.run({ cwd: repos/<child> })
   → Docker sandbox       headless coding agent implements the issue
   → push + open PR        to the child repo's own origin
```

- **`gh webhook forward`** relays GitHub events to the local listener over an authenticated
  channel — no inbound port, no public server. It has **no replay**; reconcile-on-restart
  (below) compensates for anything missed while down.
- **The listener** is a single long-running Node process. One async loop serializes all
  admission checks (avoids double-launch races), routes `repository.full_name` → child
  config, enforces the global concurrency cap, and invokes Sandcastle.
- **Sandcastle** runs the coding agent in a Docker sandbox and merges its git work back.
  `run({ cwd: repos/<child> })` is expected to make every git op — including **push** —
  resolve to the child's `.git`/`origin`.
- **The sandbox** is per-child (`repos/<child>/.sandcastle/Dockerfile`), running a non-root
  `agent` user. Its `onSandboxReady` hook boots whatever services the child's tests need
  (*example:* a Go + mysql + redis child seeds a test DB and starts redis before the agent
  runs).

## Trigger

Two labels required (**AND**), fired on the second label:

- **`ready-for-agents`** — the issue is spec-ready.
- **`auto-dev`** — automate it.

Parents/trackers are never auto-dev'd — see *Dependency DAG*.

### Event sources

| Event | Purpose |
|---|---|
| `issues` (labeled) | admission trigger |
| `issue_comment` | the human gate (see below) |
| `pull_request` (closed + merged) | triggers restack of dependents |

## Label state machine

GitHub labels are the **human-visible source of truth**.

```
ready-for-agents + auto-dev   (admitted)
        → agent-working
            ├── awaiting-human   gate: agent asked a question, resumes on reply
            ├── agent-failed     could not reach green: draft PR + diagnosis, manual retry
            └── PR opened        clean pass
```

- `auto-dev` stays until the PR merges.
- Reconcile skips issues in `agent-working` / `awaiting-human` / `agent-failed` / with an
  open agent PR.

## In-sandbox discipline

Every run injects a fixed baseline: **plan → test-first implementation → review →
debug-on-red → sign-off → PR**, bounded at **2 fix attempts per finding**, always deferring
to the child repo's own rules. The full prompt is [`sandbox-prompt.md`](sandbox-prompt.md).

## Dependency DAG & stacking

- **Dependencies** = the union of native GitHub sub-issues/dependencies + a `Depends on #X`
  body convention. **Hierarchy groups but does not block**; leaves are the unit of work;
  parents are trackers, never auto-dev'd.
- **Stacking:** issue *A* starts once blocker *B*'s **draft PR is open**; *A* branches from
  *B*'s head and its PR targets *B*'s branch.
- **On *B* merge:** an agent runs `git rebase --onto main <B-ref> A`, retargets *A*'s PR base
  to `main`, and cascades up the chain.
- **Global invariant: rebase only, never merge.** History stays linear; PR merges are
  squash/rebase.
- **Rebase conflicts:** the agent resolves them; if it cannot (within the fix bound), it
  stops and opens the human gate.

## Concurrency

**Global cap (default 3)** — a semaphore across *all* repos, because every run shares one
agent quota (see *Auth*). Not per-repo. Set via `MAX_CONCURRENCY` in `.env`.

## Human gate

The **issue comment thread is the gate.** When a run needs a human, the agent:

1. posts its question plus a hidden marker — `<!-- sandcastle:awaiting … -->`,
2. applies the `awaiting-human` label,
3. exits.

Your plain-English reply is picked up by the listener, which **resumes the captured session**
(Sandcastle session capture/resume) and clears the label.

## Failure handling

If a run cannot reach green within its fix bounds, it pushes WIP, opens a **draft PR** with a
diagnosis comment, and applies **`agent-failed`**. No auto-resume — this is a deliberate
handoff to a human, retried by relabelling.

## PR output

- **Ready** on a clean pass with a clean sign-off (including clean stacked PRs on an as-yet
  unmerged base).
- **Draft** on any doubt or open gate.

## State & recovery

- **GitHub labels + hidden comment markers** = the durable, human-visible truth.
- **`.scratch/` at the workspace root** = the listener's operational tracking (in-flight
  set, `session_id`, branch, last-seen comment id), keyed by `(repo, issue#)`, written
  temp-then-rename. Form: **JSON** (recommended over SQLite for this size).
- **Double-launch guard:** a claim label (`agent-working`) + the in-flight set, both checked
  on the single serializing loop.
- **Reconcile-on-restart:** re-derive *all* pending work from GitHub — new issues, missed
  gate replies, missed PR-merge restacks, orphaned `agent-working`. Because GitHub is the
  truth, an outage is a *delay, not a loss*; total host loss is recoverable.

## Multi-repo layout

```
sunday/                       parent workspace (this repo)
├── listener/                 one listener process for the whole workspace
├── config/                   repository.full_name → { path, imageName, promptFile, labels }
├── .scratch/                 operational tracking (gitignored)
└── repos/                    child clones (gitignored)
    ├── <child-a>/            own origin, own .sandcastle/, own image, own rules
    └── <child-b>/
```

The parent holds **one** Sandcastle install, the listener, config, and `.scratch`. Children
are independent clones with their own `origin` and `.sandcastle/`. The concurrency cap is
global across the workspace.

## Host & supervision

- **Toolchain:** provisioned by `devbox.json` (node, gh, git, …), identical on macOS and
  Linux. Docker's daemon is a separate host-level install.
- **Process supervision:** a supervisor keeps the listener and the per-repo `gh webhook
  forward` running — **systemd** on Linux (the reference host), **launchd** or a foreground
  process on macOS for development.
- **Reference host:** an always-on Linux box (*example:* an Ubuntu mini-PC).

## Auth

Agent-agnostic. **Claude is the default** (auth via a Max subscription token —
`claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN` in the sandbox — for $0 marginal cost, or an
API key). Configured in `.env` (`AGENT`, `MODEL`, `MODEL_EFFORT`, and the auth var). All runs
share one quota, which is why the concurrency cap is global.

> A subscription-token automation path may warrant checking the agent vendor's current terms.

## Open questions

Carried from design; resolve before/while building:

1. **Forwarding shape** — personal account (per-repo templated `--repo` forwarders) vs org
   (one `--org` forwarder, `admin:org_hook` scope)?
2. **Redis wiring** — confirm the exact auth/config a given child's test suite expects for
   the in-sandbox redis.
3. **Per-child `.sandcastle` resolution** — does the installed Sandcastle `run()` read
   `cwd/.sandcastle`, or must the listener pass explicit `promptFile`/`imageName`? Verify
   against the pinned version.

## Accepted risks

- **Quota ceiling** — ~5 agents/issue × cap 3, plus rebase agents, on one shared plan may hit
  rate limits; levers: lower the cap, thin the roster.
- **Ready stacked PRs on unreviewed bases.**
- **Sandcastle is early / solo-maintained** — spike before committing.
- **`gh webhook forward` has no replay** — reconcile compensates.
