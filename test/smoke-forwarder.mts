// test/smoke-forwarder.mts — hermetic smoke for the forwarder supervisor (V2, issue #40).
//   devbox run node test/smoke-forwarder.mts
// The REAL `Forwarders` drives REAL child processes — a trivial `node -e` that sleeps —
// so exit and kill are exercised for real with no `gh`, no network and no GitHub token.
// The hook drop and the timings are injected, which is what makes a respawn assertable in
// milliseconds rather than in the 5 seconds the live retry takes. $0, offline.

import { spawn, type ChildProcess } from "node:child_process";

import { Forwarders } from "#services/github/forwarder.mts";
import type { GitHubForwarder } from "#services/github/index.mts";
import { Logger, type Destinations, type LogLine } from "#services/logger.mts";

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : `\n    ${detail}`}`);
};

// ── fixtures ──────────────────────────────────────────────────────────────────

/** Every child this file ever started, killed however this process ends — a smoke that
 *  asserts its way out early must not leave a real process behind. */
const started: ChildProcess[] = [];
process.on("exit", () => {
  for (const child of started) child.kill("SIGKILL");
});

/** Poll until it holds, or give up — the supervisor works off timers and child exits, so
 *  what a case waits for is a state, never a fixed sleep. */
async function until(cond: () => boolean, ms = 2000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  return cond();
}

const alive = (child: ChildProcess): boolean => {
  try {
    // Signal 0 tests for the process rather than signalling it.
    process.kill(child.pid ?? -1, 0);
    return true;
  } catch {
    return false;
  }
};

/** Is the timestamp this line carries really when the thing happened? Parsed out of the
 *  message and bounded by the case's own clock, so a stale or invented one fails. */
function between(message: string | undefined, from: number): boolean {
  const iso = message?.match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/)?.[0];
  const at = iso === undefined ? NaN : Date.parse(iso);
  return at >= from && at <= Date.now();
}

/** One spawned forwarder as the smoke sees it. `stderr` is what THIS child really wrote:
 *  the supervisor attaches its own `data` listener and both receive every chunk, which is
 *  what lets a case wait until the stderr it asserts on has actually been delivered. */
interface Spawned {
  repo: string;
  url: string;
  child: ChildProcess;
  stderr: string;
}

/** What a spawned child runs when a case does not say otherwise: stay alive until
 *  something kills it, which is what makes "respawned" and "stopped" observable. */
const STAY_ALIVE = "setInterval(() => {}, 1000)";

interface Opts {
  dropThrows?: string;
  retryMs?: number;
  settleMs?: number;
  holdDrop?: boolean;
  reconcileThrows?: string;
  /** The `-e` source the nth spawned child runs — how a case makes a forwarder say
   *  something on its way out, or die the moment it is respawned. */
  script?: (n: number) => string;
}

/** The real supervisor, with the three things it must not reach in a smoke substituted:
 *  the `gh` hook drop (recorded, and made to throw where a case needs it), the catch-up
 *  re-derive (recorded) and the child it spawns — a real node process. */
function harness(repos: string[], opts: Opts = {}) {
  const lines: LogLine[] = [];
  /** What would land on an issue thread as a comment. A relay drop is pipeline-scope and
   *  must reach nobody's issue (constraint 10), so this stays empty. */
  const comments: LogLine[] = [];
  const drop = () => {};
  const dests: Destinations = {
    console: drop,
    // The one destination every level routes to, so a line is captured whatever it was
    // emitted at.
    runLog: (line) => void lines.push(line),
    eventLog: drop,
    github: (line) => void comments.push(line),
    phone: drop,
  };

  /** Every hook drop asked for, in order — the sequence against `spawned` is what says
   *  the drop precedes the spawn it belongs to. */
  const dropped: string[] = [];
  /** `holdDrop` keeps the drop in flight until the case releases it — the real one is a
   *  `gh api` round-trip, so a stop can land in the middle of one. */
  let release = () => {};
  const held = new Promise<void>((settle) => (release = settle));
  const github: GitHubForwarder = {
    dropForwarderHooks: async (repo) => {
      dropped.push(repo);
      if (opts.holdDrop) await held;
      if (opts.dropThrows) throw new Error(opts.dropThrows);
    },
  };

  /** Every catch-up re-derive asked for, in order — a blackout is per repo, and sweeping
   *  the whole table to catch one up spends every other repo's rate limit on a gap they
   *  never had. */
  const reconciled: string[] = [];

  const spawned: Spawned[] = [];
  const forwarders = new Forwarders({
    repos,
    port: 8788,
    github,
    log: new Logger(dests).child("forwarder"),
    retryMs: opts.retryMs ?? 20,
    settleMs: opts.settleMs ?? 40,
    reconcile: async (repo) => {
      reconciled.push(repo);
      if (opts.reconcileThrows) throw new Error(opts.reconcileThrows);
    },
    spawn: (repo, url) => {
      // A real child that outlives the call and dies only when it is killed or when the
      // case's own script ends it. stderr is PIPED because the drop alert carries the
      // child's last words — the diagnostic bash could never give.
      const source = (opts.script ?? (() => STAY_ALIVE))(spawned.length);
      const child = spawn(process.execPath, ["-e", source], { stdio: ["ignore", "ignore", "pipe"] });
      started.push(child);
      const seen: Spawned = { repo, url, child, stderr: "" };
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => (seen.stderr += chunk));
      spawned.push(seen);
      return child;
    },
  });

  const forOf = (repo: string) => spawned.filter((s) => s.repo === repo);
  const alerts = () => lines.filter((l) => l.level === "alert");
  return { forwarders, lines, comments, dropped, reconciled, spawned, forOf, alerts, release: () => release() };
}

// ── one forwarder per routed repo, each preceded by its own stranded-hook drop. `gh`
//    keeps ONE dev webhook per repo and a hard-killed forwarder strands it, so every
//    later start dies on `HTTP 422 … Hook already exists` — a blackout no amount of
//    retrying clears (constraint 5) ──
{
  const h = harness(["acme/finance", "acme/drive"]);
  await h.forwarders.start();

  ok("start: one forwarder per routed repo", h.spawned.map((s) => s.repo).join(",") === "acme/finance,acme/drive", h.spawned.map((s) => s.repo).join(","));
  ok("start: each is forwarded at the port the receiver actually bound", h.spawned.every((s) => s.url === "http://localhost:8788/"), h.spawned.map((s) => s.url).join(","));
  ok("start: a stranded forwarder hook is dropped for each repo, before its child is spawned", h.dropped.join(",") === "acme/finance,acme/drive", h.dropped.join(","));
  ok("start: and every child is really running", h.spawned.every((s) => alive(s.child)), h.spawned.map((s) => `${s.repo}:${s.child.pid}`).join(","));

  h.forwarders.stop();
  ok("start: the repos are named in the log, each line against its own repo", h.lines.some((l) => l.message.includes("acme/finance") && l.context.repo === "acme/finance"), JSON.stringify(h.lines.map((l) => `${l.level} ${l.message} ${JSON.stringify(l.context)}`)));
}

// ── a hook drop that fails never blocks the spawn. The DELETE needs admin rights on the
//    child repo; a token that lacks them would otherwise strand the whole relay, which is
//    a worse failure than the stranded hook it was trying to clear (constraint 5) ──
{
  const h = harness(["acme/finance"], { dropThrows: "HTTP 403: Must have admin rights to Repository" });
  await h.forwarders.start();

  ok("hook drop: it was attempted", h.dropped.join(",") === "acme/finance", h.dropped.join(","));
  ok("hook drop: and the forwarder is spawned anyway", h.spawned.length === 1 && alive(h.spawned[0]!.child), JSON.stringify(h.spawned.map((s) => s.repo)));
  ok("hook drop: with the reason recorded rather than swallowed", h.lines.some((l) => l.message.includes("admin rights") && l.context.repo === "acme/finance"), JSON.stringify(h.lines.map((l) => `${l.level} ${l.message}`)));
  ok("hook drop: at info — it is retried on every respawn, so it must not be phone spam", h.lines.every((l) => l.level === "info"), JSON.stringify(h.lines.map((l) => `${l.level} ${l.message}`)));

  h.forwarders.stop();
}

// ── ONE repo's forwarder is respawned, and the others are never touched. This is the
//    2026-07-24 defect verbatim: one dropped forwarder took the whole group down, and
//    every repo's events with it (constraint 4) ──
{
  const h = harness(["acme/finance", "acme/drive", "acme/ops"]);
  await h.forwarders.start();
  const dropped = h.forOf("acme/drive")[0]!.child;
  const untouched = [...h.forOf("acme/finance"), ...h.forOf("acme/ops")].map((s) => s.child);

  // How a real forwarder goes: `gh webhook forward` EXITS when its websocket drops.
  dropped.kill("SIGKILL");
  const back = await until(() => h.forOf("acme/drive").length === 2);

  ok("respawn: the repo that lost its forwarder gets a new one", back, h.spawned.map((s) => s.repo).join(","));
  const fresh = h.forOf("acme/drive")[1]?.child;
  ok("respawn: on a fresh child, not the corpse of the old one", fresh !== undefined && fresh.pid !== dropped.pid && alive(fresh), `${dropped.pid} → ${fresh?.pid}`);
  ok("respawn: the other repos are left alone — one drop must not take the group down", h.forOf("acme/finance").length === 1 && h.forOf("acme/ops").length === 1, h.spawned.map((s) => s.repo).join(","));
  ok("respawn: and their children are still the ones that were running", untouched.every(alive), untouched.map((c) => `${c.pid}:${alive(c)}`).join(","));
  ok("respawn: the stranded hook is dropped again first — the dead forwarder may have left one", h.dropped.join(",") === "acme/finance,acme/drive,acme/ops,acme/drive", h.dropped.join(","));

  h.forwarders.stop();
}

// ── a drop OPENS A BLACKOUT and says so once, on the phone, with what the child said on
//    its way out. This is the whole issue: on 2026-07-24 a forwarder dropped and the gap
//    ran 8h44m with a healthy listener and nobody told ──
{
  const h = harness(["acme/finance", "acme/drive"], {
    script: () => `process.stderr.write("websocket: close 1006 (abnormal closure)"); ${STAY_ALIVE}`,
  });
  await h.forwarders.start();
  const drive = h.forOf("acme/drive")[0]!;
  // Wait until the child has REALLY spoken, so what the alert carries is a delivered
  // chunk rather than a race the assertion happens to win.
  await until(() => drive.stderr.includes("1006"));
  const before = Date.now();

  drive.child.kill("SIGKILL");
  await until(() => h.alerts().length > 0);

  const alert = h.alerts()[0];
  ok("blackout: a drop is exactly one alert — the phone line the retired bash launcher could not send", h.alerts().length === 1, JSON.stringify(h.alerts().map((l) => l.message)));
  ok("blackout: it names the repo that lost its forwarder, and only that one", alert?.message.includes("acme/drive") === true && alert.context.repo === "acme/drive" && !alert.message.includes("acme/finance"), `${alert?.message} ${JSON.stringify(alert?.context)}`);
  ok("blackout: it carries the child's stderr — the diagnostic an `echo` could never give", alert?.message.includes("close 1006") === true, alert?.message);
  ok("blackout: and when the gap started, so the recovery line can measure it", between(alert?.message, before), alert?.message);
  ok("blackout: pipeline-scope — it carries no target and reaches no issue thread", alert?.context.target === undefined && h.comments.length === 0, `${JSON.stringify(alert?.context)} ${h.comments.length}`);
  ok("blackout: and nothing is re-derived yet — the relay is still down", h.reconciled.length === 0, h.reconciled.join(","));

  h.forwarders.stop();
}

// ── a forwarder that comes back and STAYS back closes the blackout: one alert carrying
//    the measured window, then that repo's missed work re-derived. v1 re-derived only on
//    boot, which is why a forwarder-only blackout was never caught up at all ──
{
  const h = harness(["acme/finance", "acme/drive"], { retryMs: 20, settleMs: 60 });
  await h.forwarders.start();
  const t0 = Date.now();

  h.forOf("acme/drive")[0]!.child.kill("SIGKILL");
  await until(() => h.alerts().length === 2);
  const recovery = h.alerts()[1];
  const measured = Number(recovery?.message.match(/for (\d+)ms/)?.[1]);

  ok("recovery: one alert, and only one — the blackout is opened once and closed once", h.alerts().length === 2, JSON.stringify(h.alerts().map((l) => l.message)));
  ok("recovery: it names the repo, against its own repo context", recovery?.message.includes("acme/drive") === true && recovery.context.repo === "acme/drive" && recovery.context.target === undefined, `${recovery?.message} ${JSON.stringify(recovery?.context)}`);
  ok("recovery: it says when the gap started — the drop line's timestamp, carried through", between(recovery?.message, t0), recovery?.message);
  ok("recovery: and how long it lasted, measured rather than assumed", measured >= 60 && measured <= Date.now() - t0, `${recovery?.message} vs ${Date.now() - t0}ms elapsed`);
  ok("recovery: the window is only called closed once the respawn has SURVIVED it", h.forOf("acme/drive").length === 2 && alive(h.forOf("acme/drive")[1]!.child), h.forOf("acme/drive").map((s) => `${s.child.pid}:${alive(s.child)}`).join(","));

  ok("recovery: that repo's missed work is re-derived", await until(() => h.reconciled.length > 0), h.reconciled.join(","));
  ok("recovery: exactly once, and for that repo ALONE — the others had no gap to catch up", h.reconciled.join(",") === "acme/drive", h.reconciled.join(","));

  h.forwarders.stop();
}

// ── a forwarder that keeps dying leaves the blackout OPEN: no second alert, no re-derive.
//    Otherwise a crash loop is a phone message and a full repo re-derive every few
//    seconds, against real GitHub reads (constraint 6) ──
{
  const h = harness(["acme/finance"], {
    retryMs: 20,
    // Long enough that nothing in this case can settle: every respawn dies first.
    settleMs: 5_000,
    script: (n) => (n === 0 ? STAY_ALIVE : "process.exit(1)"),
  });
  await h.forwarders.start();

  h.forOf("acme/finance")[0]!.child.kill("SIGKILL");
  await until(() => h.spawned.length >= 4);
  const waits = h.lines.flatMap((l) => l.message.match(/respawning in (\d+)ms/)?.[1] ?? []);

  ok("crash loop: still exactly one alert — the blackout is already open and stays open", h.alerts().length === 1, JSON.stringify(h.alerts().map((l) => l.message)));
  ok("crash loop: and nothing is re-derived — a catch-up per crash is a storm on real GitHub quota", h.reconciled.length === 0, h.reconciled.join(","));
  ok("crash loop: the further deaths are still recorded, just not on the phone", h.lines.filter((l) => l.level === "info" && l.message.includes("down again")).length >= 2, JSON.stringify(h.lines.map((l) => `${l.level} ${l.message}`)));
  ok("crash loop: and the wait grows, so a forwarder that never comes back cannot spend the gh rate limit on retries", waits.slice(0, 3).join(",") === "20,40,80", waits.join(","));

  h.forwarders.stop();
}

// ── the catch-up reaches GitHub, so it fails: it is recorded and survived. Nothing may
//    throw out of the settle timer — there is no caller above it, and an unhandled
//    rejection kills the parent under `restart: always`, which is the crash loop ADR-0001
//    exists to stop (constraint 3) ──
{
  const h = harness(["acme/finance"], { retryMs: 20, settleMs: 60, reconcileThrows: "HTTP 502: Bad gateway" });
  await h.forwarders.start();

  h.forOf("acme/finance")[0]!.child.kill("SIGKILL");
  ok("catch-up failure: it was attempted", await until(() => h.reconciled.length === 1), h.reconciled.join(","));
  ok("catch-up failure: and recorded with its reason, at error", await until(() => h.lines.some((l) => l.level === "error" && l.message.includes("502") && l.context.repo === "acme/finance")), JSON.stringify(h.lines.map((l) => `${l.level} ${l.message}`)));

  // The supervisor is still a supervisor: this smoke reaching here at all is the other
  // half of the assertion, since an unhandled rejection would have ended the process.
  h.forOf("acme/finance")[1]!.child.kill("SIGKILL");
  ok("after recovery: a later drop is still supervised — one failed catch-up is not the end of the relay", await until(() => h.spawned.length === 3), h.spawned.map((s) => s.child.pid).join(","));
  ok("after recovery: and it is a NEW blackout, so it is worth the phone again", h.alerts().filter((l) => l.message.includes("DOWN")).length === 2, JSON.stringify(h.alerts().map((l) => l.message)));
  ok("after recovery: from the base wait — a forwarder that recovered is not still failing", h.lines.flatMap((l) => l.message.match(/respawning in (\d+)ms/)?.[1] ?? []).join(",") === "20,20", JSON.stringify(h.lines.map((l) => l.message)));

  h.forwarders.stop();
}

// ── stop: every child is signalled, and a stop is not a drop. `gh` removes its own dev
//    webhook on a clean exit, so a child left behind strands one and every later start
//    dies on `HTTP 422 … Hook already exists` (constraint 11) ──
{
  const h = harness(["acme/finance", "acme/drive"]);
  await h.forwarders.start();
  const children = h.spawned.map((s) => s.child);

  h.forwarders.stop();

  ok("stop: every child is signalled, so gh takes its own webhook down with it", await until(() => children.every((c) => !alive(c))), children.map((c) => `${c.pid}:${alive(c)}`).join(","));
  await new Promise((r) => setTimeout(r, 100)); // several retry windows at retryMs 20
  ok("stop: and nothing comes back — a stop is a stop, not a drop", h.spawned.length === 2, h.spawned.map((s) => s.repo).join(","));
  ok("stop: and nobody is paged — a deploy must not read as a blackout", h.alerts().length === 0, JSON.stringify(h.alerts().map((l) => l.message)));
}

// ── a respawn already on the clock is cancelled too: a parent shutting down must not
//    spawn a forwarder on its way out, since nothing will be left to SIGTERM it ──
{
  const h = harness(["acme/finance"], { retryMs: 60 });
  await h.forwarders.start();
  h.forOf("acme/finance")[0]!.child.kill("SIGKILL");
  const scheduled = await until(() => h.lines.some((l) => l.message.includes("respawning")));
  ok("stop: a drop schedules a respawn", scheduled, JSON.stringify(h.lines.map((l) => l.message)));

  h.forwarders.stop();
  await new Promise((r) => setTimeout(r, 150)); // past when the respawn would have fired

  ok("stop: a respawn already on the clock never fires", h.spawned.length === 1, h.spawned.map((s) => s.repo).join(","));
  ok("stop: and no forwarder line ever reaches an issue thread — a relay drop is pipeline-scope", h.comments.length === 0, JSON.stringify(h.comments.map((l) => l.message)));
}

// ── and a spawn caught mid hook-drop is abandoned. The drop is a real `gh api`
//    round-trip, so a SIGTERM lands inside one sooner or later: a child spawned after the
//    stop is one nothing will ever SIGTERM, and gh's own dev webhook is stranded with it
//    (constraint 11) ──
{
  const h = harness(["acme/finance"], { holdDrop: true });
  const starting = h.forwarders.start();
  await until(() => h.dropped.length === 1);

  h.forwarders.stop();
  h.release();
  await starting;

  ok("stop: a spawn still inside its hook drop is abandoned, not completed after the stop", h.spawned.length === 0, h.spawned.map((s) => `${s.repo}:${s.child.pid}`).join(","));
}

// ── an empty routing table forwards nothing, and SAYS so. A relay that silently starts
//    no forwarders looks exactly like a healthy one that receives nothing ──
{
  const h = harness([]);
  await h.forwarders.start();

  ok("empty table: nothing is spawned and no hook is touched", h.spawned.length === 0 && h.dropped.length === 0, `${h.spawned.length} spawned, ${h.dropped.length} dropped`);
  ok("empty table: and it is said out loud", h.lines.some((l) => l.message.includes("no repo")), JSON.stringify(h.lines.map((l) => l.message)));

  h.forwarders.stop();
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
