// test/smoke-dag.mts — hermetic smoke for the dependency decision (#42): what an
// issue's blockers mean for whether it starts at all, and what it bases on when it
// does.
//   devbox run node test/smoke-dag.mts
// The real `resolveBase` — the whole sequence, native read to fallback to decision —
// over a fake GitHub seam. Every `gh` call lives behind that seam (constraint 1), which
// is what lets the entire table be driven offline. $0, no network, no tokens.

import { resolveBase } from "../assignor/dag.mts";
import type { Blocker, GitHub } from "../services/github/index.mts";

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : `\n    ${detail}`}`);
};

/** The repo every case is addressed at, and the dependent under admission. */
const REPO = "acme/finance";
const ISSUE = 10;
const BLOCKER = 9;

/** A GitHub seam answering "nothing blocks this issue" — no native links, a body with
 *  no `## Blocked by` section, no open PR anywhere. Each case overrides only the reads
 *  it is about. */
function github(over: Partial<GitHub> = {}): GitHub {
  return {
    claim: () => {},
    release: () => {},
    blockedBy: async () => [],
    issueState: async () => "closed",
    readIssue: async () => ({ title: "", body: "" }),
    openPrForHead: async () => undefined,
    ...over,
  };
}

// ── the native read, which is the answer on every routed repo ──
{
  const decision = await resolveBase(github(), REPO, ISSUE);
  ok(
    "no blockers: an issue nothing blocks starts on main",
    decision.admit && decision.base === "main",
    JSON.stringify(decision),
  );
}

// ── a blocker that LANDED blocks nothing: its work is on main already ──
{
  const closed = await resolveBase(github({ blockedBy: async () => [{ number: BLOCKER, state: "closed" }] }), REPO, ISSUE);
  ok(
    "one closed blocker: it landed, so the dependent starts on main like any other issue",
    closed.admit && closed.base === "main",
    JSON.stringify(closed),
  );

  const allClosed = await resolveBase(
    github({ blockedBy: async () => [{ number: 7, state: "closed" }, { number: 8, state: "closed" }, { number: BLOCKER, state: "closed" }] }),
    REPO,
    ISSUE,
  );
  ok(
    "several blockers, all closed: still main — there is nothing left to wait for",
    allClosed.admit && allClosed.base === "main",
    JSON.stringify(allClosed),
  );
}

// ── one OPEN blocker: stack on its branch as soon as it has a PR to stack on, and
//    wait when it has not. Stacking is what keeps a chain of dependents off the human
//    review queue's critical path (ADR-0003) ──
{
  const heads: string[] = [];
  const stacked = await resolveBase(
    github({
      blockedBy: async () => [{ number: BLOCKER, state: "open" }],
      openPrForHead: async (_repo, head) => {
        heads.push(head);
        return "https://github.com/acme/finance/pull/12";
      },
    }),
    REPO,
    ISSUE,
  );
  ok(
    "one open blocker with a PR up: the dependent stacks on the blocker's own branch",
    stacked.admit && stacked.base === `feat/${BLOCKER}`,
    JSON.stringify(stacked),
  );
  ok(
    "the PR is looked for on the BLOCKER's branch, which is the one being stacked on",
    heads.length === 1 && heads[0] === `feat/${BLOCKER}`,
    heads.join(", "),
  );

  const waiting = await resolveBase(github({ blockedBy: async () => [{ number: BLOCKER, state: "open" }] }), REPO, ISSUE);
  ok(
    "one open blocker with no PR yet: there is no branch worth forking from, so it waits",
    !waiting.admit && waiting.reason.includes(`#${BLOCKER}`),
    JSON.stringify(waiting),
  );
}

// ── more than one blocker with any of them open: one branch cannot be stacked on two
//    bases, so the dependent waits for them all ──
{
  const many = await resolveBase(
    github({
      blockedBy: async () => [{ number: 7, state: "closed" }, { number: 8, state: "open" }, { number: BLOCKER, state: "open" }],
      // Both open blockers have PRs up — it still cannot stack on two of them.
      openPrForHead: async () => "https://github.com/acme/finance/pull/12",
    }),
    REPO,
    ISSUE,
  );
  ok(
    "two open blockers: no single base can carry both, so it waits rather than picking one",
    !many.admit && many.reason.includes("#8") && many.reason.includes(`#${BLOCKER}`),
    JSON.stringify(many),
  );
  ok(
    "and the closed one is not named — it is not what anyone is waiting on",
    !many.admit && !many.reason.includes("#7"),
    JSON.stringify(many),
  );
}

// ── the defect this issue exists to kill (plan.md §2, `listener/dag.mts:45`): a read
//    that FAILED is not an answer. v1 swallowed it into an empty list, which reads as
//    "nothing blocks this" and admits a blocked issue onto main — a silent wrong answer
//    that starts a real agent run ──
{
  const read502 = await resolveBase(
    github({
      blockedBy: async () => {
        throw new Error("gh: Server Error (HTTP 502)");
      },
      // The body would say the issue is unblocked. A failed native read must not fall
      // through to it: the two are different answers.
      readIssue: async () => ({ title: "", body: "Rework the widget." }),
    }),
    REPO,
    ISSUE,
  );
  ok(
    "a blocker read that failed holds the issue back rather than admitting it onto main",
    !read502.admit,
    JSON.stringify(read502),
  );
  ok(
    "and says so in the API's own words, which is the only thing that tells an operator a 502 from a wait",
    !read502.admit && read502.reason.includes("HTTP 502"),
    JSON.stringify(read502),
  );
  ok(
    "marked unreadable, so admission can say it out loud instead of as routine progress",
    !read502.admit && read502.unreadable === true,
    JSON.stringify(read502),
  );

  const waiting = await resolveBase(github({ blockedBy: async () => [{ number: BLOCKER, state: "open" }] }), REPO, ISSUE);
  ok(
    "an ORDINARY wait is not marked unreadable — the answer was read, and it was 'not yet'",
    !waiting.admit && waiting.unreadable === undefined,
    JSON.stringify(waiting),
  );

  const noPrRead = await resolveBase(
    github({
      blockedBy: async () => [{ number: BLOCKER, state: "open" }],
      openPrForHead: async () => {
        throw new Error("gh: Bad Gateway (HTTP 502)");
      },
    }),
    REPO,
    ISSUE,
  );
  ok(
    "a stacking probe that failed defers too — 'can it stack?' unanswered is not 'no'",
    !noPrRead.admit && noPrRead.unreadable === true,
    JSON.stringify(noPrRead),
  );
}

// ── the fallback, for a repo with no native dependency links: a `## Blocked by`
//    section in the issue body. An EMPTY native result is a different answer from a
//    failed one — this repo simply has no links — so it still gets its turn ──
{
  const asked: number[] = [];
  const body = ["Rework the widget.", "", "## Blocked by", "", `- #${BLOCKER}`, ""].join("\n");
  const hashRef = await resolveBase(
    github({
      readIssue: async () => ({ title: "", body }),
      issueState: async (_repo, issue) => {
        asked.push(issue);
        return "open";
      },
      openPrForHead: async () => "https://github.com/acme/finance/pull/12",
    }),
    REPO,
    ISSUE,
  );
  ok(
    "body fallback: a `#N` ref under the heading is a blocker, and the dependent stacks on it",
    hashRef.admit && hashRef.base === `feat/${BLOCKER}`,
    JSON.stringify(hashRef),
  );
  ok(
    "body fallback: its state is looked up per ref — the body says nothing about whether it landed",
    asked.length === 1 && asked[0] === BLOCKER,
    asked.join(", "),
  );

  const urlBody = ["## Blocked by", "", `- https://github.com/${REPO}/issues/${BLOCKER}`, ""].join("\n");
  const urlRef = await resolveBase(
    github({
      readIssue: async () => ({ title: "", body: urlBody }),
      issueState: async () => "open",
      openPrForHead: async () => "https://github.com/acme/finance/pull/12",
    }),
    REPO,
    ISSUE,
  );
  ok(
    "body fallback: the URL form GitHub leaves behind when a link is pasted resolves too — v1 read it as nothing",
    urlRef.admit && urlRef.base === `feat/${BLOCKER}`,
    JSON.stringify(urlRef),
  );

  const closedRef = await resolveBase(
    github({ readIssue: async () => ({ title: "", body }), issueState: async () => "closed" }),
    REPO,
    ISSUE,
  );
  ok("body fallback: a ref whose issue has closed blocks nothing", closedRef.admit && closedRef.base === "main", JSON.stringify(closedRef));
}

// ── constraint 7: only SAME-REPO refs count. A cross-repo ref's number names a
//    different issue in this repo, so reading it as one is a wrong answer rather than
//    an error — and a section naming something Sunday cannot resolve is a read that
//    did not happen ──
{
  for (const [form, ref] of [
    ["a URL", "https://github.com/other/service/issues/5"],
    ["the owner/repo#N shorthand", "other/service#5"],
  ] as const) {
    const foreign = await resolveBase(
      github({ readIssue: async () => ({ title: "", body: ["## Blocked by", "", `- ${ref}`].join("\n") }) }),
      REPO,
      ISSUE,
    );
    ok(
      `cross-repo ref as ${form}: the dependent waits rather than resolving #5 in the wrong repo`,
      !foreign.admit && foreign.unreadable === true,
      JSON.stringify(foreign),
    );
  }

  const mixed = await resolveBase(
    github({
      readIssue: async () => ({ title: "", body: ["## Blocked by", "", `- #${BLOCKER}`, "- https://github.com/other/service/issues/5"].join("\n") }),
      issueState: async () => "closed",
    }),
    REPO,
    ISSUE,
  );
  ok(
    "one resolvable ref does not excuse the one beside it — a partly-read section is unread",
    !mixed.admit && mixed.unreadable === true,
    JSON.stringify(mixed),
  );
}

// ── and the other direction: this tracker's own issues carry prose containing
//    "blocked by" (#31, #40), so the parse is HEADING-scoped. A looser match would read
//    a sentence as a blocker and hold real work back forever ──
{
  const prose = await resolveBase(
    github({
      readIssue: async () => ({
        title: "",
        body: ["This is blocked by nothing in particular; #7 explains why.", "", "## Approach", "", "Ship it."].join("\n"),
      }),
    }),
    REPO,
    ISSUE,
  );
  ok(
    "prose mentioning 'blocked by' outside a heading is not a dependency — it is a sentence",
    prose.admit && prose.base === "main",
    JSON.stringify(prose),
  );

  const other = await resolveBase(
    github({ readIssue: async () => ({ title: "", body: ["## Related", "", `- #${BLOCKER}`].join("\n") }) }),
    REPO,
    ISSUE,
  );
  ok("nor is a ref under some other heading", other.admit && other.base === "main", JSON.stringify(other));

  const empty = await resolveBase(
    github({ readIssue: async () => ({ title: "", body: ["## Blocked by", "", "the auth rework", ""].join("\n") }) }),
    REPO,
    ISSUE,
  );
  ok(
    "a heading that names no ref Sunday can read is a section it does not understand, so it waits",
    !empty.admit && empty.unreadable === true,
    JSON.stringify(empty),
  );
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
