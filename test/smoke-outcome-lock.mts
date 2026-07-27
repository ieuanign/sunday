// test/smoke-outcome-lock.mts — hermetic smoke for the durable handoff pair: the
// outcome file a forked work item leaves for the parent (lib/outcome.mts) and the PID
// lock it holds while it lives (lib/lock.mts). ADR-0001: the parent may be killed at
// any instant, so finished work has to survive on disk and a live child has to be
// recognisable across a parent restart.
//   devbox run node test/smoke-outcome-lock.mts
// Everything here writes under its own throwaway dir, never the real `var/` — which is
// what taking every path as an argument buys. $0, no network, no GitHub.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { acquireLock, readLock, releaseLock } from "../lib/lock.mts";
import { clearOutcome, readOutcome, writeOutcome, type Outcome } from "../lib/outcome.mts";

const dir = resolve(import.meta.dirname, "..", ".scratch", `smoke-outcome-lock-${process.pid}`);

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : `\n    ${detail}`}`);
};

try {
  // ── the round trip: what the child wrote is what the parent applies ──
  {
    const path = resolve(dir, "results", "acme-finance-57.json");
    const outcome: Outcome = {
      key: "acme/finance#57",
      status: "done",
      summary: "spine only — no agent ran",
      finishedAt: "2026-07-25T00:00:00.000Z",
    };

    ok("write: its directory does not exist yet", !existsSync(dir));
    writeOutcome(path, outcome);
    const read = readOutcome(path);
    ok(
      "round trip: the outcome reads back exactly as it was written",
      read.state === "ok" && JSON.stringify(read.outcome) === JSON.stringify(outcome),
      JSON.stringify(read),
    );
  }

  // ── the gate: a run that stopped to ask a human finished, and finished as neither
  //    done nor failed. Its session handle is the whole difference between the reply
  //    resuming that run and the work starting over, and the child that holds it is
  //    gone — so it survives here or nowhere ──
  {
    const path = resolve(dir, "results", "acme-finance-62.json");
    const gated: Outcome = {
      key: "acme/finance#62",
      status: "awaiting-human",
      summary: "Which of the two auth flows should this use?",
      finishedAt: "2026-07-25T00:00:00.000Z",
      sessionId: "9f3c1a7e-2b40-4d61-8c55-0e1d2f3a4b5c",
    };
    writeOutcome(path, gated);
    const read = readOutcome(path);
    ok(
      "gate: a run waiting on a human is a readable outcome, not an unknown status",
      read.state === "ok" && read.outcome.status === "awaiting-human",
      JSON.stringify(read),
    );
    ok(
      "gate: the session handle survives the file, or the reply starts the work over",
      read.state === "ok" && read.outcome.sessionId === gated.sessionId,
      JSON.stringify(read),
    );
    ok(
      "gate: the question the child asked is what the parent will post",
      read.state === "ok" && read.outcome.summary === gated.summary,
      JSON.stringify(read),
    );
  }

  // ── absence is an answer, not an exception: no file means the item is not finished
  //    (or its outcome was already applied and cleared), which the parent asks on every
  //    sweep. A throw there would turn the common case into an incident ──
  {
    const path = resolve(dir, "results", "never-written.json");
    let threw = "";
    let read: ReturnType<typeof readOutcome> | undefined;
    try {
      read = readOutcome(path);
    } catch (err) {
      threw = (err as Error).message;
    }
    ok("absent: reading a file that was never written does not throw", threw === "", threw);
    ok("absent: it reports a typed absence", read?.state === "absent", JSON.stringify(read));
  }

  // ── a file that cannot be understood is a RESULT, not a crash: the parent still has
  //    to record the item as failed and release its claim. Throwing here would strand
  //    the issue mid-flight with `agent-working` still on it ──
  {
    const path = resolve(dir, "results", "garbage.json");
    writeFileSync(path, '{"key":"acme/finance#58","status":"do');
    let threw = "";
    let read: ReturnType<typeof readOutcome> | undefined;
    try {
      read = readOutcome(path);
    } catch (err) {
      threw = (err as Error).message;
    }
    ok("unreadable: malformed JSON does not throw", threw === "", threw);
    ok(
      "unreadable: it reports the failure with what was wrong",
      read?.state === "unreadable" && read.detail.length > 0,
      JSON.stringify(read),
    );
  }

  // ── parseable is not the same as usable: the parent writes `status` into durable
  //    state and posts `summary` to the issue, so JSON of the wrong shape has to fail
  //    here rather than land in `var/state.json` as `undefined` ──
  {
    const path = resolve(dir, "results", "wrong-shape.json");
    writeFileSync(path, JSON.stringify({ key: "acme/finance#59", summary: "ran" }));
    const missing = readOutcome(path);
    ok("unreadable: JSON missing the fields the parent applies", missing.state === "unreadable", JSON.stringify(missing));

    writeFileSync(
      path,
      JSON.stringify({ key: "acme/finance#59", status: "maybe", summary: "ran", finishedAt: "2026-07-25T00:00:00.000Z" }),
    );
    const status = readOutcome(path);
    ok("unreadable: a status the pipeline has no meaning for", status.state === "unreadable", JSON.stringify(status));
  }

  // ── the fork point (#42): the commit the run's branch was created from, which is what
  //    #43 restacks against. Optional — every run before this existed reported none, and
  //    a resumed one reports none either — but a field the guard does not know about is
  //    what makes a perfectly good outcome unreadable, so it is checked like the rest ──
  {
    const path = resolve(dir, "results", "fork-point.json");
    const forked: Outcome = {
      key: "acme/finance#57",
      status: "done",
      summary: "PR: https://github.com/acme/finance/pull/99",
      finishedAt: "2026-07-25T00:00:00.000Z",
      forkPoint: "9c1f0b2e4d6a8c0e2f4a6b8d0c2e4f6a8b0d2c4e",
    };
    writeOutcome(path, forked);
    const read = readOutcome(path);
    ok(
      "fork point: the commit the branch was created from survives the file",
      read.state === "ok" && read.outcome.forkPoint === forked.forkPoint,
      JSON.stringify(read),
    );

    writeFileSync(path, JSON.stringify({ ...forked, forkPoint: 57 }));
    const wrong = readOutcome(path);
    ok(
      "fork point: present and not a string is unreadable — a restack aims at a commit, not a number",
      wrong.state === "unreadable",
      JSON.stringify(wrong),
    );
  }

  // ── the agent-reported flag (#39): the agent RAN and said the work failed, as opposed
  //    to something blowing up around it. A TYPED fact and never a pattern (constraint 3):
  //    the summary on that path is prose SUNDAY composed around the agent's description,
  //    so classifying it by regex would both break the day that wording changes and let
  //    anything the agent happened to write halt the pipeline. Optional, and checked like
  //    the rest — a field the guard skips is how a finished run becomes unreadable ──
  {
    const path = resolve(dir, "results", "agent-failed.json");
    const reported: Outcome = {
      key: "acme/finance#57",
      status: "failed",
      summary: "Could not make the integration test pass.\n\ndraft PR: https://github.com/acme/finance/pull/99",
      finishedAt: "2026-07-25T00:00:00.000Z",
      agentFailed: true,
    };
    writeOutcome(path, reported);
    const read = readOutcome(path);
    ok(
      "agent-reported: the flag survives the file — it is what the classifier reads, never the prose",
      read.state === "ok" && read.outcome.agentFailed === true,
      JSON.stringify(read),
    );

    const thrown: Outcome = {
      key: "acme/finance#58",
      status: "failed",
      summary: "Claude Code exited 1: credit balance is too low",
      finishedAt: "2026-07-25T00:00:00.000Z",
    };
    writeOutcome(path, thrown);
    const plain = readOutcome(path);
    ok(
      "agent-reported: a failure the agent never got to report carries no flag — absent, not false",
      plain.state === "ok" && plain.outcome.agentFailed === undefined,
      JSON.stringify(plain),
    );

    writeFileSync(path, JSON.stringify({ ...reported, agentFailed: "yes" }));
    const wrong = readOutcome(path);
    ok(
      "agent-reported: present and not a boolean is unreadable — a truthy string would quarantine a real quota failure",
      wrong.state === "unreadable",
      JSON.stringify(wrong),
    );
  }

  // ── atomic: the parent can read the results dir at any instant, including the one in
  //    which a child is mid-write. The file it reads is therefore either the whole old
  //    outcome or the whole new one — never half of either (constraint 3) ──
  {
    const results = resolve(dir, "atomic");
    const path = resolve(results, "acme-finance-60.json");
    const first: Outcome = {
      key: "acme/finance#60",
      status: "failed",
      summary: "first",
      finishedAt: "2026-07-25T00:00:00.000Z",
    };
    const second: Outcome = { ...first, status: "done", summary: "second".repeat(5000), finishedAt: "2026-07-25T00:01:00.000Z" };

    writeOutcome(path, first);
    ok("atomic: a completed write leaves the outcome and nothing else behind", readdirSync(results).join(",") === "acme-finance-60.json", readdirSync(results).join(","));

    // An in-place rewrite keeps the same inode, and with it a window in which a reader
    // sees a truncated file. A temp-then-rename swaps the directory entry for a new one.
    const before = statSync(path).ino;
    writeOutcome(path, second);
    const after = readOutcome(path);
    ok("atomic: rewriting swaps the file for a new one rather than truncating in place", statSync(path).ino !== before, `inode ${before} unchanged`);
    ok("atomic: the rewritten outcome reads back whole", after.state === "ok" && after.outcome.summary === second.summary, JSON.stringify(after).slice(0, 120));

    // What a crash mid-write actually leaves: bytes in the temp file, none of them in
    // the file the parent reads.
    writeFileSync(`${path}.tmp`, '{"key":"acme/finance#60","stat');
    const survivor = readOutcome(path);
    ok("atomic: a half-written temp file leaves the readable outcome untouched", survivor.state === "ok" && survivor.outcome.finishedAt === second.finishedAt, JSON.stringify(survivor).slice(0, 120));
    ok("atomic: the debris is not a second outcome for the parent to apply", readdirSync(results).filter((f) => f.endsWith(".json")).join(",") === "acme-finance-60.json", readdirSync(results).join(","));
  }

  // ── clear: the file's presence IS the guard against applying an outcome twice
  //    (constraint 5), and the parent may crash between two clears of the same one ──
  {
    const path = resolve(dir, "results", "clear-me.json");
    writeOutcome(path, {
      key: "acme/finance#61",
      status: "done",
      summary: "applied once",
      finishedAt: "2026-07-25T00:00:00.000Z",
    });
    clearOutcome(path);
    ok("clear: an applied outcome is gone, so a second apply finds nothing", readOutcome(path).state === "absent");

    let threw = "";
    try {
      clearOutcome(path);
    } catch (err) {
      threw = (err as Error).message;
    }
    ok("clear: clearing what is already gone does not throw", threw === "", threw);
  }

  // ── the lock: the cross-restart guard the in-memory queue cannot be. A parent that
  //    comes back up asks this file, not its own memory, whether a child is still on
  //    the item ──
  {
    const path = resolve(dir, "running", "acme-finance-57.pid");
    ok("lock: nothing is held before one is acquired", readLock(path) === undefined, JSON.stringify(readLock(path)));

    acquireLock(path);
    const held = readLock(path);
    ok(
      "lock: a held lock names the process holding it and reports it alive",
      held?.pid === process.pid && held.alive === true,
      JSON.stringify(held),
    );

    // A child that was SIGKILLed leaves its lock behind. The file outliving the process
    // must not suppress the next run forever — that is a work item stranded for good.
    const corpse = spawnSync(process.execPath, ["-e", ""]);
    const deadPath = resolve(dir, "running", "acme-finance-58.pid");
    acquireLock(deadPath, corpse.pid!);
    const stale = readLock(deadPath);
    ok(
      "lock: a lock left behind by a dead process reads as not alive",
      stale?.pid === corpse.pid && stale.alive === false,
      JSON.stringify(stale),
    );

    // Existing-but-not-ours is a live holder, not an absent one: reading pid 1 as dead
    // would release the guard and start a second agent on the same item — real quota
    // spent twice. (Signalling pid 1 is EPERM for anyone but root.)
    const foreignPath = resolve(dir, "running", "acme-finance-59.pid");
    acquireLock(foreignPath, 1);
    ok("lock: a process we are not allowed to signal still counts as alive", readLock(foreignPath)?.alive === true, JSON.stringify(readLock(foreignPath)));

    // A lock file that names no process proves nothing, and must not read as a live
    // holder — that would wedge the work item for good. `0` is the trap: it is a pid
    // to `Number`, but signalling it addresses the whole process group.
    for (const [label, content] of [["junk", "not-a-pid\n"], ["empty", ""], ["zero", "0\n"]] as const) {
      const junkPath = resolve(dir, "running", `junk-${label}.pid`);
      writeFileSync(junkPath, content);
      let threw = "";
      let read: ReturnType<typeof readLock> | "unset" = "unset";
      try {
        read = readLock(junkPath);
      } catch (err) {
        threw = (err as Error).message;
      }
      ok(`lock: a lock file naming no process (${label}) reads as nobody holding it`, threw === "" && read === undefined, threw || JSON.stringify(read));
    }
  }

  // ── release: the child drops its lock as it exits and the parent clears it again
  //    while applying the outcome (constraint 5), so the second release is the normal
  //    case, not an error ──
  {
    const path = resolve(dir, "running", "release-me.pid");
    acquireLock(path);
    releaseLock(path);
    ok("release: the item reads as unheld once its lock is dropped", readLock(path) === undefined, JSON.stringify(readLock(path)));

    let threw = "";
    try {
      releaseLock(path);
    } catch (err) {
      threw = (err as Error).message;
    }
    ok("release: releasing a lock that is already gone does not throw", threw === "", threw);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
