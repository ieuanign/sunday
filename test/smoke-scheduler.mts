// test/smoke-scheduler.mts — no-quota smoke for the two-lane scheduler (6c).
//   devbox run node test/smoke-scheduler.mts
// Fake runs with manually-resolved promises let us observe: the regular-lane cap,
// the uncapped restack lane, the two-way per-branch lock, drain-on-completion,
// and key dedup.

import { createScheduler, type Scheduler } from "../listener/scheduler.mts";

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : `\n    ${detail}`}`);
};
const tick = () => new Promise((r) => setTimeout(r, 0)); // flush microtasks

/** A test harness over one scheduler: records run() invocations, lets each run be
 *  resolved on demand. */
function harness(cap: number) {
  const started: string[] = [];
  const gates = new Map<string, () => void>();
  const s: Scheduler = createScheduler(cap, () => {});
  const add = (lane: "regular" | "restack", key: string, branch: string) => {
    const item = {
      key, branch,
      run: () => { started.push(key); return new Promise<void>((res) => gates.set(key, res)); },
    };
    if (lane === "regular") s.enqueue(item); else s.enqueueRestack(item);
  };
  const finish = (key: string) => gates.get(key)?.();
  return { s, started, add, finish };
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

  console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
  process.exit(fails === 0 ? 0 : 1);
}
run();
