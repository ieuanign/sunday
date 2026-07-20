// test/smoke-pause-state.mts — no-quota smoke for the M3.2 durable pause state.
//   devbox run node test/smoke-pause-state.mts
// Round-trips pause.json (write→read→clear) and drives the PURE rearmAction that
// decides what a boot does with a persisted pause.

import {
  readPauseState,
  writePauseState,
  clearPauseState,
  rearmAction,
  type PauseState,
} from "../listener/pause-state.mts";

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : `\n    ${detail}`}`);
};

// ── durable round-trip ──
{
  clearPauseState();
  ok("empty: no file → undefined", readPauseState() === undefined);
  const s: PauseState = { reason: "quota exhausted", since: 1_000, resumeAt: 2_000 };
  writePauseState(s);
  const back = readPauseState();
  ok("round-trip: read back the written state", JSON.stringify(back) === JSON.stringify(s), JSON.stringify(back));
  clearPauseState();
  ok("clear: file removed → undefined", readPauseState() === undefined);
}

// ── rearmAction: what a boot does with a persisted pause ──
{
  const now = 10_000;
  ok("rearm: reset already passed → resume", rearmAction({ reason: "q", since: 0, resumeAt: 9_000 }, now) === "resume");
  ok("rearm: reset in the future → reschedule", rearmAction({ reason: "q", since: 0, resumeAt: 11_000 }, now) === "reschedule");
  ok("rearm: reset exactly now → resume", rearmAction({ reason: "q", since: 0, resumeAt: 10_000 }, now) === "resume");
  ok("rearm: no resumeAt (403 halt) → halt", rearmAction({ reason: "403", since: 0 }, now) === "halt");
  ok("rearm: no resumeAt (quota no-ts) → halt", rearmAction({ reason: "quota no reset", since: 0 }, now) === "halt");
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
