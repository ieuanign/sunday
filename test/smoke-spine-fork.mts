// test/smoke-spine-fork.mts — the tracer bullet: the parent really forks the real
// `issue/run.mts` and watches what it leaves on disk. ADR-0001 — the child hands its
// result back through FILES, not through the parent's memory, so the parent can be
// killed at any instant without losing finished work or double-starting an orphan.
//   devbox run node test/smoke-spine-fork.mts
// Every path the child writes comes from the job, so this drives the real entry point
// against a throwaway dir and never the real `var/`. $0, no network, no GitHub.

import { fork } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

// Type-only, so the entry point stays OUT of this process's module graph exactly as it
// stays out of the parent's (ADR-0001) — what is asserted below is a real fork.
import type { Job } from "../issue/run.mts";
import { readLock, type Lock } from "../lib/lock.mts";
import { readOutcome } from "../lib/outcome.mts";
import { pidPath, resultPath } from "../lib/paths.mts";

const entry = resolve(import.meta.dirname, "..", "issue", "run.mts");
const dir = resolve(import.meta.dirname, "..", ".scratch", `smoke-spine-fork-${process.pid}`);

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
    config: { path: "repos/finance", imageName: "sunday-finance", promptFile: "docs/prompt.md", triggerLabels: ["sunday"] },
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
  // ── the round trip: what the child wrote is what the parent applies. The spine has
  //    no agent in it yet (#36), so a run that does nothing still finishes honestly ──
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
      read.state === "ok" && read.outcome.key === "acme/finance#57" && read.outcome.status === "done",
      JSON.stringify(read),
    );
    ok(
      "it says plainly that no work ran, rather than claiming an agent did any",
      read.state === "ok" && read.outcome.summary.length > 0 && !Number.isNaN(Date.parse(read.outcome.finishedAt)),
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
