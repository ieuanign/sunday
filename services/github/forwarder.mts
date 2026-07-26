// services/github/forwarder.mts — the supervisor half of the event pipe. `receiver.mts`
// is the other half: the GitHub service owns both ends, so what feeds Sunday its events
// lives beside what receives them.
//
// One `gh webhook forward` per routed repo, in-process. The relay used to be
// `scripts/webhook-forward.sh` — bash, so it could only `echo`, and on 2026-07-24 one
// dropped forwarder blacked a repo out for 8h44m with a healthy listener and nobody told.
// A process that owns the children can say something when one dies and measure the gap.
//
// It CONSTRUCTS NOTHING: the spawn, the hook drop, the timings and the Logger all come in
// through the constructor, so the smoke drives the real supervisor with no `gh`, no
// network and no wall-clock waits.

import { spawn, type ChildProcess } from "node:child_process";

import type { GitHubForwarder } from "./index.mts";
import type { ModuleLogger } from "#services/logger.mts";

/** The events Sunday relays, ported verbatim from the retired shell launcher. */
const EVENTS = "issues,issue_comment,pull_request,pull_request_review_comment";

/** How long a dropped forwarder waits before it is respawned, ported from the retired
 *  launcher's poll interval. */
const RETRY_MS = 5_000;

/** How one repo's forwarder is actually started. Injected so a smoke can drive the real
 *  supervisor over a child that is not `gh`. */
export type SpawnForwarder = (repo: string, url: string) => ChildProcess;

export interface ForwardersDeps {
  /** The routed repos, `<owner>/<repo>` — the routing table's own keys. Names only: a
   *  forwarder cares about nothing else in a repo's config. */
  repos: string[];
  /** The port the receiver ACTUALLY bound, so the forwarders can never be pointed at a
   *  socket nothing is listening on. */
  port: number;
  github: GitHubForwarder;
  log: ModuleLogger;
  retryMs?: number;
  spawn?: SpawnForwarder;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The real one: `gh webhook forward`, with the retired launcher's flags unchanged.
 *  Output is dropped rather than inherited — nothing Sunday says goes to a stdout the
 *  Logger does not own. */
function ghWebhookForward(repo: string, url: string): ChildProcess {
  return spawn("gh", ["webhook", "forward", "--repo", repo, "--events", EVENTS, "--url", url], { stdio: "ignore" });
}

export class Forwarders {
  // Declared, not parameter properties: Node runs `.mts` in strip-only mode, which
  // rejects `constructor(private x)`.
  private readonly repos: string[];
  private readonly url: string;
  private readonly github: GitHubForwarder;
  private readonly log: ModuleLogger;
  private readonly retryMs: number;
  private readonly spawn: SpawnForwarder;
  /** The live child per repo — one entry per repo that has one right now. It is also the
   *  identity check: an `exit` from a child this map no longer holds is a forwarder that
   *  has already been dealt with (or one `stop()` killed), and it respawns nothing. */
  private readonly children = new Map<string, ChildProcess>();
  /** The pending respawn per repo, so `stop()` can cancel one that has not fired yet. */
  private readonly retries = new Map<string, NodeJS.Timeout>();
  private stopped = false;

  constructor(deps: ForwardersDeps) {
    this.repos = deps.repos;
    this.url = `http://localhost:${deps.port}/`;
    this.github = deps.github;
    this.log = deps.log;
    this.retryMs = deps.retryMs ?? RETRY_MS;
    this.spawn = deps.spawn ?? ghWebhookForward;
  }

  /** One forwarder per routed repo, resolving once every repo has been spawned or
   *  reported. */
  async start(): Promise<void> {
    // Said out loud: a relay that silently forwards nothing looks exactly like a healthy
    // one nobody is sending events to.
    if (this.repos.length === 0) {
      this.log.info("no repos routed — forwarding nothing");
      return;
    }
    for (const repo of this.repos) await this.forward(repo);
  }

  /** SIGTERM every child, so `gh` removes its own dev webhook on the way out. A hard stop
   *  strands that hook and every later start dies on `HTTP 422 … Hook already exists`. */
  stop(): void {
    this.stopped = true;
    for (const retry of this.retries.values()) clearTimeout(retry);
    this.retries.clear();
    const children = [...this.children.values()];
    // Cleared BEFORE the kills: the `exit` each one fires must find no live entry for its
    // repo, which is what stops a deliberate stop from being respawned as a drop.
    this.children.clear();
    for (const child of children) child.kill("SIGTERM");
  }

  /** (Re)start one repo's forwarder. Never rejects: it is reached from a respawn timer
   *  with nobody above it, where a rejection is an unhandled one and the parent dies
   *  under `restart: always` — the crash loop ADR-0001 exists to stop (constraint 3). */
  private async forward(repo: string): Promise<void> {
    await this.dropStrandedHook(repo);
    // The drop is a `gh api` round-trip, so a stop lands inside one sooner or later. A
    // child spawned after it is one nothing will ever SIGTERM, and gh's own dev webhook
    // is stranded with it (constraint 11).
    if (this.stopped) return;
    try {
      const child = this.spawn(repo, this.url);
      this.children.set(repo, child);
      // `error` is listened for ALWAYS: an unhandled `error` on a child emitter is an
      // uncaught exception (same reasoning as `assignor/fork.mts`). A child that never
      // starts emits `error` and no `exit`; one that ran emits `exit`. Either is this
      // forwarder going down, and the map's identity check makes it count once.
      child.on("error", (err) => this.down(repo, child, describe(err)));
      child.on("exit", (code, signal) => this.down(repo, child, signal ? `killed by ${signal}` : `exited ${code}`));
      this.log.info(`▶ forwarding ${repo} → ${this.url} (pid ${child.pid})`, { repo });
    } catch (err) {
      // `spawn` reports asynchronously, so this is the synchronous refusal only (bad
      // arguments, no file descriptors left). Retried like any other drop: the relay's
      // job is to come back unattended.
      this.log.info(`✗ ${repo} forwarder could not be started — ${describe(err)}; retrying`, { repo });
      this.retry(repo);
    }
  }

  /** One repo's forwarder is gone. Respawns THAT repo alone and never touches the others
   *  — on 2026-07-24 one drop took the whole group down and blacked out every repo's
   *  events for 8h44m (constraint 4).
   *
   *  A child this map no longer holds has already been dealt with, or was killed by
   *  `stop()`: either way it respawns nothing. */
  private down(repo: string, child: ChildProcess, why: string): void {
    if (this.children.get(repo) !== child) return;
    this.children.delete(repo);
    this.log.info(`✗ ${repo} forwarder is down (${why}) — respawning in ${this.retryMs}ms`, { repo });
    this.retry(repo);
  }

  private retry(repo: string): void {
    this.retries.set(
      repo,
      setTimeout(() => {
        this.retries.delete(repo);
        void this.forward(repo);
      }, this.retryMs),
    );
  }

  /** Drop the hook a hard-killed forwarder left behind, BEFORE spawning: `gh` keeps one
   *  dev webhook per repo and refuses to register a second, so a stranded one is a
   *  blackout no amount of retrying clears.
   *
   *  A drop that fails NEVER blocks the spawn (constraint 5): the delete needs admin
   *  rights on the child repo, and a token that lacks them must not be able to strand the
   *  relay. Reported at `info` rather than `error` — it is retried on every respawn, and
   *  a crash-looping forwarder must not turn it into phone spam. */
  private async dropStrandedHook(repo: string): Promise<void> {
    try {
      await this.github.dropForwarderHooks(repo);
    } catch (err) {
      this.log.info(`· ${repo}: no stranded forwarder hook dropped — ${describe(err)}; forwarding anyway`, { repo });
    }
  }
}
