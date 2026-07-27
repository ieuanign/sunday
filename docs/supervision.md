# Supervision

How Sunday's processes are kept alive without a human babysitting a terminal (milestone M4).
The pipeline is supervised by **[process-compose](https://github.com/F1bonacc1/process-compose)**,
which devbox ships built in — so there is nothing extra to install and it behaves identically on
macOS and Linux.

The stack is one **host process** (not a container):

| Process | What it is | Supervision |
| --- | --- | --- |
| **`sunday`** | the singleton parent — `node --env-file=.env main.mts`. It binds the event receiver, supervises one `gh webhook forward` per routed repo **in-process**, then boots. | `restart: always`; readiness-probed on the receiver's GET endpoint |

There is no second supervised process and no launcher script: the process that owns the forwarder
children is the one that can say something when one dies and catch that repo up (#40).

## Why host processes, not containers

Sunday spawns Sandcastle Docker sandboxes on the **host** daemon. If the parent itself
ran in a container (a docker-compose service), those child sandboxes would still resolve their
bind-mounts against the host daemon — so `repos/` would have to be mounted at its exact host path
with a matching working directory, and the docker socket passed through (docker-out-of-docker).

Running it as a supervised **host process** sidesteps all of that: it talks to the host
Docker daemon directly, exactly as a hand-run `npm run sunday` does. process-compose
gives the supervision (restart, health) without containerising anything.

## Running it

```bash
devbox services up            # foreground — the process + a live TUI
devbox services up -b          # background
devbox services attach         # re-attach to the TUI / logs of a background stack
devbox services ls             # list processes + status/health/restarts
devbox services restart sunday # restart it
devbox services stop           # stop the stack
```

`devbox services up` reads `process-compose.yaml` at the repo root and runs the process inside
the devbox environment (so `node` and `gh` are on `PATH`). Working directory is the repo
root, so `.env`, `config/`, and `var/` resolve exactly as for a hand-run parent.

## The singleton rule

The parent is a **singleton** — process-compose restarts it on death but must **never** run
more than one. Its queue, its claim label and its own children all assume a single process; two
parents would double-admit the same issue (the claim label is best-effort, not a distributed
lock) and each spawn a forwarder per repo, where the second dies on `HTTP 422 … Hook already
exists`. There is no replica knob in `process-compose.yaml`; keep it that way. A second machine
is a **cold standby**, not active/active.

## Startup ordering + restart recovery

The ordering that used to be a `depends_on: process_healthy` gate between two processes is now
internal, and load-bearing: the parent **binds the receiver → starts the forwarders → boots**. A
forwarder is only ever pointed at the port the receiver actually bound, and boot's re-derive runs
*after* the relay is up — any other order leaves a window where GitHub fires events, nothing
forwards them, and the reconcile that would have re-derived them has already run.

Readiness is an **`http_get`** probe against the receiver's GET endpoint (a bare `tcp_socket`
probe is *not* supported by process-compose — it would leave the process forever un-`Ready`). It
is answered as soon as the receiver serves, which is *before* the boot sequence: image builds take
minutes, and a probe unanswered that long is the SIGKILL/restart loop
[ADR-0001](adr/0001-fork-per-work-item.md) exists to stop. The probe port is a literal in
`process-compose.yaml` (probe ports are ints, so they cannot read the env) — keep it in sync with
`SUNDAY_PORT`.

Restart is safe by design. On every (re)start the parent:

1. **holds** the queue, then **re-arms** any persisted pause / halt (`var/pause.json`),
2. **builds** every configured sandbox image,
3. **sweeps** what the dead parent left behind — finished outcomes on disk, and in-flight items
   whose child is gone, then
4. **reconciles** outstanding work from GitHub (new issues, missed gate replies, missed PR-merge
   restacks, orphaned claims).

GitHub is the source of truth, so a crash-and-restart is a **delay, not a loss**. The `var/` state
only carries what lets an interrupted run *resume* rather than restart.

## The forwarders

The parent starts one `gh webhook forward` per repo in the **gitignored** routing table
`config/repos.json`, read at runtime. Keeping the repo names out of the tracked
`process-compose.yaml` is deliberate (publish policy): child names live only in `config/repos.json`.

Each forwarder is supervised **individually**. `gh webhook forward` exits when its websocket drops
(`close 1006 (abnormal closure)` — routine), so the parent respawns just that repo's forwarder and
leaves the others flowing, backing off 5s doubling to ~5min while it keeps failing. Recovery is
deliberately *not* delegated upward: on 2026-07-24 one dropped forwarder took the whole group down
and process-compose did not restart it for 8h44m, blacking out every repo's events — and
process-compose (v1.110) only ever *logs* a failed probe, liveness probes included, so a probe
would not have recovered it either.

A drop is now **said out loud, and caught up**:

- The drop raises one `alert` (phone, if Telegram is configured) naming the repo, when it went
  down and the dying forwarder's own stderr tail — the diagnostic the retired bash launcher could
  never give.
- A respawned forwarder that stays up for 30s closes the blackout: one `alert` carrying the repo,
  the start and the measured duration, then a reconcile of **that repo alone**, through the same
  per-repo pass boot uses. v1 re-derived missed work only on boot, so a forwarder-only blackout was
  never caught up at all.
- Exactly one drop line and one recovery line per blackout: a respawn that dies before it settles
  neither re-alerts nor reconciles, so a crash-looping forwarder is not phone spam and a repo
  re-derive every few seconds against real GitHub quota.

Both lines land durably in `var/log/events.jsonl` — that is the blackout window's record; there is
no separate store.

`gh` registers one dev webhook per repo and removes it on a clean exit, which is why the parent
SIGTERMs its forwarders on `SIGTERM`/`SIGINT` (`devbox services stop` is one). A hard stop
(SIGKILL, crash, power loss) strands it, and every later start then dies on `HTTP 422 … Hook
already exists on this repository` — a blackout no amount of retrying clears. So the parent also
drops a stranded forwarder hook (matched on gh's own forwarder URL, so a repo's real webhooks are
untouched) before each (re)spawn, and a drop that fails never blocks the spawn.

## Watching a run

- **The stack's own output:** `devbox services attach` (the process-compose TUI) or
  `devbox services up` in the foreground.
- **One live agent run:** `tail -f var/log/<owner>/<repo>/<issue>/run.log` — each run streams to
  its own file; lines with no run to attribute them to land in `var/log/sunday.log`.
- **What Sunday has done:** `var/log/events.jsonl`.

## Manual invocation (debugging)

Supervision is optional plumbing — the parent is still just a process. To run it by hand (e.g. to
attach a debugger or watch raw stdout), one terminal is enough; it starts its own forwarders:

```bash
npm run sunday        # node --env-file=.env main.mts
```

## Rollback

Rolling back to the pre-cutover pipeline is **one checkout plus a routing-table restore** — there
is no migration to reverse: GitHub is the source of truth, the claim label (`agent-working`) is the
same one both pipelines set, and everything either pipeline keeps locally is disposable.

```bash
devbox services stop                 # 1. stop CLEANLY — see the warning below
git checkout v1-final                # 2. the tagged commit before the cutover merged
cp <your-backup>/repos.json config/  # 3. put the pre-cutover routing table back

# 4. v1 is hand-run: a terminal for the listener, plus one per routed repo
node --env-file=.env listener/listen.mts
gh webhook forward --repo <owner/repo> \
  --events issues,issue_comment,pull_request,pull_request_review_comment \
  --url http://localhost:8787/
```

1. **Stop cleanly, never SIGKILL.** `gh webhook forward` removes its own dev webhook on a clean
   exit; a hard-killed one strands it and every later start dies on `HTTP 422 … Hook already exists
   on this repository`. Two relays into the same port also means every event is delivered twice, so
   the running pipeline must be down before the other one comes up.
2. **The checkout brings v1 back whole** — `listener/`, its smokes, `npm run status` and the
   Telegram command poller all live at the tag.
3. **`config/repos.json` is gitignored runtime state**, so the checkout does not restore it. The
   cutover trimmed it to finance; the backup taken before that trim is what widens routing again.
4. **State does not need reversing.** v1 reads `.scratch/`, the current pipeline reads `var/`, so
   neither sees the other's — and either one re-derives its outstanding work from GitHub on boot.
   Delete `var/` only if you want the next start to rebuild from GitHub alone.

## Verify

The M4 gate: **kill the parent → the supervisor restarts it → boot recovers pending work.**

```bash
devbox services up -b
devbox services ls              # sunday Ready
kill "$(pgrep -f main.mts)"     # or: devbox services restart sunday
devbox services ls              # back up (RESTARTS incremented), re-bound to its port
```

The relay gate (#40): **kill one forwarder → it alerts, respawns, and catches that repo up.**

```bash
devbox services up -b
pgrep -laf "gh webhook forward"          # one per routed repo
kill "$(pgrep -f 'gh webhook forward --repo <owner/repo>')"
tail -f var/log/events.jsonl             # drop alert → respawn → recovery alert with the window
```

Expect a phone alert on the drop, the same repo's forwarder back within the backoff, a recovery
alert naming when it went down and for how long, and that repo's re-derive — the others' pids
untouched throughout.

Booting against real repos runs reconcile → live GitHub reads, relabels, and agent runs (quota),
and so does a blackout recovery. Verify the recovery legs deliberately, against work you intend to
(re)admit — not casually.
