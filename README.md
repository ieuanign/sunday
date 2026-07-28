# Sunday

Sunday turns labelled GitHub issues into autonomous, sandbox-isolated code implementations that
open pull requests — on **your** hardware, not GitHub Actions. It is a **reusable workspace
template**: one shared setup hosting many project repositories, driven by an event-driven pipeline
built on [Sandcastle](https://github.com/mattpocock/sandcastle).

Sunday is **orchestration only**. It owns the GitHub workflow (webhook → pipeline) and the
Sandcastle runs that drive coding agents in Docker sandboxes; each hosted repository keeps its own
rules — its `CLAUDE.md`, ADRs and context. Sunday injects a baseline discipline into every run and
otherwise defers to each repo.

> **Status: pipeline built (M1–M5), live-hardening in progress.** Everything here is built and
> smoke-verified; a few paths are still owed an end-to-end live run — a real quota pause, a
> supervised kill → restart → reconcile.

## How it works

```
GitHub issue (labelled)
   → gh webhook forward   GitHub → your machine (no public server, no cron)
   → the parent process   routes repo → config, enforces global concurrency
   → sandcastle.run({ cwd: repos/<child> })
   → Docker sandbox       headless coding agent implements the issue
   → push + open PR       to the child repo's own origin
```

Inside the sandbox the agent follows a fixed discipline — plan → test-first implementation →
review → debug-on-red → sign-off → PR — while obeying the child repo's own rules. The design
behind all of it (trigger labels, the label state machine, dependency stacking, concurrency, state
and recovery) is [`docs/architecture.md`](docs/architecture.md).

## Documentation

| Doc | What it answers |
| --- | --- |
| [`CONTEXT.md`](CONTEXT.md) | The shared vocabulary — what a work item, a blackout, a fork point or the floor *is*. |
| [`docs/architecture.md`](docs/architecture.md) | The pipeline design: shape, trigger labels, the label state machine, dependency stacking + restack, concurrency lanes, the human gate, state and recovery, auth. |
| [`docs/operability.md`](docs/operability.md) | Behaviour under failure: the failure taxonomy, quota pause/resume, the 403 halt, the self-healing sandbox-image preflight, per-flow logs and the event log, and the optional Telegram notifications. |
| [`docs/supervision.md`](docs/supervision.md) | Running unattended: `devbox services up`, the singleton rule, startup ordering and the readiness probe, the in-process forwarders and blackout catch-up, restart recovery, the manual invocation for debugging, and how to roll back. |
| [`docs/resource-management.md`](docs/resource-management.md) | Cost per run: the per-phase model/effort matrix, the discipline floor mounted into every sandbox, the cost-weighted token report — plus the context-threshold handoff, designed but not built. |
| [`docs/sandbox-prompt.md`](docs/sandbox-prompt.md) | The baseline discipline injected into every issue run, and the result contract the host reads back. |
| [`docs/sandbox-pr-comment-prompt.md`](docs/sandbox-pr-comment-prompt.md) | The same, for an `@sunday` summon on a pull request. |
| [`docs/adr/`](docs/adr/) | Decisions that constrain the code: fork per work item, failure scope over a global halt, keeping PR stacking. |
| [`docs/implementation-plan.md`](docs/implementation-plan.md) | The ordered M1–M5 build sequence — the historical record of what was built and in what order. |

## Prerequisites

macOS or Linux (Ubuntu is the reference / production host). Two things are installed by hand;
everything else is declared in `devbox.json`:

1. **Docker** — the daemon is a host service, not a devbox package. Docker Desktop or colima on
   macOS; `docker-ce` on Linux.
2. **[devbox](https://www.jetify.com/devbox)** — provisions the rest of the toolchain (node, gh,
   git, …) identically across macOS and Linux.

```bash
devbox shell          # enter the provisioned env; its init hook also installs the gh webhook
                      #   extension (cli/gh-webhook) — gh ships no built-in `webhook` command
gh auth login         # gh drives the webhook forwarders, PRs, labels, comments
cp .env.example .env  # agent auth (+ optional Telegram keys)
```

Devbox provisions the **parent host** toolchain only — each child sandbox gets its dependencies
from its own `.sandcastle/Dockerfile`, not from here.

**The agent.** Claude is the default; swap it in `.env` (`AGENT`, `MODEL`, `MODEL_EFFORT` — the
pointers are in `.env.example`). It must be runnable **headless inside the Docker sandbox**, so an
agent Sandcastle does not support is more than a config line
([`docs/architecture.md`](docs/architecture.md#auth)).

**Telegram (optional).** Phone notifications — $0, no public endpoint, nothing extra to install.
Outbound only: Sunday sends, it takes no commands back. Off until `TELEGRAM_BOT_TOKEN` +
`TELEGRAM_CHAT_ID` are set in `.env`; setup steps are in
[`docs/operability.md`](docs/operability.md#telegram-notifications-optional).

## Onboarding a repo

```bash
npm run repo:init <git-url> [name]        # add "-- --dry-run" to preview, touching nothing
```

This clones the repo into `repos/<name>`, scaffolds `.sandcastle/` (a Dockerfile template +
`.gitignore` + blank `.env`), adds its routing entry to the gitignored `config/repos.json`
(additive — it never clobbers an existing child), seeds the pipeline labels on its tracker, and
regenerates the editor workspace. It then prints the child-specific next steps you own: base the
Dockerfile on the child's own dev image, and wire any per-run test sidecar. The image itself is
built for you — boot's preflight (re)builds every configured image, and an unedited template is
refused with an actionable `setup` halt instead of a doomed build
([`docs/operability.md`](docs/operability.md#setup-failures-sandbox-image-preflight)).

**Engineering skills — once per repo.** The default roster expects every repo it runs in (Sunday
itself, and each child) to carry the engineering-skills scaffolding under `docs/agents/`. Run
`setup-matt-pocock-skills` (issue tracker, triage labels, domain-doc layout) and
`setup-ieuanign-skills` (which distills `docs/agents/coding-standards.md`, the rubric the
`reviewer` links via `code-review-mp`) once each, before the roster's first use. Without them the
roster still runs — the `reviewer` just falls back to `CLAUDE.md` and whatever the repo documents.

**Editor roots.** Because `repos/` is gitignored, editors grey out everything under it, hiding
each child's *own* tracked/ignored status. Give each child its own editor root: run
`scripts/gen-workspace.sh` and open the generated `sunday.code-workspace` (VS Code / Cursor /
Windsurf — re-run it whenever you add a child; the generated file is gitignored since it names
your children), or map each child under *Settings → Version Control → Directory Mappings*
(JetBrains), or simply open the child in its own window — `git -C repos/<child> status --ignored`
works from anywhere.

## Running the pipeline

```bash
devbox services up            # foreground — the process + a live TUI
devbox services up -b         # background
devbox services stop          # stop the stack
npm run sunday                # or run it by hand, unsupervised
```

It is **one process** (`main.mts`): it starts a `gh webhook forward` per routed repo itself, so
there is no relay to launch alongside it. It is also a **singleton** — devbox's built-in
supervisor restarts it on death but never replicates it (its queue assumes one process). On each
start it re-arms any pause and reconciles pending work from GitHub, so a crash-restart is a delay,
not a loss; a dropped forwarder alerts, respawns, and catches that repo up without one. The full
operator guide is [`docs/supervision.md`](docs/supervision.md).

## Repository structure

```
.
├── main.mts               the parent process — receiver, forwarders, queue, boot
├── boot.mts               every (re)start: re-arm pause → build images → sweep → reconcile
├── process-compose.yaml   the supervised stack (one process) — `devbox services up`
├── devbox.json            host toolchain (node, gh, git, …)
├── .env.example           config template (copy to .env)
├── assignor/              admission, scheduling, state, reconcile — the decisions
├── services/              the seams: GitHub CLI + receiver + forwarders, sandbox, logging, git
├── issue/                 the forked per-work-item worker (one process per run, ADR-0001)
├── lib/                   shared plumbing — the `var/` paths, shell-out, outcome + lock files
├── config/                per-repo routing (`repos.json`, gitignored; `repos.example.json`
│                          tracked) + `roster.json`, the per-phase model/effort matrix
├── .claude/               the shipped discipline floor — the agent roster + its skills
├── docs/                  see Documentation above
├── scripts/               dev helpers (repo-init.sh, gen-workspace.sh)
├── test/                  the offline smoke suite — `npm test`
└── repos/                 child repo clones — gitignored, each its own repo
```

Children are independent clones with their own `origin`, `.sandcastle/` and agent rules. Sunday
never tracks or commits them, and every git operation inside a run resolves to the child's own
`.git`/`origin`, so branches and pushes land in the child, never in Sunday.

Durable runtime state and logs are gitignored, under `var/` — what is written where is in
[`docs/supervision.md`](docs/supervision.md#watching-a-run) and
[`docs/operability.md`](docs/operability.md#where-things-are-recorded).

## Security

- **Secrets live in the gitignored `.env`** — the agent token/OAuth, and the shared secret
  `gh webhook forward` authenticates deliveries with. Never commit it; only `.env.example` (no
  secrets) is published.
- **Sandboxes are credential-free** — each run executes in Docker as a **non-root** user and
  cannot push; the host performs every GitHub write. Agents never run directly on the host.
- **Telegram is outbound only** *(if enabled)* — Sunday sends to one `chat_id` and takes no
  commands back, so there is no inbound surface to forge. `TELEGRAM_BOT_TOKEN` still posts as your
  bot, so treat it as a secret ([`docs/operability.md`](docs/operability.md#authz)).
- **The private recipe stays private** — the individual tooling used to improve Sunday itself
  (`CLAUDE.md`, `docs/agents/`, most of `.claude/`) is gitignored and never published. The
  exception is the shipped discipline floor — `.claude/agents/` and the
  `tdd`/`code-review-mp`/`diagnosing-bugs` skills — which is tracked.
```
