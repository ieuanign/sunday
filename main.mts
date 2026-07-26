// main.mts — the V2 parent process. It owns the services, the Assignor and the queue,
// and it owns no work: every work item runs in a forked child (ADR-0001), so a `gh` or
// `git` call that blocks blocks only that child and never the socket this process
// answers on.
//
//   npm run v2                     # node --env-file=.env main.mts
//   gh webhook forward --repo <owner/repo> \
//     --events issues,issue_comment,pull_request,pull_request_review_comment \
//     --url "http://localhost:8788/"
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

const assignor = new Assignor({
  repos,
  github: new Gh(),
  log: logger.child("assignor"),
  scheduler,
  state,
  fork: createForkWorkItem(),
  paths: { resultPath, pidPath, runLogPath, eventLogPath },
});

const sandbox = new SandboxService(logger);

const boot = new Boot({
  repos,
  scheduler,
  pause: new PauseStore(pausePath),
  state,
  assignor,
  buildImages: (table, parentRoot) => sandbox.buildImages(table, parentRoot),
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

// AFTER the bind, deliberately: images take minutes to build and the sweep reads disk,
// and a readiness probe that goes unanswered for that long is a SIGKILL/restart loop
// (ADR-0001). The queue is held for the whole sequence, so a delivery arriving mid-boot
// is admitted and QUEUED rather than started on a half-built image or raced against the
// sweep deciding what the last parent left behind.
await boot.run();
