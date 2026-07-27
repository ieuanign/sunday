// test/smoke-github.mts — the blocker read on the GitHub seam (#42).
//   node test/smoke-github.mts
//
// `Gh` is otherwise left out of the smokes on purpose: it needs the CLI, a token and
// the network, and WHEN Sunday claims or releases is driven over a substitute. This
// one read is the exception, because the distinction it draws IS issue #42. An issue
// with no dependencies exits 0 with EMPTY stdout — "nothing blocks this". A failed
// read exits non-zero — "I don't know". v1 collapsed the second into the first
// (`listener/dag.mts:45`) and admitted blocked issues onto main.
//
// Driven through the fixture's stub `gh`: no network, no tokens, $0.

import { makeFixture, ok, report, stubGhInEffect } from "./git-fixture.mts";

import { Gh } from "../services/github/index.mts";

/** The routed repo the scenario pretends to be. Only ever reaches the stub. */
const REPO = "sunday-fixture/child";
/** The dependent whose blockers are read. */
const ISSUE = 10;

const fx = makeFixture("github-read");
fx.stubGh({ "dependencies/blocked_by": "9\tOPEN\n8\tCLOSED" });
ok("the stub gh is in effect before any production code runs", stubGhInEffect());

const gh = new Gh();

const blockers = await gh.blockedBy(REPO, ISSUE);
ok(
  "every native dependency link is a blocker, with its state lowercased",
  JSON.stringify(blockers) ===
    JSON.stringify([
      { number: 9, state: "open" },
      { number: 8, state: "closed" },
    ]),
  JSON.stringify(blockers),
);

// The ordinary case in production: most issues depend on nothing. The endpoint answers
// it with a zero exit and no output at all, which must read as a genuine empty list —
// the body fallback's cue — and never as a parse of one blank line.
fx.stubGh({ "dependencies/blocked_by": "" });
const none = await gh.blockedBy(REPO, ISSUE);
ok("an issue with no dependencies — exit 0, empty stdout — reads as no blockers", none.length === 0, JSON.stringify(none));

// …and the answer that must NOT look like that one.
fx.stubGh({ "dependencies/blocked_by": { stderr: "gh: Server Error (HTTP 502)", exitCode: 1 } });
let failed: Error | null = null;
try {
  await gh.blockedBy(REPO, ISSUE);
} catch (err) {
  failed = err instanceof Error ? err : new Error(String(err));
}
ok(
  "a read that FAILED throws, so a caller can never mistake it for 'nothing blocks this'",
  failed !== null && failed.message.includes("502"),
  `blockedBy returned instead of throwing, or lost the API's own text: ${failed?.message}`,
);

// `gh issue view` shouts its state where the dependencies endpoint whispers it; the
// seam normalises so no caller has to know which read a blocker arrived from.
fx.stubGh({ "--json state": "OPEN" });
const state = await gh.issueState(REPO, 9);
ok("issueState lowercases what `gh issue view` returns", state === "open", state);

report();
