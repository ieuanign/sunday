# Operability

How Sunday behaves under failure, what it records, and how to watch and steer it.
This is the operator's view of the operability layer (milestone M3); the build spec lives in the
design docs.

Sunday owns **all** I/O (push, PR, comments, labels) and runs each issue in a credential-free
Docker sandbox. When a run fails, Sunday classifies the failure off the **run-result shape**
(not exit codes), reacts *oppositely* per class, and records every notable event durably — so an
outage or a quota wall is a delay, never a silent loss.

## Failure taxonomy

> **This section predates [ADR-0002](adr/0002-failure-scope-not-global-halt.md).** A failure now
> carries a **scope** — `pipeline`, `repo` or `item` — and that, not a severity, decides how far it
> reaches. ADR-0002 and [`architecture.md`](architecture.md#failure-handling) are the model of record.

Every failed run is mapped to one class, which drives the response:

| Class | Recognised by | Action | Severity |
| --- | --- | --- | --- |
| **quota** | a usage/limit error carrying a reset time | Pause **both** lanes; auto-resume at **reset + 60s**. No parseable reset → hold and comment the issue `awaiting-human` (a human lifts it, see below). | P2 |
| **auth (403)** | a 403 / invalid-credential error | Abort every in-flight run and **halt**; a human re-authenticates, and reconcile re-admits the work on the next boot. | P1 |
| **transient** | 429 / network / 5xx (or a `retry-after`) | **One** retry — re-queued, no backoff. A `retry-after` is not waited out: it is what tells a rate-limited blip from a quota wall at classification time. Failing again leaves the item `failed` — not quarantined — and the next reconcile re-admits it. | P3 |
| **run-level** | the agent ran but produced nothing shippable (no valid result tag, a dirty worktree, an `error_*` result subtype) | Flag the issue `agent-failed`; no PR to open. | P3 |
| **setup** | the sandbox couldn't be *created* — `Provider '…' create failed` / image not found locally (unbuilt image, docker daemon down) | **Halt + self-heal**: the setup watcher re-reads `config/repos.json` and re-runs the image preflight every 5 min, rebuilds once the fix lands, auto-resumes, and re-admits the issues that died on it (see below). | P1 |
| **unknown** | anything unrecognised | **Fail-safe halt** — stop and notify, with the raw excerpt captured for inspection. Never silently dropped. | P1 |

> The string patterns for quota/auth/transient are **provisional** until the first real occurrence.
> The `unknown` fail-safe exists precisely to capture that first raw error in the event log so the
> classifier can be tightened against reality — the shape-based checks (result tag, worktree,
> abort) are already exact.

## Setup failures (sandbox image preflight)

On boot Sunday **(re)builds every repo's sandbox image** in `config/repos.json` from the
child's `.sandcastle/` (via `sandcastle docker build-image`, after the HTTP server is up — a
build never blocks the readiness probe). Docker's layer cache makes an unchanged rebuild take
seconds, and always building — rather than only when the image is missing — also picks up
`.sandcastle/Dockerfile` edits and an updated local base image, which would otherwise drift
into confusing in-run toolchain failures. A Dockerfile still carrying the scaffold placeholder
(`FROM your-child-dev-image`) is refused with an actionable error rather than attempting a
doomed build.

When setup fails — at boot, or mid-run as a `Provider '…' create failed` — the pipeline halts
(class `setup`, P1, notified once) and the **setup watcher** starts:

- Every 5 min it re-reads `config/repos.json` **fresh** and re-runs the preflight: each repo's
  `.sandcastle/Dockerfile` (present? placeholder?), docker reachability, the builds themselves.
- **Your fix is an edit outside the process** — give the Dockerfile a real `FROM`, correct the
  `repos.json` entry, or start the docker daemon. No restart needed.
- Once a recheck builds clean, the watcher adopts the freshly-read routing table,
  **re-admits the issues whose runs died on the broken environment** (setup failures keep all
  trigger labels and never get `agent-failed` — the environment was at fault, not the issue),
  and **auto-resumes** the pipeline. Clearing the pause file and restarting (where reconcile
  re-derives the work) also works; the watcher stands down if the halt is lifted or superseded
  by a different pause.
- It never spams: the halt is notified once (event log / issue comment / Telegram), and the
  watcher logs to the parent's stdout only when the failure message *changes*.

The raw excerpt is in `var/log/events.jsonl`; the halt reason in `var/pause.json`.

## Where things are recorded

All operability artifacts are gitignored, under `var/`:

- **Event log — `var/log/events.jsonl`.** One JSON line per P1/P2/P3 event, appended
  **first and synchronously** — the source of truth. If every other sink fails, the event is still
  here. This is where a first real quota/403/refusal excerpt lands for tightening the classifier.
- **Per-flow run logs — `var/log/<owner>/<repo>/<issue>/run.log`** (and `pr-<n>/run.log` for
  PR-comment runs). Each run streams its full agent output to its own file instead of the shared,
  interleaved parent stdout. To follow one live run:
  `tail -f var/log/<owner>/<repo>/<issue>/run.log`. The parent's own stdout stays a terse
  one-line-per-event summary.
- **Pause state — `var/pause.json`.** Why the pipeline is paused and until when.
  Written temp-then-rename (no torn file on a crash). On boot Sunday **re-arms** it: an
  elapsed quota reset resumes immediately, a future one is re-scheduled, a 403 halt / no-timestamp
  quota stays paused for a human, and a setup halt restarts its self-heal watcher.

## Pause / resume lifecycle

A pause stalls **both** the regular and the restack lanes (a restack conflict-fix also spends the
shared token), while **retaining** queued work and letting in-flight runs finish. Resuming drains
whatever was retained.

- **Quota with a reset** → auto-pauses and auto-resumes; no action needed.
- **Quota with no reset time / a 403 halt** → stays paused until a human lifts it: fix the cause
  (re-auth for a 403, wait out an unparseable quota), then send `/resume` from the phone — or
  delete the pause file and restart Sunday, where boot re-arms whatever the file still says and
  reconcile re-admits the work. The reason is in the pause file and in the event log.

## Telegram notifications (optional)

An optional $0 phone channel, **both ways** — Sunday sends what it has to say, and long-polls the
Bot API for commands from inside the one supervised parent. Still no webhook, no tunnel, no public
endpoint. Off by default: with either key unset, notifications no-op, nothing polls, and the
pipeline is unchanged.

### Setup

1. Create a bot via [`@BotFather`](https://t.me/BotFather) and copy its token.
2. Send your new bot any message, then read your numeric chat id from
   `https://api.telegram.org/bot<token>/getUpdates` (the `message.chat.id` field).
3. Put both in `.env` and restart Sunday:

   ```
   TELEGRAM_BOT_TOKEN=123456:ABC...
   TELEGRAM_CHAT_ID=987654321
   ```

### Commands

- **`/status`** — paused or running (with the reason), what is in flight, queued, in the restack
  lane, and what is quarantined.
- **`/fix <owner>/<repo>#<n> [steer]`** — releases a parked item: takes the `quarantined` /
  `agent-failed` label off the issue and hands it straight back through admission, retry budget
  restored. The optional steer reaches that run's prompt as the human's instruction — for **that
  run only**; a later retry of it does not carry the note. An item in any other state is refused
  naming the state it is in.
- **`/resume`** — lifts a pause that is waiting on a human (above). One that lifts itself is
  refused with the time it lifts at, because resuming a quota window early feeds the backlog back
  into the wall it is waiting out.
- **`/help`** — the list.

Anything typed while Sunday was down is dropped on the next start: a `/fix` from a three-hour
outage would act on a pipeline that has moved on. Replies are truncated to stay under Telegram's
4096-char message limit, since an oversize one is rejected outright and reads as a dead channel.

### Authz

`TELEGRAM_CHAT_ID` is the single destination **and the only authz there is** — the one thing
between a stranger's message and `/fix` starting an agent run on your quota. The channel **fails
closed**: with either key unset nothing is sent and nothing polls, and a token with no chat id
refuses to poll and says why. A command from any other chat is dropped (said once, then quiet), and
every reply goes to the configured chat, never to whoever sent the message. Treat
`TELEGRAM_BOT_TOKEN` as a secret: it posts as your bot.
