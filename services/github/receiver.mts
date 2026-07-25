// services/github/receiver.mts — Sunday's front door. `gh webhook forward` pushes a
// repo's events to a LOCAL port (there is no public endpoint) and they land here.
//
// It has exactly one job: answer the readiness probe, take a POST, and hand on what the
// delivery IS. It decides nothing — routing, admission and every guard belong to the
// Assignor, so this file has nothing to keep in step with them.

import { createServer, type Server } from "node:http";

import type { Delivery } from "#assignor/index.mts";
import type { ModuleLogger } from "#services/logger.mts";

export interface ReceiverDeps {
  /** The port to bind. Constructor-injected rather than read from the environment:
   *  v1 owns `LISTENER_PORT` until cutover (#45), and `0` lets a smoke drive the real
   *  receiver on whatever the OS hands out. */
  port: number;
  log: ModuleLogger;
  /** Where a delivery goes next — the Assignor's router, in the parent. */
  onDelivery: (delivery: Delivery) => void;
}

export interface Receiver {
  /** Bind and start answering, resolving with the port actually bound (which is the
   *  OS's choice when `port` is 0). Rejects rather than warns if the port is taken:
   *  a receiver that is not listening is a pipeline that silently receives nothing. */
  start(): Promise<number>;
  stop(): Promise<void>;
}

/** As much of a webhook payload as the spine reads. Every field is optional because
 *  every field is off the wire: `gh webhook forward` relays whatever GitHub sent, and
 *  this process is the one that must not assume. */
interface Payload {
  action?: string;
  repository?: { full_name?: string };
  issue?: Subject;
  pull_request?: Subject;
}

/** The issue or pull request a delivery is about. GitHub keeps it under one key or the
 *  other, never both. */
interface Subject {
  number?: number;
  labels?: { name: string }[];
}

/** What a payload IS, in the vocabulary the Assignor decides in. Nothing here is
 *  validated: the repo is the payload's own spelling until admission matches it against
 *  the routing table, and a payload with no issue in it yields a number that is not one
 *  — which the Assignor refuses to build a work-item key out of (constraint 14). */
function normalise(event: string, payload: Payload): Delivery {
  const subject = payload.issue ?? payload.pull_request;
  return {
    event,
    action: payload.action ?? "",
    repo: payload.repository?.full_name ?? "?",
    number: Number(subject?.number),
    labels: (subject?.labels ?? []).map((label) => label.name),
  };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createReceiver({ port, log, onDelivery }: ReceiverDeps): Receiver {
  const server: Server = createServer((req, res) => {
    // The readiness probe (process-compose holds the forwarders back until this
    // answers) and a human's curl. Any GET, any path — v1's behaviour.
    if (req.method === "GET") {
      res.writeHead(200).end("sunday receiver up\n");
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }

    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      receive(String(req.headers["x-github-event"] ?? "?"), body);
      // Answered whatever came of it: the delivery is Sunday's now, and GitHub does not
      // replay a delivery it was told about anyway (a blackout is #35's to reconcile).
      res.writeHead(200).end("ok");
    });
  });

  /** One delivery, from raw body to the Assignor. Nothing thrown in here may escape:
   *  this runs inside an HTTP handler, so an exception is not a failed delivery — it is
   *  an uncaught exception that takes the whole parent process down with it. */
  function receive(event: string, body: string): void {
    let delivery: Delivery;
    try {
      delivery = normalise(event, JSON.parse(body) as Payload);
    } catch (err) {
      // Recorded, never silent (constraint 10) — but `info`, because a body nobody
      // could read names no issue to tell about it.
      log.info(`← ${event} — unreadable body (${body.length}b): ${describe(err)}`);
      return;
    }
    try {
      onDelivery(delivery);
    } catch (err) {
      // What the handler does reaches the world (it claims the issue over the `gh`
      // CLI), so this is a real path, not a defensive one. Carries NO issue context on
      // purpose: an `error` addressed at an issue posts a comment, and GitHub redelivers
      // — a broken CLI would comment on every retry. The operator gets it; the issue
      // keeps its two milestones.
      log.error(`✗ ${event}.${delivery.action} ${delivery.repo}#${delivery.number} — ${describe(err)}`);
    }
  }

  return {
    start: () =>
      new Promise((settle, fail) => {
        server.once("error", fail);
        server.listen(port, () => {
          const bound = server.address();
          settle(typeof bound === "object" && bound !== null ? bound.port : port);
        });
      }),
    stop: () => new Promise((settle) => server.close(() => settle())),
  };
}
