// test/smoke-sh-markers.mts — hermetic smoke for the two V2 leaves the boot reconcile
// sweep is built on: the async shell-out (`lib/sh.mts`) that keeps hundreds of `gh`
// reads off the parent's event loop, and the summon test (`lib/markers.mts`) that says
// whether a comment stream is asking Sunday for something.
//   devbox run node test/smoke-sh-markers.mts
// Shells out to `printf`/`sh` only — no network, no GitHub, $0. (The real `Gh` over the
// `gh` CLI stays out of the smokes, as its own header says: what CAN be wrong is WHEN
// Sunday reads and writes, and the Assignor/Reconciler smokes drive that over a
// substitute.)

import { isSummon, sundayComment } from "../lib/markers.mts";
import { shA } from "../lib/sh.mts";

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : `\n    ${detail}`}`);
};

// ── the async twin answers exactly what the sync one does: trimmed stdout. The reads
//    reconcile runs are JSON.parsed by their callers, so trailing newline handling is
//    the caller's contract, not each call site's ──
{
  ok("shA: returns trimmed stdout", (await shA("printf", ["  hi  "])) === "hi", JSON.stringify(await shA("printf", ["  hi  "])));
}

// ── a failed read has to say WHY (the classifier reads that message) without saying
//    WHAT WAS RUN: our argv carries agent-authored prose in flag values, and a PR body
//    that says "credential-free sandbox" once got a failed create classified as an auth
//    halt on the agent's own wording. Same contract as the sync `sh` above it ──
{
  let msg = "<did not throw>";
  try {
    await shA("sh", [
      "-c",
      'echo "GraphQL: Something went wrong while executing your query" >&2; exit 1',
      "--title",
      "Shell 1 — walking skeleton",
      "--body",
      "this credential-free sandbox has no docker",
    ]);
  } catch (err) {
    msg = (err as Error).message;
  }
  ok("shA: a failed command throws its own stderr", msg.includes("GraphQL: Something went wrong"), msg);
  ok("shA: the message never carries the argv", !msg.includes("credential") && !msg.includes("exit 1"), msg);
}

// ── the summon test: what makes a comment stream a request FOR Sunday. Reconcile reads
//    it off issues nobody labelled, so a false positive spends real quota ──
{
  ok("summon: a human asking for @sunday is a summon", isSummon("@sunday please pick this up"), "not recognised");
  ok("summon: case does not matter — humans write @Sunday", isSummon("hey @Sunday, take a look"), "not recognised");
  // Sunday and the human post from the SAME account, so the login cannot tell them
  // apart — the hidden marker is the only thing that can. A gate reply that quotes what
  // it was asked would otherwise summon Sunday to answer itself, forever, on real quota.
  ok(
    "summon: our own marked comment is never a summon, even quoting one",
    !isSummon(sundayComment("You asked @sunday to add the retry — here is what I found.")),
    "Sunday would answer itself",
  );
  // A different account whose name merely STARTS with ours is somebody else's mention.
  ok("summon: another handle that starts with sunday is not ours", !isSummon("cc @sundaybot for the deploy"), "matched another account");
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
