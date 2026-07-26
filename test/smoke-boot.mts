// test/smoke-boot.mts — hermetic smoke for what happens when the V2 parent starts.
//   devbox run node test/smoke-boot.mts
// Section one is PURE: the durable pause state (assignor/pause.mts) that survives the
// restart the in-memory scheduler flag does not, and the rule that decides what boot does
// with one it finds armed. The store takes its file path at construction, so this drives
// the real module against a throwaway dir and never the real `var/pause.json`.
// The sections after it drive the real `Boot` over the real scheduler, state store, pause
// store, Assignor and Logger, with the two things that reach the world substituted — the
// image build and GitHub — and every path pointing into the case's own dir.
// $0, no network, no GitHub.

import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { Boot, type BuildImages, readRoutingTable } from "../boot.mts";
import type { RepoConfig } from "#config/repos.mts";
import { Assignor, type ForkWorkItem, type Paths } from "../assignor/index.mts";
import { PauseStore, rearmAction } from "../assignor/pause.mts";
import { createScheduler } from "../assignor/scheduler.mts";
import { StateStore } from "../assignor/state.mts";
import { acquireLock, readLock } from "../lib/lock.mts";
import { writeOutcome } from "../lib/outcome.mts";
import type { GitHub } from "../services/github/index.mts";
import { Logger, type Destinations, type LogLine } from "../services/logger.mts";

const dir = resolve(import.meta.dirname, "..", ".scratch", `smoke-boot-${process.pid}`);

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : `\n    ${detail}`}`);
};

/** The routing table every case boots on — one routed repo, so "routed" and "not routed"
 *  are different answers when an untrusted key off disk is checked against it. */
const TABLE: Record<string, RepoConfig> = {
  "acme/finance": {
    path: "repos/finance",
    imageName: "sunday-finance",
    promptFile: "docs/prompt.md",
    triggerLabels: ["sunday", "ready-for-agent"],
  },
};

/** A real Logger over destinations that record instead of writing: `lines` is every line
 *  at any level (the run log is the one destination every level routes to), `events` is
 *  what is durable, and `comments` is what reaches an issue. */
function capture() {
  const lines: LogLine[] = [];
  const events: LogLine[] = [];
  const comments: LogLine[] = [];
  const dests: Destinations = {
    console: () => {},
    runLog: (line) => void lines.push(line),
    eventLog: (line) => void events.push(line),
    github: (line) => void comments.push(line),
    phone: () => {},
  };
  return { logger: new Logger(dests), lines, events, comments };
}

/** Did anything say this at all? Constraint 2: boot survives every recoverable failure,
 *  which is only tolerable because each one leaves a line behind. */
const said = (lines: LogLine[], text: string) => lines.some((l) => l.message.includes(text));

/** `lib/paths.mts`'s own key-to-segment rule, so the harness names files the way the real
 *  layout would — the sweep checks a result file against the name its key resolves to. */
const slug = (key: string) => key.replace(/[^A-Za-z0-9._-]/g, "-");

let caseNo = 0;

/** One boot: the real `Boot` over the real scheduler, state store, pause store, Assignor
 *  and Logger, with the two things that reach the world substituted — the image build
 *  (docker, minutes) and GitHub (every method is a real write to a real repo). Every path
 *  points into this case's own dir, so the real `var/` is never touched. */
function harness(over: { buildImages?: BuildImages; releaseThrows?: string } = {}) {
  const caseDir = resolve(dir, `case-${caseNo++}`);
  const { logger, lines, events, comments } = capture();

  const claimed: string[] = [];
  const released: string[] = [];
  const github: GitHub = {
    claim: (repo, issue) => void claimed.push(`${repo}#${issue}`),
    release: (repo, issue) => {
      // Every method here is a real `gh` call in production, and `gh` fails: a 502, an
      // expired token, an issue somebody deleted. `releaseThrows` is one of those.
      if (over.releaseThrows === `${repo}#${issue}`) throw new Error("gh issue edit failed: HTTP 502");
      released.push(`${repo}#${issue}`);
    },
  };

  const paths: Paths = {
    resultPath: (key) => resolve(caseDir, "results", `${slug(key)}.json`),
    pidPath: (key) => resolve(caseDir, "running", `${slug(key)}.pid`),
    runLogPath: (fullName, flow) => resolve(caseDir, "log", fullName, flow, "run.log"),
    eventLogPath: resolve(caseDir, "log", "events.jsonl"),
  };

  // Boot admits nothing of its own (re-deriving from GitHub is the next commit's), so a
  // fork here would be the case reporting a defect rather than something to settle.
  const forked: string[] = [];
  const fork: ForkWorkItem = (job) => {
    forked.push(job.key);
    return new Promise(() => {});
  };

  const scheduler = createScheduler(2, logger.child("scheduler"));
  const state = new StateStore(resolve(caseDir, "state.json"));
  const pause = new PauseStore(resolve(caseDir, "pause.json"));
  const assignor = new Assignor({ repos: TABLE, github, log: logger.child("assignor"), scheduler, state, fork, paths });

  /** What the build saw when it ran — above all whether the queue was HELD, which is the
   *  whole reason the build sits inside the hold. */
  const build: { held?: boolean; repos?: string[]; root?: string } = {};
  const buildImages: BuildImages =
    over.buildImages ??
    (async (table, parentRoot) => {
      build.held = scheduler.isPaused();
      build.repos = Object.keys(table);
      build.root = parentRoot;
      return [];
    });

  const boot = new Boot({
    repos: TABLE,
    scheduler,
    pause,
    state,
    assignor,
    buildImages,
    parentRoot: caseDir,
    paths: { resultsDir: resolve(caseDir, "results"), resultPath: paths.resultPath },
    log: logger.child("boot"),
  });

  return { boot, scheduler, state, pause, paths, lines, events, comments, claimed, released, build, forked };
}

try {
  // ── not paused is the answer on almost every boot, so it is an answer and not an
  //    error: the pause file's absence is what "the pipeline may run" looks like ──
  {
    const store = new PauseStore(resolve(dir, "unpaused", "pause.json"));
    ok("unarmed: a boot that finds no pause file reads no pause", store.read() === undefined, JSON.stringify(store.read()));
  }

  // ── the point of the file: the process that armed the pause is never the one that
  //    re-arms it. The reader is a LATER process, reading a dir that a first boot may
  //    not have created yet ──
  {
    const path = resolve(dir, "durable", "pause.json");
    const armed = { reason: "quota exhausted", since: 1_000, resumeAt: 2_000 };
    new PauseStore(path).write(armed);

    const rebooted = new PauseStore(path).read();
    ok("durable: a later boot reads back the pause an earlier process armed", JSON.stringify(rebooted) === JSON.stringify(armed), JSON.stringify(rebooted));
  }

  // ── resuming disarms it for good: the file is the only thing that keeps a pause
  //    across a restart, so a resume that leaves it behind halts every later boot ──
  {
    const path = resolve(dir, "cleared", "pause.json");
    const store = new PauseStore(path);
    store.write({ reason: "quota exhausted", since: 1_000, resumeAt: 2_000 });
    store.clear();

    ok("resumed: a cleared pause leaves the next boot unpaused", new PauseStore(path).read() === undefined, JSON.stringify(new PauseStore(path).read()));
  }

  // ── the re-arm rule: a persisted pause is not simply re-applied, because most of the
  //    time boot happens AFTER the window it was waiting for. `now` is an argument, so
  //    the rule is decided here and not by whatever the clock happens to say ──
  {
    const now = 10_000;
    ok("re-arm: a quota reset that has already passed resumes", rearmAction({ reason: "quota", since: 0, resumeAt: 9_000 }, now) === "resume", rearmAction({ reason: "quota", since: 0, resumeAt: 9_000 }, now));
    ok("re-arm: a quota reset still ahead is rescheduled, not resumed", rearmAction({ reason: "quota", since: 0, resumeAt: 11_000 }, now) === "reschedule", rearmAction({ reason: "quota", since: 0, resumeAt: 11_000 }, now));
    // The boundary is a resume, not a zero-delay timer: the window is over.
    ok("re-arm: a quota reset landing exactly now resumes", rearmAction({ reason: "quota", since: 0, resumeAt: 10_000 }, now) === "resume", rearmAction({ reason: "quota", since: 0, resumeAt: 10_000 }, now));
    // No resumeAt means nothing knows when this is safe again — a 403, or a quota whose
    // reset time could not be read. Guessing a time here is spending the quota to find out.
    ok("re-arm: a pause with no reset time stays halted for a human", rearmAction({ reason: "403 from GitHub", since: 0 }, now) === "halt", rearmAction({ reason: "403 from GitHub", since: 0 }, now));
  }

  // ── the ONE fatal preflight (constraint 2). Everything else boot does is survivable,
  //    but a routing table Sunday cannot read is not a pipeline with no repos — it is a
  //    pipeline that would silently answer nothing, so it refuses to start. v1 threw a
  //    bare stack instead, which under `restart: always` is a crash loop nobody kept a
  //    record of ──
  {
    const { logger, lines, events } = capture();
    const log = logger.child("main");

    ok("config: a table that loads is what boot runs on", readRoutingTable(() => TABLE, log) === TABLE, JSON.stringify(readRoutingTable(() => TABLE, log)));

    const refused = readRoutingTable(() => {
      throw new Error("config/repos.json: acme/finance.imageName must be a non-empty string");
    }, log);
    ok("config: a malformed routing table refuses the boot rather than starting on half of it", refused === undefined, JSON.stringify(refused));
    ok("config: and it refuses DURABLY — an exit code alone tells the next human nothing", events.some((l) => l.level === "error" && l.message.includes("imageName")), JSON.stringify(events.map((l) => `${l.level} ${l.message}`)));
    ok("config: the reason names the file, since fixing it is a human's next move", said(lines, "config/repos.json"), JSON.stringify(lines.map((l) => l.message)));
  }

  // ── the hold. The receiver is already bound when boot runs, so a delivery can arrive
  //    while the images are still building and while the sweep is still deciding what the
  //    dead parent left behind. Held, it is queued and waits; unheld, it starts on a
  //    half-built image or races the sweep for its own work item ──
  {
    const h = harness();
    await h.boot.run();

    ok("hold: the queue is held while the images build — a delivery arriving mid-build must not start on one that is half-built", h.build.held === true, JSON.stringify(h.build));
    ok("hold: every routed repo's image is (re)built, from the workspace root the children hang off", h.build.repos?.join(",") === "acme/finance" && h.build.root !== undefined, JSON.stringify(h.build));
    ok("hold: and the hold is lifted once boot is done, with nothing armed to keep it", !h.scheduler.isPaused(), JSON.stringify(h.scheduler.snapshot()));
  }

  // ── the pause a dead parent left armed. The scheduler's own flag is in-memory, so
  //    without this step a restart is how you LIFT a quota pause — and the first thing
  //    the restarted pipeline does is spend the quota it was waiting for ──
  {
    const h = harness();
    h.pause.write({ reason: "403 from GitHub — re-auth needed", since: 1_000 }); // no resumeAt: a human's to lift
    await h.boot.run();

    ok("re-arm: a halt found on disk is re-applied to the queue", h.scheduler.isPaused(), JSON.stringify(h.scheduler.snapshot()));
    ok("re-arm: with the reason it was armed for, not boot's own hold", h.scheduler.snapshot().pauseReason?.includes("403") === true, JSON.stringify(h.scheduler.snapshot()));
    ok("re-arm: and it survives boot — the hold lifts, the halt does not", h.pause.read()?.reason.includes("403") === true, JSON.stringify(h.pause.read()));
    ok("re-arm: a halt awaiting a human reaches the operator, not just the log file", h.events.some((l) => l.level === "alert" && l.message.includes("403")), JSON.stringify(h.events.map((l) => `${l.level} ${l.message}`)));
    ok("re-arm: it happens BEFORE anything is re-derived, so what boot finds is held rather than run into the same wall", h.build.held === true, JSON.stringify(h.build));
  }

  // ── the common case: the pipeline was down for longer than the window it was waiting
  //    on. Re-applying a pause whose reset has passed is a pipeline that stays stopped
  //    until a human notices ──
  {
    const h = harness();
    h.pause.write({ reason: "quota exhausted", since: 1_000, resumeAt: Date.now() - 60_000 });
    await h.boot.run();

    ok("re-arm: a pause whose window has passed is disarmed on disk", h.pause.read() === undefined, JSON.stringify(h.pause.read()));
    ok("re-arm: and the queue runs again once boot has finished re-deriving", !h.scheduler.isPaused(), JSON.stringify(h.scheduler.snapshot()));
  }

  // ── a window still open: what is left of it is honoured, and the auto-resume that died
  //    with the last parent is re-scheduled. Nothing else ever fires it ──
  {
    const h = harness();
    h.pause.write({ reason: "quota exhausted", since: 1_000, resumeAt: Date.now() + 40 });
    await h.boot.run();

    ok("re-arm: a window still open holds the queue past the end of boot", h.scheduler.isPaused() && h.scheduler.snapshot().pauseReason?.includes("quota") === true, JSON.stringify(h.scheduler.snapshot()));
    ok("re-arm: and stays armed on disk, so a restart inside the window still finds it", h.pause.read()?.resumeAt !== undefined, JSON.stringify(h.pause.read()));

    await new Promise((r) => setTimeout(r, 250));
    ok("re-arm: the auto-resume is re-scheduled — it died with the parent that armed it", !h.scheduler.isPaused(), JSON.stringify(h.scheduler.snapshot()));
    ok("re-arm: and resuming disarms the pause, or the next boot re-applies a window that is over", h.pause.read() === undefined, JSON.stringify(h.pause.read()));
  }

  // ── a repo whose image did not build. Boot REPORTS and does not act (ADR-0002: setup
  //    is repo scope, and stopping that repo is #39's) — but silence here is a repo whose
  //    every run dies mid-agent as a mystery Provider failure, which is exactly how v1
  //    spent a day halted ──
  {
    const h = harness({
      buildImages: async () => [
        { fullName: "acme/finance", imageName: "sunday-finance", status: "failed", reason: "Cannot connect to the Docker daemon" },
      ],
    });
    await h.boot.run();

    const reported = h.events.find((l) => l.message.includes("sunday-finance"));
    ok("images: a failed build is reported at error — durable, and on the operator's phone", reported?.level === "error", JSON.stringify(h.events.map((l) => `${l.level} ${l.message}`)));
    ok("images: named with the repo it stops, and carrying why", reported?.context.repo === "acme/finance" && reported.message.includes("Docker daemon"), JSON.stringify(reported));
    ok("images: reported, not acted on — the pipeline still comes up for every other repo", !h.scheduler.isPaused(), JSON.stringify(h.scheduler.snapshot()));
  }

  // ── the sweep, source B: a child that finished its work item and left the outcome on
  //    disk for a parent that never came back to read it. The work is DONE — the PR is
  //    open — but until this runs the issue keeps a claim nobody will release and its
  //    state says in-flight forever ──
  {
    const key = "acme/finance#57";
    const h = harness();
    h.state.set(key, { status: "in-flight" }); // what the dead parent recorded
    writeOutcome(h.paths.resultPath(key), { key, status: "done", summary: "opened acme/finance#58", finishedAt: "2026-07-25T00:00:00.000Z" });
    await h.boot.run();

    ok("sweep: an outcome the dead parent never applied is applied now", h.state.get(key)?.status === "done", JSON.stringify(h.state.get(key)));
    ok("sweep: the result file is cleared — its presence is what stops a second apply", !existsSync(h.paths.resultPath(key)), h.paths.resultPath(key));
    ok("sweep: the claim comes off, so the issue is not left taken by a process that no longer exists", h.released.join(",") === key, h.released.join(","));
    ok("sweep: and the humans watching the issue are told what it finished as, exactly once", h.comments.length === 1 && h.comments[0]!.message.includes("opened acme/finance#58"), JSON.stringify(h.comments.map((l) => l.message)));
  }

  // ── the sweep, source B: an item the state file still calls in-flight with no child
  //    anywhere. Both sources exist because either side can be lost — a child can die
  //    before it writes an outcome at all, and then nothing on disk says the work ended.
  //    Left alone it holds its claim forever, which is a work item no delivery can ever
  //    re-admit ──
  {
    const gone = "acme/finance#57"; // died leaving no lock and no outcome
    const dead = "acme/finance#58"; // died holding its lock
    const settled = "acme/finance#59"; // already finished and applied
    const h = harness();
    h.state.set(gone, { status: "in-flight" });
    h.state.set(dead, { status: "in-flight" });
    h.state.set(settled, { status: "done" });
    acquireLock(h.paths.pidPath(dead), spawnSync(process.execPath, ["-e", ""]).pid!); // a pid that has certainly exited
    await h.boot.run();

    ok("sweep: an in-flight item whose child left nothing behind is recorded failed, not left in-flight", h.state.get(gone)?.status === "failed", JSON.stringify(h.state.get(gone)));
    ok("sweep: and its claim is released, so a human re-labelling it gets a retry", h.released.includes(gone), h.released.join(","));
    ok("sweep: a dead lock is not a live child — that item is settled too", h.state.get(dead)?.status === "failed" && h.released.includes(dead), `${JSON.stringify(h.state.get(dead))} ${h.released.join(",")}`);
    ok("sweep: and the lock the dead child never released is cleared", readLock(h.paths.pidPath(dead)) === undefined, JSON.stringify(readLock(h.paths.pidPath(dead))));
    ok("sweep: the comment says what is actually known — that the work item ended with nothing to show", h.comments.every((l) => l.message.includes("no outcome")), JSON.stringify(h.comments.map((l) => l.message)));
    ok("sweep: an item that is not in-flight is nobody's to settle — it was applied already", h.state.get(settled)?.status === "done" && !h.released.includes(settled), `${JSON.stringify(h.state.get(settled))} ${h.released.join(",")}`);
  }

  // ── the sweep touches GitHub, and GitHub fails. One work item that cannot be settled
  //    must not strand every item behind it in the queue: that is the difference between
  //    a restart being a delay and being a loss ──
  {
    const first = "acme/finance#57";
    const second = "acme/finance#58";
    const h = harness({ releaseThrows: first });
    h.state.set(first, { status: "in-flight" });
    h.state.set(second, { status: "in-flight" });
    await h.boot.run();

    ok("sweep: an item that fails on the way out does not strand the ones behind it", h.state.get(second)?.status === "failed" && h.released.includes(second), `${JSON.stringify(h.state.get(second))} ${h.released.join(",")}`);
    ok("sweep: and the one that failed is named, since it is a work item still holding its claim", said(h.lines, first) && said(h.lines, "502"), JSON.stringify(h.lines.map((l) => l.message)));
    ok("sweep: boot still finishes — the queue is released, not stranded held", !h.scheduler.isPaused(), JSON.stringify(h.scheduler.snapshot()));
  }

  // ── the one genuinely dangerous write in the whole sequence (constraint 6). Children
  //    deliberately outlive the parent (ADR-0001), so an item that is in-flight with a
  //    LIVE lock is one somebody is still working. Settling it clears the claim, and a
  //    cleared claim re-admits the issue: a second agent run on the same work, on real
  //    quota, while the first is still going ──
  {
    const key = "acme/finance#57";
    const h = harness();
    h.state.set(key, { status: "in-flight" });
    acquireLock(h.paths.pidPath(key), process.pid); // a live holder — this very process
    // Even with an outcome already on disk: a child that has written its result is still
    // running until it exits, and this parent never watched it start.
    writeOutcome(h.paths.resultPath(key), { key, status: "done", summary: "still finishing up", finishedAt: "2026-07-25T00:00:00.000Z" });
    await h.boot.run();

    ok("live child: the item stays in-flight — the process on it says so, not this parent's memory", h.state.get(key)?.status === "in-flight", JSON.stringify(h.state.get(key)));
    ok("live child: its claim stays ON, because clearing it re-admits the issue under the run in progress", h.released.length === 0, h.released.join(","));
    ok("live child: nothing is commented on the issue by a parent that is not the one working it", h.comments.length === 0, JSON.stringify(h.comments.map((l) => l.message)));
    ok("live child: the outcome is left for whoever is still holding the item", existsSync(h.paths.resultPath(key)), h.paths.resultPath(key));
    ok("live child: and its lock is not cleared out from under it", readLock(h.paths.pidPath(key))?.alive === true, JSON.stringify(readLock(h.paths.pidPath(key))));
    ok("live child: the skip is accounted for, naming the process that owns the item", said(h.lines, `pid ${process.pid}`), JSON.stringify(h.lines.map((l) => l.message)));
  }

  // ── a result file is UNTRUSTED INPUT (constraint 7). Its key becomes a work-item key,
  //    a path segment and the issue Sunday comments on and un-claims, and nothing proves
  //    the file was written by a child of ours — so every field is checked against the
  //    routing table before any of it is acted on ──
  {
    const h = harness();
    const finished = { status: "done" as const, summary: "trust me", finishedAt: "2026-07-25T00:00:00.000Z" };
    // A repo Sunday does not route: there is no such work item, and the claim it would
    // strip belongs to a repo nobody here has any business writing to.
    writeOutcome(h.paths.resultPath("evil/corp#5"), { key: "evil/corp#5", ...finished });
    // A number that is not one: it is a filename and an issue address, so "latest" is a
    // path segment and an issue that does not exist.
    writeOutcome(h.paths.resultPath("acme/finance#latest"), { key: "acme/finance#latest", ...finished });
    // A key that does not name the file it was found in (constraint 8): applied, this
    // would settle #57 out of #58's outcome — the wrong work item, comment included.
    writeOutcome(h.paths.resultPath("acme/finance#58"), { key: "acme/finance#57", ...finished });
    await h.boot.run();

    ok("untrusted: an outcome for a repo Sunday does not route is refused", h.state.get("evil/corp#5") === undefined && !h.released.includes("evil/corp#5"), `${JSON.stringify(h.state.get("evil/corp#5"))} ${h.released.join(",")}`);
    ok("untrusted: so is one whose issue number is not a number", h.state.get("acme/finance#latest") === undefined, JSON.stringify(h.state.get("acme/finance#latest")));
    ok("untrusted: and one whose key does not name the file it was read from — that outcome belongs to another work item", h.state.get("acme/finance#57") === undefined && h.state.get("acme/finance#58") === undefined, JSON.stringify([h.state.get("acme/finance#57"), h.state.get("acme/finance#58")]));
    ok("untrusted: nothing is un-claimed on the strength of a file Sunday cannot vouch for", h.released.length === 0, h.released.join(","));
    ok("untrusted: nor commented on — a comment on the wrong issue is Sunday lying in public", h.comments.length === 0, JSON.stringify(h.comments.map((l) => l.message)));
    ok("untrusted: each refusal is reported, since a stranded outcome is a work item nobody will ever settle", h.events.filter((l) => l.level === "error" && l.message.includes("refus")).length === 3, JSON.stringify(h.events.map((l) => `${l.level} ${l.message}`)));
  }

  // ── and a build that throws OUT of the sweep (a dead daemon, a missing CLI) is still
  //    not fatal: v1's preflight threw out of boot, which under `restart: always` is an
  //    infinite rebuild loop that never gets as far as answering a webhook (constraint 2) ──
  {
    const h = harness({
      buildImages: async () => {
        throw new Error("spawn sandcastle ENOENT");
      },
    });
    await h.boot.run();

    ok("images: a build that throws does not take boot down with it", said(h.lines, "ENOENT"), JSON.stringify(h.lines.map((l) => l.message)));
    ok("images: and boot still finishes — the queue is released, not stranded held", !h.scheduler.isPaused(), JSON.stringify(h.scheduler.snapshot()));
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
