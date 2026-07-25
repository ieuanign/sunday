# Each work item runs in its own forked process

Sunday v1 ran every issue and PR-comment run as an `await`ed async call inside the
single listener process. V2 keeps the services and the Assignor in the parent, but
`fork()`s a child process per work item. The decisive reason is that v1's shell-out
helper is synchronous (`spawnSync`), so a chain of `gh`/`git` calls froze the one
event loop, starved the readiness probe, and got the listener SIGKILLed and restarted
by process-compose — a bug v1 papered over with an async twin and a manual
`setImmediate` yield in the reconcile sweep. In a forked child, synchronous work
blocks only that child, and the whole class disappears.

## Consequences

- A child shares no memory with the parent. Anything it needs is passed at fork time
  or read from disk, and it logs to `var/log/` and comments on GitHub directly rather
  than routing through the parent.
- A child writes its outcome to `var/results/<key>.json` **before** reporting over
  IPC, and holds a PID lockfile in `var/running/` while alive. The parent can
  therefore be killed at any moment — hot-reload, crash, deploy — without losing
  finished work or double-starting an orphan. The parent sweeps both directories on
  boot.
- Because the parent forks by path rather than importing the worker, worker code is
  outside the parent's import graph: editing `issue/` or `pr/` takes effect on the
  next job with no restart at all, and `node --watch main.mts` watches exactly the
  parent's own graph.
- The Docker sandbox was already isolated, so this protects only the *host-side*
  code — the `gh`/`git` calls, PR creation, reply posting. That is where v1's real
  incidents happened, so the protection is worth having, but it is narrower than
  "isolation" suggests.
