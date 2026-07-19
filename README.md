# Sunday

Sunday is a **reusable workspace template** that turns GitHub issues into autonomous,
sandbox-isolated code implementations that open pull requests. It hosts multiple project
repositories under one shared setup and drives them through an event-driven automation
pipeline built on [Sandcastle](https://github.com/mattpocock/sandcastle).

Sunday is **orchestration only**: it owns the GitHub workflow (webhook → listener) and the
Sandcastle automation that runs coding agents in Docker sandboxes. Each hosted repository
owns its own rules — its `CLAUDE.md`, ADRs, and context. Sunday injects a baseline
discipline into every run and otherwise defers to each repo.

> **Status: pipeline implemented (M1–M4), live-hardening in progress.** The listener,
> per-repo routing, the event loop, the human gate, dependency stacking, crash recovery,
> the operability layer (failure taxonomy, quota pause/resume, notifier, per-flow logs,
> `sunday status`, and optional Telegram control), and process supervision are **built and
> smoke-verified**. A few paths are still owed an end-to-end live run (a real quota pause; a
> Telegram command round-trip; a supervised kill → restart → reconcile). The resource/cost
> matrix (M5) is next. See [`docs/architecture.md`](docs/architecture.md),
> [`docs/operability.md`](docs/operability.md), and [`docs/supervision.md`](docs/supervision.md).

## Architecture

A GitHub issue that is labelled ready flows through:

```
GitHub issue (labelled)
   → gh webhook forward   GitHub → your machine (no public server, no cron)
   → listener             routes repo → config, enforces global concurrency
   → sandcastle.run({ cwd: repos/<child> })
   → Docker sandbox       headless coding agent implements the issue
   → push + open PR        to the child repo's own origin
```

Inside each sandbox, the agent follows a fixed discipline — plan → test-first
implementation → review → debug-on-red → sign-off → PR — while obeying the child repo's own
rules. See [`docs/sandbox-prompt.md`](docs/sandbox-prompt.md).

The full design — trigger labels, the label state machine, dependency stacking, concurrency,
and crash recovery — lives in [`docs/architecture.md`](docs/architecture.md).

## Repository structure

Public (tracked) layout:

```
.
├── README.md              this file
├── devbox.json            host toolchain (node, gh, git, …)
├── process-compose.yaml   supervised run stack (listener + webhook-forward) — `devbox services up`
├── .env.example           config template (copy to .env)
├── docs/
│   ├── architecture.md    the pipeline design
│   ├── operability.md     failure handling, notifier, status, Telegram control (M3)
│   ├── supervision.md     running the stack under process supervision (M4)
│   └── sandbox-prompt.md  the baseline injected into every sandbox run
├── .claude/               tracked slice of the discipline floor:
│   ├── agents/            default roster (architecture-engineer, code-writer, reviewer, debugger)
│   └── skills/            roster skills (tdd, code-review-mp, diagnosing-bugs)
├── listener/              the Node webhook listener + orchestration (listen, scheduler,
│                          run-issue, restack, reconcile, classify, notify, telegram, status)
├── config/                per-repo routing (repos.json — gitignored; repos.example.json tracked)
├── scripts/               dev helpers (gen-workspace.sh, webhook-forward.sh)
└── repos/                 child repo clones — gitignored, each its own repo
    └── <child>/           own origin, own .sandcastle/, own rules

At runtime the listener writes gitignored operability artifacts under `.scratch/`:
per-flow logs (`.scratch/<repo>/<issue>/run.log`), the event log
(`.scratch/operability/events.jsonl`), and the pause state (`.scratch/operability/pause.json`).
```

Child repositories live under `repos/` as independent clones — each with its own `origin`,
its own `.sandcastle/Dockerfile`, and its own agent rules. They are **gitignored**: Sunday
never tracks or commits them, and every git operation inside a run resolves to the child's
own `.git`/`origin`, so branches and pushes land in the child, never in Sunday.

### Editor: per-child git status

Because `repos/` is gitignored, editors grey out everything under it — hiding each child's *own*
tracked/ignored status. Give each child its own editor root so decorations follow the **child's**
`.gitignore`, not Sunday's:

- **VS Code / Cursor / Windsurf:** run `scripts/gen-workspace.sh` after cloning a child, then open
  the generated `sunday.code-workspace`. Re-run it whenever you add a child — it rebuilds the roots
  from `repos/`, so you never hand-edit it. (The generated file is gitignored, since it lists your
  child paths.)
- **JetBrains:** add each child under *Settings → Version Control → Directory Mappings*.
- **Any editor:** open the child in its own window, or check `git -C repos/<child> status --ignored`.

## Operability

The listener classifies every failure off the run result, reacts oppositely per class,
records everything durably, and can be watched and steered. Detail + failure-class table:
[`docs/operability.md`](docs/operability.md).

| Feature | What it does | How to use / configure |
| --- | --- | --- |
| **Failure taxonomy** | Classifies each run failure — quota · auth (403) · transient · run-level · unknown — off the run-result *shape*, not exit codes | automatic |
| **Quota pause/resume** | A quota wall pauses **both** lanes and auto-resumes at reset + 5 min; no parseable reset → holds for a human `/resume-at` | automatic; durable across restarts |
| **403 halt** | Aborts every in-flight run and halts; a human re-auths, reconcile re-admits on the next boot | automatic |
| **Transient backoff** | Bounded exponential backoff on 429 / network / 5xx, then the `agent-failed` path | automatic |
| **Per-flow logs** | Each run streams to its own file instead of a shared, interleaved stdout | `tail -f .scratch/<repo>/<issue>/run.log` |
| **Durable event log** | Every P1/P2/P3 event is appended (written first, synchronously) as the source of truth | `.scratch/operability/events.jsonl` |
| **Status snapshot** | Pipeline state, issues by status, and recent events in one view | `npm run status` |
| **Telegram control** *(optional)* | Phone notifications + `/status` `/pause` `/resume` `/resume-at` over polling ($0, no public endpoint) | set `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` |
| **Supervision** *(M4)* | Runs the listener + webhook forwarders as auto-restarting supervised processes — kill the listener → restart → reconcile recovers | `devbox services up` (see [`docs/supervision.md`](docs/supervision.md)) |

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — the pipeline design: shape, trigger
  labels, state machine, dependency stacking, concurrency, and crash recovery.
- [`docs/operability.md`](docs/operability.md) — failure handling, the notifier + event
  log, `sunday status`, and the optional Telegram control channel.
- [`docs/supervision.md`](docs/supervision.md) — running the listener + forwarders under
  process supervision (`devbox services up`), the singleton rule, and restart recovery.
- [`docs/sandbox-prompt.md`](docs/sandbox-prompt.md) — the baseline discipline injected into
  every sandbox run.

## Prerequisites

Sunday runs on **macOS or Linux** (Ubuntu is the reference / production host).

Two things are installed manually; everything else is declared in `devbox.json`:

1. **Docker** — the daemon is a host service, not a devbox package. Docker Desktop or colima
   on macOS; `docker-ce` on Linux.
2. **[devbox](https://www.jetify.com/devbox)** — provisions the rest of the toolchain
   (node, gh, git, …) identically across macOS and Linux.

Then:

```bash
devbox shell          # enter the provisioned env; its init hook also installs the gh webhook
                      #   extension (cli/gh-webhook) — gh ships no built-in `webhook` command
gh auth login         # gh drives the webhook forwarder, PRs, labels, comments
cp .env.example .env  # agent auth + webhook secret (+ optional Telegram keys)
```

> Devbox provisions the **parent host** toolchain only. Each child sandbox gets its
> dependencies from its own `.sandcastle/Dockerfile`, not from here.

**Optional — Telegram control.** For phone notifications + remote `/pause` `/resume`
`/status`, set `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` in `.env`. It's off by default
(no keys → no-op), uses polling ($0, no public endpoint), and needs no extra install.
Setup steps are in [`docs/operability.md`](docs/operability.md).

### Choosing an agent

Sunday ships with **Claude** as the default coding agent. To use a different agent or model,
edit `.env` (`AGENT`, `MODEL`, `MODEL_EFFORT`) — the pointers are in `.env.example`.

Note: the agent must run **headless inside the Docker sandbox**. Sandcastle runs the agent
in the container, so swapping to an agent it does not yet support is more than a config
line — that agent has to be runnable in the sandbox first.

### Engineering-skills setup (per repo)

Sunday's default roster expects each repo it runs in to carry the engineering-skills
scaffolding under `docs/agents/` — the triage-label vocabulary, issue-tracker and domain-doc
conventions, and the coding-standards rubric the `reviewer` links. Run both setup skills
**once per repo** (Sunday itself, and each hosted child) before the roster's first use:

- **`setup-matt-pocock-skills`** — issue tracker, triage labels, and domain-doc layout.
- **`setup-ieuanign-skills`** — distills `docs/agents/coding-standards.md`, the Standards rubric
  the `reviewer` (via `code-review-mp`) links.

Without them the roster still runs — the `reviewer` falls back to `CLAUDE.md` and whatever the
repo documents — but the tailored rubric and label vocabulary won't be present.

## Running the pipeline

Once configured, run the whole stack — the listener plus a `gh webhook forward` per repo —
under devbox's built-in process supervisor, which restarts the listener if it ever exits:

```bash
devbox services up            # foreground — listener + webhook forwarders + a live TUI
devbox services up -b          # background
devbox services stop           # stop the stack
```

The listener is a **singleton**: restarted on death, never replicated (its serializing loop
assumes one process). On each start it re-arms any pause and reconciles pending work from GitHub,
so a crash-restart is a delay, not a loss. Full operator guide — startup ordering, watching a
run, and the manual two-terminal invocation for debugging — is in
[`docs/supervision.md`](docs/supervision.md).

## Security

- **Agent auth** — the agent token/OAuth lives in `.env`, which is gitignored. Never commit
  it. Only `.env.example` (no secrets) is published.
- **Webhook secret** — `gh webhook forward` authenticates deliveries with a shared secret;
  keep it in `.env`.
- **Sandbox isolation** — each run executes in a Docker sandbox as a **non-root** user;
  agents never run directly on the host.
- **Telegram control** *(if enabled)* — a `chat_id` allowlist is the sole authz and **fails
  closed**: no allowlist → the poller refuses to start, and any update from another chat is
  dropped. Polling means there is no inbound public endpoint to forge. `TELEGRAM_BOT_TOKEN`
  lives in `.env` (gitignored) — treat it as a secret; it can drive the pipeline.
- **The private recipe** — the individual tooling used to improve Sunday itself (`CLAUDE.md`,
  `docs/agents/`, and most of `.claude/`) is gitignored and never published. The exception is the
  shipped discipline floor — `.claude/agents/` and the `tdd`/`code-review-mp`/`diagnosing-bugs`
  skills — which is tracked (see [`docs/sandbox-prompt.md`](docs/sandbox-prompt.md) §2).
