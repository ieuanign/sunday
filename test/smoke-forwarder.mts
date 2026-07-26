// test/smoke-forwarder.mts — hermetic smoke for the forwarder supervisor (V2, issue #40).
//   devbox run node test/smoke-forwarder.mts
// The REAL `Forwarders` drives REAL child processes — a trivial `node -e` that sleeps —
// so exit and kill are exercised for real with no `gh`, no network and no GitHub token.
// The hook drop and the timings are injected, which is what makes a respawn assertable in
// milliseconds rather than in the 5 seconds the live retry takes. $0, offline.

import { spawn, type ChildProcess } from "node:child_process";

import { Forwarders } from "../services/github/forwarder.mts";
import type { GitHubForwarder } from "../services/github/index.mts";
import { Logger, type Destinations, type LogLine } from "../services/logger.mts";

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

/** One spawned forwarder as the smoke sees it. */
interface Spawned {
  repo: string;
  url: string;
  child: ChildProcess;
}

/** The real supervisor, with the two things it must not reach in a smoke substituted: the
 *  `gh` hook drop (recorded, and made to throw where a case needs it) and the child it
 *  spawns — a real node process that stays alive until it is killed. */
function harness(repos: string[], opts: { dropThrows?: string; retryMs?: number; holdDrop?: boolean } = {}) {
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

  const spawned: Spawned[] = [];
  const forwarders = new Forwarders({
    repos,
    port: 8788,
    github,
    log: new Logger(dests).child("forwarder"),
    retryMs: opts.retryMs ?? 20,
    spawn: (repo, url) => {
      // A real child that outlives the call and dies only when it is killed or when the
      // case kills it — which is what makes "respawned" and "stopped" observable.
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      started.push(child);
      spawned.push({ repo, url, child });
      return child;
    },
  });

  const forOf = (repo: string) => spawned.filter((s) => s.repo === repo);
  return { forwarders, lines, comments, dropped, spawned, forOf, release: () => release() };
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
