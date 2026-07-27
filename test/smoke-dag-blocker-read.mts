// test/smoke-dag-blocker-read.mts — the swallowed blocker read, now fixed (#42).
//   node test/smoke-dag-blocker-read.mts
//
// Admission asks GitHub "what blocks this issue?" and hands the answer to base
// selection. Two silent failures in v1's read compounded:
//   1. the native `.../dependencies/blocked_by` call sat in a bare `catch {}`
//      (`listener/dag.mts:45`), so a transient API failure was indistinguishable
//      from "this repo has no native dependency links" and fell through to the
//      body text;
//   2. the body fallback recognised `#N` refs only (`listener/dag.mts:57`), so a
//      `## Blocked by` section listing its blockers as full issue URLs — what
//      GitHub leaves behind when a link is pasted — yielded nothing.
// Together they returned `[]`, read as "0 blockers → main": a blocked issue was
// admitted and started work on main while its blocker was still open.
//
// This file held both as `knownDefect`s against v1. They are `ok`s now, against
// V2's `resolveBase` over the real `Gh` — the whole path, argv included, driven
// through the fixture's stub `gh`. No network, no tokens, $0. The decision table
// itself is `test/smoke-dag.mts`; what is under test HERE is the read.

import { makeFixture, ok, report, stubGhInEffect } from "./git-fixture.mts";

import { resolveBase } from "../assignor/dag.mts";
import { Gh } from "../services/github/index.mts";

/** The routed repo the scenario pretends to be. Only ever reaches the stub. */
const REPO = "sunday-fixture/child";
/** The dependent under admission, and the issue that blocks it. */
const ISSUE = 10;
const BLOCKER = 9;

/** The blocker written the way that lost it: the URL form GitHub leaves behind. */
const URL_BODY = ["Rework the widget.", "", "## Blocked by", "", `- https://github.com/${REPO}/issues/${BLOCKER}`, ""].join("\n");

/** The blocker's own PR, up and open — stacking's gate. Every case that gets far
 *  enough to ask needs it, so the stub entry is declared once. */
const BLOCKER_PR = { [`--head feat/${BLOCKER}`]: `https://github.com/${REPO}/pull/12` };

/** No git history is needed — `Gh` addresses every call with `--repo` — so the
 *  fixture is here for its stub `gh` and its cleanup, as `smoke-github.mts` uses it. */
const fx = makeFixture("dag-blocker-read");
fx.stubGh({ "dependencies/blocked_by": `${BLOCKER}\topen`, ...BLOCKER_PR });
ok("the stub gh is in effect before any production code runs", stubGhInEffect());

const gh = new Gh();

// The control: with the native dependencies endpoint answering, the blocker is read
// and stacked on — so anything the scenario shows later is the failure path, not a
// mis-wired fixture.
const healthy = await resolveBase(gh, REPO, ISSUE);
ok(
  "with the native dependencies read healthy, the dependent stacks on its blocker's branch",
  healthy.admit && healthy.base === `feat/${BLOCKER}`,
  JSON.stringify(healthy),
);

// Defect 1, promoted: the native endpoint 502s while the body says the issue is
// unblocked. v1 swallowed the failure and fell through to that body — "0 blockers
// → main". A read that did not happen is not an answer.
fx.stubGh({
  "dependencies/blocked_by": { stderr: "gh: Server Error (HTTP 502)", exitCode: 1 },
  // One issue read serves the prompt, the PR title and #38's preconditions, so the argv
  // asks for state and labels too — admission's walk still reads nothing but the body.
  "--json title,body,state,labels": JSON.stringify({ title: "Rework the widget", body: "Rework the widget.", state: "OPEN", labels: [] }),
});
const read502 = await resolveBase(gh, REPO, ISSUE);
ok(
  "a native blocker read that FAILED holds the issue back instead of reading as 'nothing blocks this'",
  !read502.admit,
  JSON.stringify(read502),
);
ok(
  "and carries the API's own text, which is the only thing that tells an operator a 502 from a wait",
  !read502.admit && read502.unreadable === true && read502.reason.includes("HTTP 502"),
  JSON.stringify(read502),
);

// Defect 2, promoted: this repo populates no native links — exit 0 and EMPTY stdout,
// a real answer rather than a failed one — so the body fallback gets its turn, and
// the section names its blocker as a pasted URL. v1's `#N`-only fallback matched
// nothing there and admitted onto main.
fx.stubGh({
  "dependencies/blocked_by": "",
  "--json title,body,state,labels": JSON.stringify({ title: "Rework the widget", body: URL_BODY, state: "OPEN", labels: [] }),
  // `gh issue view` shouts the state the dependencies endpoint whispers; the body
  // fallback resolves each ref's state through it, one read per ref.
  "--json state": "OPEN",
  ...BLOCKER_PR,
});
const viaUrl = await resolveBase(gh, REPO, ISSUE);
ok(
  "a `## Blocked by` section written as a pasted issue URL resolves the blocker, and the dependent stacks on it",
  viaUrl.admit && viaUrl.base === `feat/${BLOCKER}`,
  JSON.stringify(viaUrl),
);

report();
