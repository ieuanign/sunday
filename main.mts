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
import { createScheduler } from "#assignor/scheduler.mts";
import { StateStore } from "#assignor/state.mts";
import { eventLogPath, fallbackLogPath, pidPath, resultPath, runLogPath, statePath } from "#lib/paths.mts";
import { createLogger } from "#services/destinations.mts";
import { Gh } from "#services/github/index.mts";
import { createReceiver } from "#services/github/receiver.mts";

// Its own port for as long as v1 owns `LISTENER_PORT`: both pipelines are supervised
// side by side until cutover (#45), and sharing the number is an EADDRINUSE crash loop.
const port = Number(process.env.V2_PORT ?? 8788);
// One global cap across every repo, because there is one shared agent quota.
const maxConcurrency = Number(process.env.MAX_CONCURRENCY ?? 3);
const repos = loadRepos(); // fail fast on a malformed routing table

// The parent has no work item of its own to attribute lines to, so its run log is the
// fallback one — nothing Sunday says is durable nowhere.
const logger = createLogger({ runLog: fallbackLogPath, eventLog: eventLogPath });
const log = logger.child("main");

const assignor = new Assignor({
  repos,
  github: new Gh(),
  log: logger.child("assignor"),
  scheduler: createScheduler(maxConcurrency, logger.child("scheduler")),
  state: new StateStore(statePath),
  fork: createForkWorkItem(),
  paths: { resultPath, pidPath, runLogPath, eventLogPath },
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
