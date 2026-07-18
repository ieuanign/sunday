# Sunday

Sunday is a **reusable workspace template** that turns GitHub issues into autonomous,
sandbox-isolated code implementations that open pull requests. It hosts multiple project
repositories under one shared setup and drives them through an event-driven automation
pipeline built on [Sandcastle](https://github.com/mattpocock/sandcastle).

Sunday is **orchestration only**: it owns the GitHub workflow (webhook → listener) and the
Sandcastle automation that runs coding agents in Docker sandboxes. Each hosted repository
owns its own rules — its `CLAUDE.md`, ADRs, and context. Sunday injects a baseline
discipline into every run and otherwise defers to each repo.

> **Status: design phase.** Nothing is built yet. This repository currently holds the
> design and the docs. The listener, config, and Sandcastle wiring described below are
> planned, and the load-bearing Sandcastle assumptions are still unverified. See
> [`docs/architecture.md`](docs/architecture.md).

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
├── .env.example           config template (copy to .env)
├── docs/
│   ├── architecture.md    the pipeline design
│   └── sandbox-prompt.md  the baseline injected into every sandbox run
├── listener/              (planned) the Node webhook listener
├── config/                (planned) per-repo routing
├── scripts/               dev helpers (e.g. gen-workspace.sh)
└── repos/                 child repo clones — gitignored, each its own repo
    └── <child>/           own origin, own .sandcastle/, own rules
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

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — the pipeline design: shape, trigger
  labels, state machine, dependency stacking, concurrency, and crash recovery.
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
devbox shell          # enter the provisioned environment
cp .env.example .env  # fill in your agent auth + webhook secret
```

> Devbox provisions the **parent host** toolchain only. Each child sandbox gets its
> dependencies from its own `.sandcastle/Dockerfile`, not from here.

### Choosing an agent

Sunday ships with **Claude** as the default coding agent. To use a different agent or model,
edit `.env` (`AGENT`, `MODEL`, `MODEL_EFFORT`) — the pointers are in `.env.example`.

Note: the agent must run **headless inside the Docker sandbox**. Sandcastle runs the agent
in the container, so swapping to an agent it does not yet support is more than a config
line — that agent has to be runnable in the sandbox first.

## Security

- **Agent auth** — the agent token/OAuth lives in `.env`, which is gitignored. Never commit
  it. Only `.env.example` (no secrets) is published.
- **Webhook secret** — `gh webhook forward` authenticates deliveries with a shared secret;
  keep it in `.env`.
- **Sandbox isolation** — each run executes in a Docker sandbox as a **non-root** user;
  agents never run directly on the host.
- **The private recipe** — the individual tooling used to improve Sunday itself (`CLAUDE.md`,
  `.claude/`, `docs/agents/`) is gitignored and never published.
