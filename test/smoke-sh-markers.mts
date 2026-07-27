// test/smoke-sh-markers.mts — hermetic smoke for the two leaves the boot reconcile
// sweep is built on: the async shell-out (`lib/sh.mts`) that keeps hundreds of `gh`
// reads off the parent's event loop, and the summon test (`lib/markers.mts`) that says
// whether a comment stream is asking Sunday for something.
//   devbox run node test/smoke-sh-markers.mts
// Shells out to `printf`/`sh` only — no network, no GitHub, $0. (The real `Gh` over the
// `gh` CLI stays out of the smokes, as its own header says: what CAN be wrong is WHEN
// Sunday reads and writes, and the Assignor/Reconciler smokes drive that over a
// substitute.)

import { isSummon, sundayComment, sundayReply, unansweredSummons } from "#lib/markers.mts";
import { shA } from "#lib/sh.mts";

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

// ── a REPLY to a summon: the same comment as any other of ours, plus the one marker
//    that says it answered something. It quotes the request it is answering, so if it
//    read back as a summon Sunday would answer itself forever on real quota ──
{
  const reply = sundayReply("You asked @sunday to add the retry — done in 3a1c9de.");
  ok("reply: our own reply is never a summon, even quoting the request", !isSummon(reply), reply);
}

// ── which summons are still OUTSTANDING, decided on GitHub and in no state of ours:
//    ids are monotonic, so a summon older than our newest reply was served — on this
//    boot and on every boot after it ──
{
  const ids = (stream: { id: number; body: string }[]) => unansweredSummons(stream).map((c) => c.id).join(",");

  // The milestone comments a work item posts land on the very thread it was summoned
  // on. Judged as answers they would bury the summon under a comment that never
  // addressed it, and no reconcile pass would ever pick it up again.
  const milestoned = [
    { id: 1, body: "@sunday the retry never backs off" },
    { id: 2, body: sundayComment("▶ started — PR-comment run") },
  ];
  ok("unanswered: a milestone comment of ours does not answer the summon under it", ids(milestoned) === "1", ids(milestoned));

  // A reply does — which is what makes a crashed or retried run idempotent: the replies
  // it already posted are visible to the next attempt, so it does not spend a second
  // agent run re-answering them. And a summon that landed WHILE the run was working is
  // newer than that reply, so it survives to the next pass rather than being swallowed.
  const answered = [...milestoned, { id: 3, body: sundayReply("Fixed in 3a1c9de.") }, { id: 4, body: "@sunday also the timeout" }];
  ok("unanswered: a reply answers every summon older than it, and none newer", ids(answered) === "4", ids(answered));
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
