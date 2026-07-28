# Resource management (M5)

How Sunday tunes cost per run: a per-phase model/effort **matrix**, a cost-weighted **token
report**, and a context-threshold **handoff** that retires a session before it grows too big to
work in. All local, all `$0` (model switching is free on the Max token; no dollar figures anywhere).

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

- The floor is assembled per run — the matrix merged onto the tracked agent bodies — under
  `.scratch/floor/<work-item key>/`, one dir per work item so concurrent runs never share a floor.
  Throwaway by construction: `.scratch/` is `rm -rf`-able, and nothing durable lives there.
  `.env` `MODEL` / `MODEL_EFFORT` are the **global fallback** — the orchestrator session's own
  model/effort.

> **Why a single `~/.claude` mount (not `~/.claude/{agents,skills}`):** two subdir mounts make Docker
> create the parent `~/.claude` root-owned, so the agent user can't write `~/.claude/projects/` and
> Sandcastle's session capture fails. One rw mount keeps it agent-owned.

## Handoff-at-threshold

The orchestrator session only grows across repeated **gate cycles** on one issue. Each gate outcome
records the context the session had reached (`input + cacheRead + cacheCreation`) in the work item's
durable state, so the reply that comes back hours later knows what it would be resuming:

- **`< HANDOFF_CTX_THRESHOLD`** (default `120000`, `.env`-tunable) → cheap `run({ resumeSession })`,
  exactly as before. An unknown context reads as "small" and resumes.
- **`≥ threshold`** → the reply does **not** go to that session. One bounded turn resumes it just
  long enough to compact it into a handoff note, emitted as tagged output (`<sunday-handoff>`) —
  nothing is written inside the credential-free box. A **fresh** session is then started with the
  note + the human's reply. The host keeps the note at `var/handoff/<work-item key>.md` (one per
  work item — a second handoff overwrites the first, and both texts are in the run log anyway) and
  clears it once the PR opens. Writing it is best-effort: the fresh session is seeded from the note
  in memory, so a disk that can't take a copy never costs a run.

If the handoff turn can't produce a usable note, the issue fails as **`agent-failed`** — never
`awaiting-human`, which would loop re-resuming the bloated session. Nothing retries it: hand it back
by removing the `agent-failed` label and re-adding the trigger label, which runs the issue fresh.

## Token report

On every run completion the host parses the captured session JSONL + each sub-agent session
(`<id>/subagents/agent-*.jsonl`) into **per-phase rows** and ranks consumers by a cost-**weighted**
key — `input×1 + cacheCreation×1.25 + cacheRead×0.1 + output×5`. Output is the priciest class, so
ranking by raw tokens would bury the real offender.

- Per row: the 4 raw token fields + `cacheHitRatio` + flags (`HIGH_OUTPUT`, `RECACHE`, `NEAR_ZONE`
  ≥120K, `OVER_ZONE` ≥150K); per run: totals by class, peak ctx + zone, top consumers.
- Stored under `var/log/<owner>/<repo>/token-report/` as `<run-id>.{json,md}` + `history.jsonl`,
  beside that repo's run logs — durable state, not throwaway, so spend history survives a
  `.scratch/` wipe. A headline is logged.
- **Sentry-like Telegram:** only important events reach your phone — a PR opening and failures.
  Token reports stay on disk + console (no per-run spam).
