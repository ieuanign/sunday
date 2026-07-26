// main.mts — the V2 parent process. It owns the services, the Assignor, the queue and
// BOTH ends of the event pipe, and it owns no work: every work item runs in a forked
// child (ADR-0001), so a `gh` or `git` call that blocks blocks only that child and never
// the socket this process answers on.
//
//   devbox services up             # supervised — the one process in process-compose.yaml
//   npm run v2                     # node --env-file=.env main.mts
//
// The `gh webhook forward` per routed repo is started HERE and no longer by hand or by a
// shell launcher: the process that owns those children is the one that can say something
// when one dies and catch that repo up (#40).
//
// This file is WIRING and nothing else — the decisions are the Assignor's and the
// smokes drive them there, against injected substitutes. What is here is what cannot be
// injected: the real routing table, the real GitHub CLI, the real `var/` paths and a
// real fork.

import { loadRepos } from "#config/repos.mts";
// The worker is reached BY PATH, from in there — nothing in this process's import graph
// refers to `issue/`, so editing it takes effect on the next work item with no restart
// (ADR-0001).
import { createForkWorkItem } from "#assignor/fork.mts";
import { Assignor } from "#assignor/index.mts";
import { PauseStore } from "#assignor/pause.mts";
import { Reconciler } from "#assignor/reconcile.mts";
import { createScheduler } from "#assignor/scheduler.mts";
import { StateStore } from "#assignor/state.mts";
import {
  eventLogPath,
  fallbackLogPath,
  pausePath,
  pidPath,
  resultPath,
  resultsDir,
  runLogPath,
  statePath,
} from "#lib/paths.mts";
import { createLogger } from "#services/destinations.mts";
import { Forwarders } from "#services/github/forwarder.mts";
import { Gh } from "#services/github/index.mts";
import { createReceiver } from "#services/github/receiver.mts";
import { SandboxService } from "#services/sandbox.mts";
// Relative, unlike everything above: `boot.mts` is a root file and the root has no
// subpath alias of its own (package.json `imports`).
import { Boot, readRoutingTable } from "./boot.mts";

// Its own port for as long as v1 owns `LISTENER_PORT`: both pipelines are supervised
// side by side until cutover (#45), and sharing the number is an EADDRINUSE crash loop.
const port = Number(process.env.V2_PORT ?? 8788);
// One global cap across every repo, because there is one shared agent quota.
const maxConcurrency = Number(process.env.MAX_CONCURRENCY ?? 3);

// The parent has no work item of its own to attribute lines to, so its run log is the
// fallback one — nothing Sunday says is durable nowhere. Built BEFORE the routing table
// is read, which is the whole reason these two lines are in this order.
const logger = createLogger({ runLog: fallbackLogPath, eventLog: eventLogPath });
const log = logger.child("main");

// The one thing that stops the boot. A table Sunday cannot read is a pipeline that would
// answer nothing while looking healthy — and v1 reported it as a bare stack on a stdout
// nobody keeps, so it is a durable error line first and a non-zero exit second.
const repos = readRoutingTable(loadRepos, log);
if (!repos) process.exit(1);

const scheduler = createScheduler(maxConcurrency, logger.child("scheduler"));
const state = new StateStore(statePath);
// One `Gh`: the Assignor takes the two writes it is allowed (claim, release) and
// reconcile the wider read seam, off the same CLI and the same token.
const github = new Gh();

const assignor = new Assignor({
  repos,
  github,
  log: logger.child("assignor"),
  scheduler,
  state,
  fork: createForkWorkItem(),
  paths: { resultPath, pidPath, runLogPath, eventLogPath },
});

const reconciler = new Reconciler({ repos, github, assignor, log: logger.child("reconcile") });

const sandbox = new SandboxService(logger);

const boot = new Boot({
  repos,
  scheduler,
  pause: new PauseStore(pausePath),
  state,
  assignor,
  buildImages: (table, parentRoot) => sandbox.buildImages(table, parentRoot),
  reconcile: () => reconciler.run(),
  // This file sits at the workspace root, which is what the routing table's child paths
  // are relative to.
  parentRoot: import.meta.dirname,
  paths: { resultsDir, resultPath },
  log: logger.child("boot"),
});

const receiver = createReceiver({
  port,
  log: logger.child("receiver"),
  onDelivery: (delivery) => assignor.handle(delivery),
});

// Bound BEFORE the boot line, so "up" means a delivery arriving now is answered. A port
// already taken rejects here and takes the process down with a stack — silently not
// listening is a pipeline that receives nothing and says nothing about it.
const bound = await receiver.start();
log.info(`▶ up on http://localhost:${bound} — routing ${Object.keys(repos).length} repo(s), cap ${maxConcurrency}`);

// The port it ACTUALLY bound, not the one asked for: a forwarder pointed at a socket
// nothing is listening on is a blackout that looks exactly like a quiet day.
const forwarders = new Forwarders({
  repos: Object.keys(repos),
  port: bound,
  github,
  // The existing per-repo pass, so the blackout catch-up and boot's re-derive cannot
  // drift (#40 constraint 7).
  reconcile: (repo) => reconciler.repo(repo),
  log: logger.child("forwarder"),
});

// Registered BEFORE the first spawn: a stop landing mid-start must still reach the
// children already up. `gh` removes its own dev webhook on a clean exit and a hard stop
// strands it, after which every later start dies on `HTTP 422 … Hook already exists` — a
// blackout no amount of retrying clears. Work-item children are deliberately NOT killed:
// they outlive the parent by design and the next boot's sweep resolves what they left
// (ADR-0001).
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    log.info(`· ${signal} — stopping the forwarders`);
    forwarders.stop();
    // Explicit, because installing a handler REPLACES Node's default "die on this
    // signal": without it the supervisor's stop leaves a parent up with no relay.
    process.exit(0);
  });
}

// AFTER the bind and BEFORE the boot (constraint 8). Any other order leaves a window in
// which GitHub fires events, nothing forwards them, and the reconcile that would have
// re-derived them has already run — which is the 2026-07-24 blackout in miniature.
await forwarders.start();

// AFTER the bind, deliberately: images take minutes to build and the sweep reads disk,
// and a readiness probe that goes unanswered for that long is a SIGKILL/restart loop
// (ADR-0001). The queue is held for the whole sequence, so a delivery arriving mid-boot
// is admitted and QUEUED rather than started on a half-built image or raced against the
// sweep deciding what the last parent left behind.
await boot.run();
