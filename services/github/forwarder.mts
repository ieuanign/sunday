// services/github/forwarder.mts — the supervisor half of the event pipe. `receiver.mts`
// is the other half: the GitHub service owns both ends, so what feeds Sunday its events
// lives beside what receives them.
//
// One `gh webhook forward` per routed repo, in-process. The relay used to be
// `scripts/webhook-forward.sh` — bash, so it could only `echo`, and on 2026-07-24 one
// dropped forwarder blacked a repo out for 8h44m with a healthy parent and nobody told.
// A process that owns the children can say something when one dies and measure the gap.
//
// It CONSTRUCTS NOTHING: the spawn, the hook drop, the timings and the Logger all come in
// through the constructor, so the smoke drives the real supervisor with no `gh`, no
// network and no wall-clock waits.

import { spawn, type ChildProcess } from "node:child_process";

import type { ForwardersDeps, GitHubForwarder, ReconcileRepo, SpawnForwarder } from "./types.mts";
import type { ModuleLogger } from "#services/logger.mts";

/** The events Sunday relays, ported verbatim from the retired shell launcher. */
const EVENTS = "issues,issue_comment,pull_request,pull_request_review_comment";

/** How long a dropped forwarder waits before its FIRST respawn, ported from the retired
 *  launcher's poll interval. It doubles per consecutive failure from there. */
const RETRY_MS = 5_000;

/** How many times the retry may double. A forwarder that never comes back would
 *  otherwise re-read (and re-DELETE) hooks every 5s forever, on the same rate limit the
 *  live pipeline spends. At the 5s base this caps the wait at ~5 minutes. */
const BACKOFF_CAP = 6;

/** How long a respawned forwarder must stay up before the blackout is called closed.
 *  Recovery is decided by SURVIVAL, not by parsing gh's stdout: matching on "Forwarding
 *  events…" would tie the catch-up to another tool's wording. */
const SETTLE_MS = 30_000;

/** How much of a dying forwarder's stderr the drop alert carries. Enough for gh's own
 *  last words, short enough for a phone. */
const STDERR_TAIL = 400;

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A blackout, as a human reads it off a phone — the 2026-07-24 gap was "8h44m", and that
 *  is the number the alert exists to state. Sub-second stays in milliseconds so a smoke's
 *  window is a real measurement rather than a rounded-off "0s". */
function humanise(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  const s = Math.floor(ms / 1_000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m${s % 60}s` : `${Math.floor(m / 60)}h${m % 60}m`;
}

/** The real one: `gh webhook forward`, with the retired launcher's flags unchanged.
 *  stdout is dropped rather than inherited — nothing Sunday says goes to a stdout the
 *  Logger does not own — but stderr is PIPED, because gh's own last words are what the
 *  drop alert carries, and an `echo`-only launcher is exactly why this issue exists. */
function ghWebhookForward(repo: string, url: string): ChildProcess {
  return spawn("gh", ["webhook", "forward", "--repo", repo, "--events", EVENTS, "--url", url], {
    stdio: ["ignore", "ignore", "pipe"],
  });
}

export class Forwarders {
  // Declared, not parameter properties: Node runs `.mts` in strip-only mode, which
  // rejects `constructor(private x)`.
  private readonly repos: string[];
  private readonly url: string;
  private readonly github: GitHubForwarder;
  private readonly reconcile: ReconcileRepo;
  private readonly log: ModuleLogger;
  private readonly retryMs: number;
  private readonly settleMs: number;
  private readonly spawn: SpawnForwarder;
  /** The live child per repo — one entry per repo that has one right now. It is also the
   *  identity check: an `exit` from a child this map no longer holds is a forwarder that
   *  has already been dealt with (or one `stop()` killed), and it respawns nothing. */
  private readonly children = new Map<string, ChildProcess>();
  /** The pending respawn per repo, so `stop()` can cancel one that has not fired yet. */
  private readonly retries = new Map<string, NodeJS.Timeout>();
  /** The settle window each live child is serving, same reason. */
  private readonly settling = new Map<string, NodeJS.Timeout>();
  /** When each OPEN blackout started. Presence is the "already alerted" flag that makes a
   *  crash-looping forwarder one phone message rather than one every few seconds
   *  (constraint 6); the value is what the recovery line measures the gap from. */
  private readonly downSince = new Map<string, number>();
  /** Consecutive failures per repo — the backoff's exponent. Reset by a settled recovery,
   *  never by a respawn that merely started. */
  private readonly failures = new Map<string, number>();
  /** The tail of each live child's stderr, so the drop alert can say WHY. */
  private readonly stderr = new Map<string, string>();
  private stopped = false;

  constructor(deps: ForwardersDeps) {
    this.repos = deps.repos;
    this.url = `http://localhost:${deps.port}/`;
    this.github = deps.github;
    this.reconcile = deps.reconcile;
    this.log = deps.log;
    this.retryMs = deps.retryMs ?? RETRY_MS;
    this.settleMs = deps.settleMs ?? SETTLE_MS;
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
    for (const timer of [...this.retries.values(), ...this.settling.values()]) clearTimeout(timer);
    this.retries.clear();
    this.settling.clear();
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
      this.watchStderr(repo, child);
      this.settle(repo, child);
      this.log.info(`▶ forwarding ${repo} → ${this.url} (pid ${child.pid})`, { repo });
    } catch (err) {
      // `spawn` reports asynchronously, so this is the synchronous refusal only (bad
      // arguments, no file descriptors left). A repo with no forwarder is a blackout
      // however it got there, so it opens one like any other failure.
      this.down(repo, undefined, `could not be started — ${describe(err)}`);
    }
  }

  /** Keep the tail of what this child says on stderr, so the drop alert can carry gh's
   *  own last words — the diagnostic the retired bash launcher could never give.
   *  Cleared per spawn: what the alert must not do is attribute a dead forwarder's
   *  complaint to the one that replaced it. */
  private watchStderr(repo: string, child: ChildProcess): void {
    this.stderr.delete(repo);
    child.stderr?.setEncoding("utf8");
    const keep = (text: string): void => void this.stderr.set(repo, ((this.stderr.get(repo) ?? "") + text).slice(-STDERR_TAIL));
    child.stderr?.on("data", (chunk: string) => keep(chunk));
    // A stream `error` nobody listens for is an uncaught exception in the parent
    // (constraint 3), and a pipe that broke is itself worth saying in the alert.
    child.stderr?.on("error", (err) => keep(`\n[stderr unreadable: ${describe(err)}]`));
  }

  /** One repo's forwarder is gone. Respawns THAT repo alone and never touches the others
   *  — on 2026-07-24 one drop took the whole group down and blacked out every repo's
   *  events for 8h44m (constraint 4).
   *
   *  A child this map no longer holds has already been dealt with, or was killed by
   *  `stop()`: either way it respawns nothing. */
  private down(repo: string, child: ChildProcess | undefined, why: string): void {
    // `undefined` is the spawn that never produced a child at all; it is this repo's
    // forwarder by definition and skips the identity check.
    if (child && this.children.get(repo) !== child) return;
    this.children.delete(repo);
    // This child will never serve its settle window now, and a timer left on the loop for
    // the length of one is a shutdown that hangs for no reason.
    clearTimeout(this.settling.get(repo));
    this.settling.delete(repo);
    const failures = (this.failures.get(repo) ?? 0) + 1;
    this.failures.set(repo, failures);
    const delay = this.retryMs * 2 ** Math.min(failures - 1, BACKOFF_CAP);

    if (this.downSince.has(repo)) {
      // The blackout is already open and already alerted. A second phone line per respawn
      // is what turns a crash-looping forwarder into phone spam (constraint 6).
      this.log.info(`✗ ${repo} forwarder is down again (${why}) — respawning in ${delay}ms (failure ${failures})`, { repo });
    } else {
      const at = Date.now();
      this.downSince.set(repo, at);
      const tail = (this.stderr.get(repo) ?? "").trim();
      // The line the whole issue exists for, and the only place the START of a blackout is
      // recorded — the window is durable through the Logger's event log, not a store
      // nobody would read (constraint 9). `alert`, so it reaches the phone; no `target`,
      // so a relay drop never lands on somebody's issue thread (constraint 10).
      this.log.alert(
        `⚠ ${repo} forwarder is DOWN (${why}) as of ${new Date(at).toISOString()} — its events are reaching nobody; respawning in ${delay}ms${tail ? ` · stderr: ${tail}` : ""}`,
        { repo },
      );
    }
    this.retry(repo, delay);
  }

  /** A forwarder is only called recovered once it has STAYED up for the settle window: a
   *  child that dies before it closes nothing, which is what stops a crash loop being a
   *  phone message and a full re-derive every few seconds (constraint 6). Survival rather
   *  than gh's stdout, so recovery is not tied to another tool's wording. */
  private settle(repo: string, child: ChildProcess): void {
    this.settling.set(
      repo,
      setTimeout(() => {
        this.settling.delete(repo);
        // Still THIS child, and still the live one: anything else has already gone down.
        if (this.children.get(repo) !== child) return;
        this.failures.delete(repo);
        void this.recovered(repo);
      }, this.settleMs),
    );
  }

  /** Close the blackout: say how long it ran, then catch that repo up. Nothing here may
   *  throw — it is reached from a timer with nobody above it, and an unhandled rejection
   *  takes the parent down under `restart: always` (constraint 3). */
  private async recovered(repo: string): Promise<void> {
    const since = this.downSince.get(repo);
    // A first, healthy start: no blackout was ever open, so there is nothing to close and
    // nothing was missed.
    if (since === undefined) return;
    this.downSince.delete(repo);
    // The other half of the durable window (constraint 9): start AND duration, on the one
    // line a human reads off their phone.
    this.log.alert(
      `▶ ${repo} forwarder recovered — it was down from ${new Date(since).toISOString()} for ${humanise(Date.now() - since)}; re-deriving what it missed`,
      { repo },
    );
    try {
      // The EXISTING per-repo pass, never a second copy of admission (constraint 7): a
      // live path and a recovery path that drift are the defect class this rewrite exists
      // to kill.
      await this.reconcile(repo);
    } catch (err) {
      this.log.error(`✗ ${repo}: catching up after the blackout failed — ${describe(err)}`, { repo });
    }
  }

  private retry(repo: string, delay: number): void {
    this.retries.set(
      repo,
      setTimeout(() => {
        this.retries.delete(repo);
        void this.forward(repo);
      }, delay),
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
