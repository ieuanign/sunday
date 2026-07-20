# Supervision

How Sunday's processes are kept alive without a human babysitting a terminal (milestone M4).
The pipeline is supervised by **[process-compose](https://github.com/F1bonacc1/process-compose)**,
which devbox ships built in — so there is nothing extra to install and it behaves identically on
macOS and Linux.

The stack is two **host processes** (not containers):

| Process | What it is | Supervision |
| --- | --- | --- |
| **`listener`** | the singleton orchestrator — `node --env-file=.env listener/listen.mts` | `restart: always`; readiness-probed on its GET endpoint |
| **`webhook-forward`** | one `gh webhook forward` per configured repo, delivering GitHub events to the listener | `restart: always`; starts only after the listener is healthy |

## Why host processes, not containers

The listener spawns Sandcastle Docker sandboxes on the **host** daemon. If the listener itself
ran in a container (a docker-compose service), those child sandboxes would still resolve their
bind-mounts against the host daemon — so `repos/` would have to be mounted at its exact host path
with a matching working directory, and the docker socket passed through (docker-out-of-docker).

Running the listener as a supervised **host process** sidesteps all of that: it talks to the host
Docker daemon directly, exactly as a hand-run `node … listener/listen.mts` does. process-compose
gives the supervision (restart, ordering, health) without containerising anything.

## Running it

```bash
devbox services up            # foreground — both processes + a live TUI
devbox services up -b          # background
devbox services attach         # re-attach to the TUI / logs of a background stack
devbox services ls             # list processes + status/health/restarts
devbox services restart listener   # restart one process
devbox services stop           # stop the stack
```

`devbox services up` reads `process-compose.yaml` at the repo root and runs both processes inside
the devbox environment (so `node`, `gh`, and `jq` are on `PATH`). Working directory is the repo
root, so `.env`, `config/`, and `.scratch/` resolve exactly as for a hand-run listener.

## The singleton rule

The listener is a **singleton** — process-compose restarts it on death but must **never** run
more than one. Its serializing loop, in-flight set, and double-launch guard all assume a single
process; two listeners would double-admit the same issue (the `agent-working` label is
best-effort, not a distributed lock). There is no replica knob in `process-compose.yaml`; keep it
that way. A second machine is a **cold standby**, not active/active.

## Startup ordering + restart recovery

`webhook-forward` `depends_on` the listener being `process_healthy`, so it never forwards into a
port that isn't listening yet. Readiness is an **`http_get`** probe against the listener's GET
endpoint (a bare `tcp_socket` probe is *not* supported by process-compose — it would leave the
process forever un-`Ready` and strand the forwarders behind the gate).

Restart is safe by design. On every (re)start the listener:

1. **re-arms** any persisted pause / 403 halt (`.scratch/operability/pause.json`), then
2. **reconciles** all pending work from GitHub (new issues, missed gate replies, missed
   PR-merge restacks, orphaned `agent-working`).

GitHub is the source of truth, so a crash-and-restart is a **delay, not a loss**. The `.scratch`
state only carries session ids that let an interrupted run *resume* rather than restart.

## The webhook forwarder launcher

`webhook-forward` runs `scripts/webhook-forward.sh`, a generic launcher that reads the
**gitignored** routing table `config/repos.json` at runtime and starts one `gh webhook forward`
per repo. Keeping the repo names out of the tracked `process-compose.yaml` is deliberate (publish
policy): child names live only in `config/repos.json`.

The forwarders are stateless and idempotent (a missed event is recovered by reconcile), so if any
one exits the launcher exits and process-compose restarts the **whole group** — simple, and
harmless.

## Watching a run

- **The stack's own output:** `devbox services attach` (the process-compose TUI) or
  `devbox services up` in the foreground.
- **One live agent run:** `tail -f .scratch/<repo>/<issue>/run.log` — each run streams to its own
  file (see [`operability.md`](operability.md)).
- **State at a glance:** `npm run status`.

## Manual invocation (debugging)

Supervision is optional plumbing — the listener is still just a process. To run it by hand (e.g.
to attach a debugger or watch raw stdout), use two terminals:

```bash
# Terminal 1 — the listener
node --env-file=.env listener/listen.mts

# Terminal 2 — the forwarder(s)
scripts/webhook-forward.sh
# …or a single repo directly:
gh webhook forward --repo <owner/repo> \
  --events issues,issue_comment,pull_request,pull_request_review_comment \
  --url http://localhost:8787/
```

## Verify

The M4 gate: **kill the listener → the supervisor restarts it → reconcile recovers pending work.**

```bash
devbox services up -b
devbox services ls                     # listener Ready, webhook-forward Running
kill "$(pgrep -f listener/listen.mts)" # or: devbox services restart listener
devbox services ls                     # listener back up (RESTARTS incremented), re-bound to its port
```

Booting against real repos runs reconcile → live GitHub reads, relabels, and agent runs (quota).
Verify the recovery leg deliberately, against work you intend to (re)admit — not casually.
