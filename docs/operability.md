# Operability

How Sunday's listener behaves under failure, what it records, and how to watch and steer it.
This is the operator's view of the operability layer (milestone M3); the build spec lives in the
design docs.

The listener owns **all** I/O (push, PR, comments, labels) and runs each issue in a credential-free
Docker sandbox. When a run fails, the listener classifies the failure off the **run-result shape**
(not exit codes), reacts *oppositely* per class, and records every notable event durably — so an
outage or a quota wall is a delay, never a silent loss.

## Failure taxonomy

Every failed run is mapped to one class, which drives the response:

| Class | Recognised by | Action | Severity |
| --- | --- | --- | --- |
| **quota** | a usage/limit error carrying a reset time | Pause **both** lanes; auto-resume at **reset + 5 min**. No parseable reset → hold and comment the issue `awaiting-human` (resume with `/resume-at`). | P2 |
| **auth (403)** | a 403 / invalid-credential error | Abort every in-flight run and **halt**; a human re-authenticates, and reconcile re-admits the work on the next boot. | P1 |
| **transient** | 429 / network / 5xx (or a `retry-after`) | **Bounded exponential backoff** (honours `retry-after`), then, after 3 tries, the `agent-failed` path. | P3 |
| **run-level** | the agent ran but produced nothing shippable (no valid result tag, a dirty worktree, an `error_*` result subtype) | Flag the issue `agent-failed`; no PR to open. | P3 |
| **unknown** | anything unrecognised | **Fail-safe halt** — stop and notify, with the raw excerpt captured for inspection. Never silently dropped. | P1 |

> The string patterns for quota/auth/transient are **provisional** until the first real occurrence.
> The `unknown` fail-safe exists precisely to capture that first raw error in the event log so the
> classifier can be tightened against reality — the shape-based checks (result tag, worktree,
> abort) are already exact.

## Where things are recorded

All operability artifacts are gitignored, under `.scratch/`:

- **Event log — `.scratch/operability/events.jsonl`.** One JSON line per P1/P2/P3 event, appended
  **first and synchronously** — the source of truth. If every other sink fails, the event is still
  here. This is where a first real quota/403/refusal excerpt lands for tightening the classifier.
- **Per-flow run logs — `.scratch/<repo>/<issue>/run.log`** (and `pr-<n>/run.log` for PR-comment
  runs). Each run streams its full agent output to its own file instead of the shared, interleaved
  listener stdout. To follow one live run: `tail -f .scratch/<repo>/<issue>/run.log`. The listener's
  own stdout stays a terse one-line-per-event summary.
- **Pause state — `.scratch/operability/pause.json`.** Why the pipeline is paused and until when.
  Written temp-then-rename (no torn file on a crash). On boot the listener **re-arms** it: an
  elapsed quota reset resumes immediately, a future one is re-scheduled, and a 403 halt / no-timestamp
  quota stays paused for a human.

## Status at a glance

```bash
npm run status        # or: node listener/status.mts
```

Prints the pipeline state (active / paused, with the reason and any auto-resume time), open issues
grouped by status (in-flight / awaiting-human / failed enumerated, done counted), and the tail of
the event log. It reads only durable state, so it works from any shell — you do not need to be
inside the listener process.

## Pause / resume lifecycle

A pause stalls **both** the regular and the restack lanes (a restack conflict-fix also spends the
shared token), while **retaining** queued work and letting in-flight runs finish. Resuming drains
whatever was retained.

- **Quota with a reset** → auto-pauses and auto-resumes; no action needed.
- **Quota with no reset time / a 403 halt** → stays paused until a human resumes (re-auth for a 403;
  `/resume-at` for a quota with no timestamp). The reason is in `pause.json` and `npm run status`.

## Telegram control (optional)

An optional $0 phone channel — notifications outbound, control commands inbound — over **polling**
(`getUpdates`). No webhook, no tunnel, no public endpoint. Off by default: with the keys unset,
notifications no-op and the poller never starts.

### Setup

1. Create a bot via [`@BotFather`](https://t.me/BotFather) and copy its token.
2. Send your new bot any message, then read your numeric chat id from
   `https://api.telegram.org/bot<token>/getUpdates` (the `message.chat.id` field).
3. Put both in `.env` and restart the listener:

   ```
   TELEGRAM_BOT_TOKEN=123456:ABC...
   TELEGRAM_CHAT_ID=987654321
   ```

The listener logs `📱 telegram control: polling for commands` on boot when it's enabled.

### Authz

The `chat_id` allowlist is the **only** authz, and it **fails closed**: without `TELEGRAM_CHAT_ID`
the poller refuses to start, and any update from another chat is dropped. Polling means there is no
inbound public surface to forge. Treat `TELEGRAM_BOT_TOKEN` as a secret — it can drive the pipeline.

### Commands

| Command | Effect |
| --- | --- |
| `/status` | The `npm run status` view plus the live in-memory scheduler snapshot. |
| `/pause [reason]` | Stall both lanes with an optional reason. |
| `/resume` | Lift a pause and drain retained work. |
| `/resume-at <ISO>` | Schedule a resume at an ISO time, e.g. `/resume-at 2026-07-19T21:00:00Z`. |
| `/help` | List the commands. |

Notifications and commands drive the **same** pause/resume seams the automatic act layer uses — one
source of truth, whether a pause came from a quota wall or from your phone.

> Deferred: `/agent`, `/runs`, `/log`, `/quota`. The control + status core above is what matters for
> reacting to a quota/403 remotely.
