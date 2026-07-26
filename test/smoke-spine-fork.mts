// test/smoke-spine-fork.mts — the tracer bullet: the parent really forks the real
// `issue/run.mts` and watches what it leaves on disk. ADR-0001 — the child hands its
// result back through FILES, not through the parent's memory, so the parent can be
// killed at any instant without losing finished work or double-starting an orphan.
//   devbox run node test/smoke-spine-fork.mts
// Every path the child writes comes from the job, so this drives the real entry point
// against a throwaway dir and never the real `var/`. $0, no network, no GitHub — the
// child really runs an agent now (#36), so the job below points at a repo config that
// cannot resolve and the run fails before it can reach docker, `gh` or the network.
// What a run DECIDES once it is set up is test/smoke-issue-run.mts's.

import { fork } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { relative, resolve } from "node:path";

import { createForkWorkItem } from "../assignor/fork.mts";
// Type-only, so the entry point stays OUT of this process's module graph exactly as it
// stays out of the parent's (ADR-0001) — what is asserted below is a real fork.
import type { Job } from "../issue/run.mts";
import { readLock, type Lock } from "../lib/lock.mts";
import { readOutcome } from "../lib/outcome.mts";
import { pidPath, resultPath } from "../lib/paths.mts";

const root = resolve(import.meta.dirname, "..");
const entry = resolve(root, "issue", "run.mts");
const dir = resolve(root, ".scratch", `smoke-spine-fork-${process.pid}`);
/** The baseline prompt the child reads before it runs anything, named the way a repo
 *  config names it: RELATIVE to the workspace root. Pointed inside this smoke's own
 *  throwaway dir and never created, so the run fails on its first act — offline, with no
 *  docker, no `gh` and no quota — while still proving the child resolved its repo config
 *  against the root and reported the real reason. */
const missingPrompt = relative(root, resolve(dir, "no-such-prompt.md"));

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : `\n    ${detail}`}`);
};

/** A job exactly as the Assignor resolves one: the item's identity, how its repo is
 *  run, and every path the child writes — all pointed at this smoke's own dir. */
function jobFor(key: string, issue: number): Job {
  const slug = key.replace(/[^A-Za-z0-9._-]/g, "-");
  return {
    key,
    repo: "acme/finance",
    issue,
    // A child checkout that cannot be there and a prompt file that is not either:
    // `repos/` holds REAL clones, so a job naming a real one would fetch from the origin.
    config: { path: "repos/not-a-child", imageName: "sunday-finance", promptFile: missingPrompt, triggerLabels: ["sunday"] },
    resultPath: resolve(dir, "results", `${slug}.json`),
    pidPath: resolve(dir, "running", `${slug}.pid`),
    runLogPath: resolve(dir, "log", "acme", "finance", String(issue), "run.log"),
    eventLogPath: resolve(dir, "log", "events.jsonl"),
  };
}

interface Observed {
  pid: number | undefined;
  /** What the child said over IPC, and what the disk looked like in that instant. */
  reports: unknown[];
  outcomeOnDiskAtReport: boolean;
  /** The lock as the parent caught it mid-run — the cross-restart guard in use. */
  lockWhileAlive: Lock | undefined;
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

/** Fork the REAL entry point and watch it, exactly as the scheduler's `run()` does:
 *  settle when the child exits, so the cap and the branch lock hold for its whole life. */
function runChild(job: Job): Promise<Observed> {
  // `silent` keeps the child's own console lines out of this smoke's output and puts
  // its stderr where a failing assertion can quote it.
  const child = fork(entry, [JSON.stringify(job)], { silent: true });
  const reports: unknown[] = [];
  let outcomeOnDiskAtReport = false;
  let lockWhileAlive: Lock | undefined;
  let stderr = "";

  // Watch for the lock from the fork onwards — a `message` handler would sample too
  // late, since by the time the parent is woken the child may already have released
  // it and gone. `setImmediate` re-queues behind the I/O phase, so this samples
  // continuously without starving the child's own events.
  let watching = true;
  const watch = (): void => {
    if (!watching) return;
    lockWhileAlive ??= readLock(job.pidPath);
    setImmediate(watch);
  };
  watch();

  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  child.on("message", (message) => {
    // Sampled HERE, not after the exit: the whole point of constraint 3 is that the
    // file is already readable the moment the parent hears about it.
    if (reports.length === 0) outcomeOnDiskAtReport = existsSync(job.resultPath);
    reports.push(message);
  });
  return new Promise((settle) => {
    child.on("exit", (code, signal) => {
      watching = false;
      settle({ pid: child.pid, reports, outcomeOnDiskAtReport, lockWhileAlive, code, signal, stderr });
    });
  });
}

try {
  // ── the round trip: what the child wrote is what the parent applies. This job names a
  //    baseline prompt that is not there, which is a real misconfiguration and the one
  //    kind of failure this smoke can reach offline — and the child's whole bargain is
  //    that it leaves a durable outcome SAYING SO rather than an exit code the parent has
  //    to guess a reason for ──
  {
    const job = jobFor("acme/finance#57", 57);
    const observed = await runChild(job);
    ok("the child runs to a clean exit", observed.code === 0 && observed.signal === null, `code=${observed.code} signal=${observed.signal}\n    ${observed.stderr}`);

    // ── constraint 3: the parent may die in the instant between the two, so the
    //    durable half has to be finished first. The IPC message is a notification that
    //    an outcome is READY, never the outcome itself ──
    ok("the child reports back over IPC exactly once", observed.reports.length === 1, JSON.stringify(observed.reports));
    ok(
      "the outcome is already on disk in the instant the report arrives",
      observed.outcomeOnDiskAtReport,
      `report=${JSON.stringify(observed.reports[0])}`,
    );
    ok(
      "the report names the work item whose outcome is waiting",
      JSON.stringify(observed.reports[0]) === JSON.stringify({ type: "outcome", key: "acme/finance#57" }),
      JSON.stringify(observed.reports[0]),
    );

    const read = readOutcome(job.resultPath);
    ok("the outcome is on disk where the job said to put it", read.state === "ok", `${JSON.stringify(read)}\n    ${observed.stderr}`);
    ok(
      "it names the work item it belongs to and how the run finished",
      read.state === "ok" && read.outcome.key === "acme/finance#57" && read.outcome.status === "failed",
      JSON.stringify(read),
    );
    ok(
      "a run that could not even be set up says WHY, rather than claiming an agent did any work",
      read.state === "ok" && read.outcome.summary.includes("no-such-prompt.md") && !Number.isNaN(Date.parse(read.outcome.finishedAt)),
      JSON.stringify(read),
    );
  }

  // ── the lock: what a parent that comes back up asks instead of its own memory.
  //    Children deliberately outlive the parent (hot-reload, crash, deploy), so a live
  //    lock is the only honest answer to "is someone already on this?" ──
  {
    const job = jobFor("acme/finance#58", 58);
    const observed = await runChild(job);
    ok("the child runs to a clean exit", observed.code === 0, `code=${observed.code}\n    ${observed.stderr}`);
    ok(
      "it holds a lock naming its own process for as long as it is alive",
      observed.lockWhileAlive?.pid === observed.pid && observed.lockWhileAlive?.alive === true,
      `child pid ${observed.pid}, lock ${JSON.stringify(observed.lockWhileAlive)}\n    ${observed.stderr}`,
    );
    ok(
      "the lock is gone once the child has exited, so the next run is not wedged",
      readLock(job.pidPath) === undefined,
      JSON.stringify(readLock(job.pidPath)),
    );
  }

  // ── the parent that GOES while the child is still working (a hot-reload save, a
  //    crash, a deploy). Its report then lands on a closed IPC channel, which is what
  //    `disconnect()` reproduces here: the exact ERR_IPC_CHANNEL_CLOSED path, with no
  //    process-tree gymnastics. The outcome is durable BEFORE the report (ADR-0001), so
  //    a message nobody is listening for costs a boot sweep and nothing else — the run
  //    has to finish anyway ──
  {
    const job = jobFor("acme/finance#63", 63);
    const child = fork(entry, [JSON.stringify(job)], { silent: true });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    // Before the child can possibly report: from here on its channel is closed for good.
    child.disconnect();
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((settle) => {
      child.on("exit", (code, signal) => settle({ code, signal }));
    });

    ok(
      "a child whose parent has gone still runs to a clean exit",
      exit.code === 0 && exit.signal === null,
      `code=${exit.code} signal=${exit.signal}\n    ${stderr}`,
    );
    const read = readOutcome(job.resultPath);
    ok(
      "its outcome is on disk anyway, saying how the run finished, for the next parent to apply",
      read.state === "ok" && read.outcome.key === "acme/finance#63" && read.outcome.status === "failed",
      `${JSON.stringify(read)}\n    ${stderr}`,
    );
    ok(
      "and it still releases its lock, so the item is not wedged for the parent that comes back",
      readLock(job.pidPath) === undefined,
      `${JSON.stringify(readLock(job.pidPath))}\n    ${stderr}`,
    );
    // A send with nobody on the other end is routine, not an incident: at `error` it
    // would reach the event log AND post a comment on the issue, which is the parent's
    // to post (two milestones per work item, neither of them this).
    ok("the unreachable parent is routine, so the child posts no comment about it", !existsSync(job.eventLogPath), job.eventLogPath);
  }

  // ── the run log: a child shares no memory with the parent, so what it did has to be
  //    durable where the job said. Its Logger is built by the SAME wiring function the
  //    parent uses, so the two cannot drift in which sinks a level reaches ──
  {
    const job = jobFor("acme/finance#59", 59);
    const observed = await runChild(job);
    ok("the child runs to a clean exit", observed.code === 0, `code=${observed.code}\n    ${observed.stderr}`);

    const runLog = existsSync(job.runLogPath) ? readFileSync(job.runLogPath, "utf8") : "";
    ok("the run's own log lands at the path the job named", runLog.length > 0, `nothing at ${job.runLogPath}\n    ${observed.stderr}`);
    ok(
      "its lines are tagged with the module and addressed at the work item",
      runLog.includes("[issue]") && runLog.includes("(acme/finance#59)"),
      runLog,
    );

    // Routine progress is `info`: durable and on screen, nowhere else. A line on the
    // event log would mean the child had reached a level that also posts a GitHub
    // comment — the parent posts the milestones (constraints 11 and 12).
    ok("nothing routine reaches the event log, so the child posts no comment", !existsSync(job.eventLogPath));
  }

  // ── a child that dies is an exit code, not a dead pipeline (constraint 6). The child's
  //    half of that bargain: fail loudly and leave NO outcome, so the parent records the
  //    work item failed from the exit code instead of applying a half-built result ──
  {
    const job = jobFor("acme/finance#60", 60);
    const broken = { ...job, pidPath: undefined }; // a job the parent resolved wrong
    const child = fork(entry, [JSON.stringify(broken)], { silent: true });
    const code = await new Promise<number | null>((settle) => child.on("exit", settle));

    ok("a child that cannot do its job exits with a code rather than reporting success", code !== 0, `code=${code}`);
    ok(
      "it leaves no outcome, so the parent has nothing to mistake for finished work",
      readOutcome(job.resultPath).state === "absent",
      JSON.stringify(readOutcome(job.resultPath)),
    );
  }

  // ── the fork the parent actually wires in (`main.mts`): the real entry point, by
  //    path, settling when the child EXITS — so the concurrency cap and the branch lock
  //    hold for the child's whole life rather than for the fork call ──
  {
    const job = jobFor("acme/finance#61", 61);
    // `silent` only keeps the child's own console lines out of this smoke's output; the
    // parent inherits them into the supervised stream.
    const exit = await createForkWorkItem({ silent: true })(job);

    ok("the parent's own fork runs the real entry point to a clean exit", exit.code === 0 && exit.signal === null, JSON.stringify(exit));
    ok(
      "and it settles no earlier than the outcome it exists to hand back",
      readOutcome(job.resultPath).state === "ok",
      JSON.stringify(readOutcome(job.resultPath)),
    );
  }

  // ── a child that never STARTS — no node binary to exec, no file descriptors left,
  //    EACCES. The ChildProcess emits `error`, and an `error` event with no listener is
  //    an UNCAUGHT exception: it takes the parent down and every other in-flight item
  //    and the socket it answers on with it. Constraint 6 from the other end — a child
  //    that cannot start is one work item's failure, not a dead pipeline ──
  {
    const job = jobFor("acme/finance#62", 62);
    const exit = await createForkWorkItem({ execPath: resolve(dir, "not-a-node-binary") })(job);

    ok("a child that cannot be spawned fails its own work item instead of the parent", exit.error !== undefined, JSON.stringify(exit));
    ok(
      "and carries what stopped it, since a spawn failure has no exit code and `code null` reads as a clean one",
      (exit.error ?? "").includes("ENOENT") && exit.code === null && exit.signal === null,
      JSON.stringify(exit),
    );
    ok(
      "leaving no outcome, so the parent records the item failed rather than finished",
      readOutcome(job.resultPath).state === "absent",
      JSON.stringify(readOutcome(job.resultPath)),
    );
  }

  // ── hermetic: the child derives no path of its own, which is the whole reason the
  //    job carries them (constraint 7). Ask `lib/paths.mts` where the REAL files for
  //    this key would be and confirm the child never went near them ──
  ok(
    "the child wrote where the job pointed and nowhere near the real var/",
    !existsSync(resultPath("acme/finance#57")) && !existsSync(pidPath("acme/finance#57")),
    `${resultPath("acme/finance#57")} / ${pidPath("acme/finance#57")}`,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
