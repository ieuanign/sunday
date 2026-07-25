// test/smoke-dag-blocker-read.mts — the swallowed blocker read, reproduced.
//   node test/smoke-dag-blocker-read.mts
//
// Admission asks GitHub "what blocks this issue?" through `readBlockers` and hands
// the answer to `decideBase` (listener/dag.mts). Two silent failures in that read
// compound:
//   1. the native `.../dependencies/blocked_by` call sits in a bare `catch {}`, so a
//      transient API failure is indistinguishable from "this repo has no native
//      dependency links" and falls through to the body text;
//   2. the body fallback only recognises `#N` refs, so a `## Blocked by` section
//      listing its blockers as full issue URLs — what GitHub leaves behind when a
//      link is pasted — yields nothing.
// Together they return `[]`, which `decideBase` reads as "0 blockers → main". A
// blocked issue is admitted and starts work on main while its blocker is still open.
//
// Driven through a stub `gh` — no network, no tokens — with controls on either
// side: the healthy native read, the same body in `#N` form, and `decideBase` over
// the blocker the read lost all behave, which pins the defect to the read rather
// than to the fixture.
//
// Both defects are still present, so each desired outcome is recorded with
// `knownDefect`: loud, not counted, and it FAILS the moment a fix lands — which is
// how it forces promotion to a real `ok`.

import { knownDefect, makeFixture, ok, report, stubGhInEffect } from "./git-fixture.mts";

import { decideBase, readBlockers, type Blocker } from "../listener/dag.mts";

/** The routed repo the scenario pretends to be. Only ever reaches the stub. */
const FULL_NAME = "sunday-fixture/child";
/** The dependent under admission, and the issue that blocks it. */
const ISSUE = "10";
const BLOCKER = 9;

const fx = makeFixture("dag-blocker-read");
fx.stubGh({ "dependencies/blocked_by": `${BLOCKER}\topen` });
ok("the stub gh is in effect before any production code runs", stubGhInEffect());

fx.commit("shared.txt", "base\n", "C0 base");
fx.push("main");
const child = fx.cloneChild();

// The control: with the native dependencies endpoint answering, the blocker is
// read correctly — so anything the scenario shows later is the failure path, not
// a mis-wired fixture.
const healthy = readBlockers(FULL_NAME, child, ISSUE);
ok(
  "with the native dependencies read healthy, the blocker is reported open",
  healthy.length === 1 && healthy[0].number === BLOCKER && healthy[0].state === "open",
  `readBlockers returned ${JSON.stringify(healthy)}`,
);

// …and now the failure path: the native endpoint 502s and the body lists the
// blocker as a full URL.
const BODY = [
  "Rework the widget.",
  "",
  "## Blocked by",
  "",
  `- https://github.com/${FULL_NAME}/issues/${BLOCKER}`,
  "",
].join("\n");

fx.stubGh({
  "dependencies/blocked_by": { stderr: "gh: Server Error (HTTP 502)", exitCode: 1 },
  "--json body": BODY,
  // Only reached if the URL-form ref is ever recognised — stubbed so a fixed
  // read resolves the blocker's state instead of dying on an unstubbed call.
  "--json state": "OPEN",
});

console.log(`\n▸ reading #${ISSUE}'s blockers — the \`Server Error\` lines below are the defect, not a suite failure\n`);
let blockers: Blocker[] | null = null;
let readError: Error | null = null;
try {
  blockers = readBlockers(FULL_NAME, child, ISSUE);
} catch (err) {
  readError = err instanceof Error ? err : new Error(String(err));
}

knownDefect(
  "a blocker read that failed is not reported as 'this issue has no blockers'",
  readError !== null || (blockers ?? []).some((b) => b.number === BLOCKER),
  `the 502 was swallowed and the URL-form ref matched nothing, so readBlockers returned ` +
    `${JSON.stringify(blockers)} — indistinguishable from an unblocked issue`,
);

// The consequence: that empty read is handed straight to base selection, which
// reads it as "0 blockers → main" and admits an issue whose blocker is still open.
/** #9's PR is open in this scenario, so a correct read would stack, not defer. */
const hasOpenPr = (blocker: number): boolean => blocker === BLOCKER;

const decision = blockers ? decideBase(blockers, hasOpenPr) : null;
knownDefect(
  "an issue whose blocker read failed is not admitted onto main",
  decision === null || !(decision.admit && decision.baseBranch === "main"),
  `decideBase returned ${JSON.stringify(decision)} — #${ISSUE} starts work on main while #${BLOCKER} is still open`,
);

// It takes BOTH halves: the same body in the `#N` form the fallback recognises
// resolves the blocker fine, so the swallowed 502 alone is not what loses it.
fx.stubGh({
  "dependencies/blocked_by": { stderr: "gh: Server Error (HTTP 502)", exitCode: 1 },
  "--json body": BODY.replace(`https://github.com/${FULL_NAME}/issues/${BLOCKER}`, `#${BLOCKER}`),
  "--json state": "OPEN",
});
const viaHashRef = readBlockers(FULL_NAME, child, ISSUE);
ok(
  "the same section written as `#9` does resolve the blocker — the URL form is the other half",
  viaHashRef.length === 1 && viaHashRef[0].number === BLOCKER && viaHashRef[0].state === "open",
  `readBlockers returned ${JSON.stringify(viaHashRef)}`,
);

// …and the decision itself is sound — handed the blocker the read lost, it stacks
// #10 on its blocker's branch. The whole defect is in the read.
const sound = decideBase([{ number: BLOCKER, state: "open" }], hasOpenPr);
ok(
  "given the blocker the read lost, base selection stacks the dependent on feat/9",
  sound.admit && sound.baseBranch === `feat/${BLOCKER}`,
  `decideBase returned ${JSON.stringify(sound)}`,
);

report();
