// test/smoke-scheduler.mts — no-quota smoke for the two-lane scheduler (6c).
//   devbox run node test/smoke-scheduler.mts
// Fake runs with manually-resolved promises let us observe: the regular-lane cap,
// the uncapped restack lane, the two-way per-branch lock, drain-on-completion,
// and key dedup.

import { createScheduler, type Scheduler } from "../assignor/scheduler.mts";
import { Logger, type Destinations, type LogLine } from "../services/logger.mts";

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : `\n    ${detail}`}`);
};
const tick = () => new Promise((r) => setTimeout(r, 0)); // flush microtasks

/** A test harness over one scheduler: records run() invocations, lets each run be
 *  resolved on demand. The scheduler says everything through the REAL Logger over
 *  recording destinations — nothing reaches the screen, `var/` or GitHub. */
function harness(cap: number) {
  const started: string[] = [];
  const lines: LogLine[] = [];
  const gates = new Map<string, () => void>();
  const record = (line: LogLine) => void lines.push(line);
  const dests: Destinations = { console: record, runLog: record, eventLog: record, github: record, phone: record };
  const s: Scheduler = createScheduler(cap, new Logger(dests).child("scheduler"));
  const add = (lane: "regular" | "restack", key: string, branch: string) => {
    const item = {
      key, branch,
      run: () => { started.push(key); return new Promise<void>((res) => gates.set(key, res)); },
    };
    if (lane === "regular") s.enqueue(item); else s.enqueueRestack(item);
  };
  const finish = (key: string) => gates.get(key)?.();
  return { s, started, lines, add, finish };
}

async function run() {
  // ── A: regular lane respects the cap ──
  {
    const h = harness(2);
    h.add("regular", "a", "feat/a");
    h.add("regular", "b", "feat/b");
    h.add("regular", "c", "feat/c");
    await tick();
    ok("cap: only 2 of 3 regular start", h.started.join(",") === "a,b", h.started.join(","));
    h.finish("a");
    await tick();
    ok("cap: c starts when a finishes", h.started.includes("c"));
  }

  // ── B: restack lane is uncapped ──
  {
    const h = harness(2);
    for (const n of ["r1", "r2", "r3", "r4", "r5"]) h.add("restack", n, `feat/${n}`);
    await tick();
    ok("restack: all 5 start despite cap 2", h.started.length === 5, h.started.join(","));
  }

  // ── C: uncapped restack runs alongside a full regular lane ──
  {
    const h = harness(1);
    h.add("regular", "g", "feat/g");
    h.add("restack", "r", "feat/r");
    await tick();
    ok("restack runs even with the regular cap full", h.started.sort().join(",") === "g,r");
  }

  // ── D: two-way branch lock — restack holds, regular waits ──
  {
    const h = harness(2);
    h.add("restack", "r", "feat/x");
    h.add("regular", "g", "feat/x"); // same branch
    await tick();
    ok("lock: regular blocked while restack holds the branch", h.started.join(",") === "r", h.started.join(","));
    h.finish("r");
    await tick();
    ok("lock: regular runs once restack releases", h.started.includes("g"));
  }

  // ── E: two-way branch lock — regular holds, restack waits ──
  {
    const h = harness(2);
    h.add("regular", "g", "feat/y");
    h.add("restack", "r", "feat/y"); // same branch
    await tick();
    ok("lock: restack blocked while regular holds the branch", h.started.join(",") === "g", h.started.join(","));
    h.finish("g");
    await tick();
    ok("lock: restack runs once regular releases", h.started.includes("r"));
  }

  // ── F: key dedup ──
  {
    const h = harness(2);
    h.add("regular", "dup", "feat/z");
    h.add("regular", "dup", "feat/z"); // same key while in-flight → dropped
    await tick();
    ok("dedup: duplicate key runs once", h.started.filter((k) => k === "dup").length === 1);
  }

  // ── G: pause stalls BOTH lanes; queued work is retained; resume drains ──
  {
    const h = harness(2);
    h.s.pause("quota");
    h.add("regular", "p1", "feat/p1");
    h.add("restack", "p2", "feat/p2");
    await tick();
    ok("pause: nothing starts while paused (both lanes)", h.started.length === 0, h.started.join(","));
    ok("pause: isPaused reflects state", h.s.isPaused());
    const snap = h.s.snapshot();
    ok("pause: snapshot shows queued work retained", snap.regularQueued.includes("p1") && snap.restackQueued.includes("p2") && snap.paused);
    h.s.resume();
    await tick();
    ok("resume: retained work drains", h.started.sort().join(",") === "p1,p2", h.started.join(","));
    ok("resume: isPaused cleared", !h.s.isPaused());
  }

  // ── H: pausing mid-flight lets the in-flight run finish but starts nothing new ──
  {
    const h = harness(2);
    h.add("regular", "live", "feat/live");
    await tick();
    ok("pause-midflight: the in-flight run is already going", h.started.includes("live"));
    h.s.pause("403");
    h.add("regular", "next", "feat/next");
    h.finish("live"); // completes → its finally pumps, but paused → no new start
    await tick();
    ok("pause-midflight: no new run starts on completion while paused", !h.started.includes("next"));
    const snap = h.s.snapshot();
    ok("pause-midflight: snapshot reason is set", snap.pauseReason === "403");
    h.s.resume();
    await tick();
    ok("pause-midflight: resume starts the queued run", h.started.includes("next"));
  }

  // ── I: the scheduler itself says nothing — every line goes through the injected
  //    logger (a bare console write in a V2 file fails `npm run lint`), and as `info`:
  //    `milestone` is reserved for the two events that post a comment on the issue ──
  {
    const h = harness(1);
    h.add("regular", "spoken", "feat/spoken");
    await tick();
    const start = h.lines.find((l) => l.message.includes("spoken"));
    ok("logger: starting an item is reported through the injected logger", start !== undefined, JSON.stringify(h.lines));
    ok("logger: the line carries the module tag its owner bound", start?.module === "scheduler", JSON.stringify(start));
    ok("logger: routine progress is info, not a milestone that would comment", start?.level === "info", JSON.stringify(start));
  }

  // ── J: a run that rejects is a work item that got no further — it must be reported
  //    rather than swallowed, and it must release its branch and its slot like any other
  //    completion, or one throw wedges the lane for good ──
  {
    const h = harness(1);
    const boom = { key: "boom", branch: "feat/shared", run: () => Promise.reject(new Error("fork died")) };
    h.s.enqueue(boom);
    h.add("regular", "after", "feat/shared"); // same branch, so it needs boom's lock back
    await tick();
    const failure = h.lines.find((l) => l.message.includes("fork died"));
    ok("failure: a rejected run is reported with what went wrong", failure?.message.includes("boom") === true, JSON.stringify(h.lines.map((l) => l.message)));
    // Raised from `info` with #39: the apply path now really does classify every failed
    // outcome and act on its scope, so a rejection that got past it reached NO policy at
    // all — a work item nobody will retry, quarantine or even count. At `info` that line
    // is buried in the run log; at `error` it is a durable event and a phone alert.
    ok("failure: reported at error — a rejection here means the apply path never saw it", failure?.level === "error", JSON.stringify(failure));
    ok("failure: the branch and the slot are released, so the next item runs", h.started.includes("after"), h.started.join(","));
  }

  console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
  process.exit(fails === 0 ? 0 : 1);
}
run();
