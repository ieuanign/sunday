// test/smoke-boot.mts — hermetic smoke for what happens when the V2 parent starts.
//   devbox run node test/smoke-boot.mts
// Section one is PURE: the durable pause state (assignor/pause.mts) that survives the
// restart the in-memory scheduler flag does not, and the rule that decides what boot does
// with one it finds armed. The store takes its file path at construction, so this drives
// the real module against a throwaway dir and never the real `var/pause.json`.
// $0, no network, no GitHub.

import { rmSync } from "node:fs";
import { resolve } from "node:path";

import { PauseStore, rearmAction } from "../assignor/pause.mts";

const dir = resolve(import.meta.dirname, "..", ".scratch", `smoke-boot-${process.pid}`);

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : `\n    ${detail}`}`);
};

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
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
