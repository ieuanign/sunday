# Resource management (M5)

How Sunday tunes cost per run: a per-phase model/effort **matrix**, a context-threshold
**handoff** that keeps long-lived sessions sharp, and a cost-weighted **token report**. All local,
all `$0` (model switching is free on the Max token; no dollar figures anywhere).

## Per-phase matrix + the discipline floor

Each sandbox run injects Sunday's **discipline floor** — the real sub-agents (`.claude/agents/`) and
the skills they preload (`tdd`, `code-review-mp`, `diagnosing-bugs`) — mounted read-write as a single
`~/.claude` at the sandbox **user** level. A child repo's own project-level `.claude/` overrides it by
presence (Claude Code's project > user precedence), so the floor is a floor, not an override.

- **`config/roster.json`** is the matrix — one row per phase (`plan`/`implement`/`review`/`debug`/
  `signoff` → agent + `model` + `effort`). To retune a phase, edit one row. Defaults:

  | Phase | agent | model | effort |
  |---|---|---|---|
  | Plan | architecture-engineer | opus | max |
  | Implement | code-writer | opus | xhigh |
  | Review | reviewer | sonnet | high |
  | Debug | debugger | opus | xhigh |
  | Sign-off | sign-off | sonnet | medium |

- The injector merges the matrix onto the tracked agent bodies per run (`.scratch/<repo>/<issue>/
  claude/`, disposable). `.env` `MODEL` / `MODEL_EFFORT` are the **global fallback** — the
  orchestrator session's own model/effort.

> **Why a single `~/.claude` mount (not `~/.claude/{agents,skills}`):** two subdir mounts make Docker
> create the parent `~/.claude` root-owned, so the agent user can't write `~/.claude/projects/` and
> Sandcastle's session capture fails. One rw mount keeps it agent-owned.

## Handoff-at-threshold

The orchestrator session only grows across repeated **gate cycles** on one issue. At a gate resume,
the host reads the prior context (`input + cacheRead + cacheCreation`):

- **`< HANDOFF_CTX_THRESHOLD`** (default `120000`, `.env`-tunable) → cheap `run({ resumeSession })`.
- **`≥ threshold`** → one bounded turn writes a handoff note (emitted as tagged output — nothing is
  written inside the credential-free box), then a **fresh** session is seeded with the note + the
  human's reply. Notes live at `.scratch/<repo>/handoff/<issue>-<n>.md`, cleared when the PR opens.

If the handoff turn can't produce a usable note, the issue fails as **`agent-failed`** (a relabel
retries fresh) — never `awaiting-human`, which would loop re-resuming the bloated session.

## Token report

On every run completion the host parses the captured session JSONL + each sub-agent session
(`<id>/subagents/agent-*.jsonl`) into **per-phase rows** and ranks consumers by a cost-**weighted**
key — `input×1 + cacheCreation×1.25 + cacheRead×0.1 + output×5`. Output is the priciest class, so
ranking by raw tokens would bury the real offender.

- Per row: the 4 raw token fields + `cacheHitRatio` + flags (`HIGH_OUTPUT`, `RECACHE`, `NEAR_ZONE`
  ≥120K, `OVER_ZONE` ≥150K); per run: totals by class, peak ctx + zone, top consumers.
- Stored at `.scratch/<repo>/token-report/<run-id>.{json,md}` + `history.jsonl`; a headline is logged.
- **Sentry-like Telegram:** only important events reach your phone — a PR opening and failures.
  Token reports stay on disk + console (no per-run spam).
