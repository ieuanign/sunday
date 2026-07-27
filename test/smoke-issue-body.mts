// test/smoke-issue-body.mts — hermetic smoke for the PULL REQUEST BODY (V2, issue #37):
// the pure composer that turns an agent's result plus the host's own facts into the
// markdown a reviewer reads before the diff. Driven directly because it is a pure
// function — no docker, no git, no network, no quota.
//   devbox run node test/smoke-issue-body.mts
// $0, offline.

import { composeBody, type BodyFacts } from "#issue/body.mts";
import type { IssueResult } from "#issue/prompt.mts";
import { SUNDAY_SIGN } from "#lib/markers.mts";

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : `\n    ${detail}`}`);
};

/** The host facts a shipped run hands the composer. */
const FACTS: BodyFacts = {
  issue: 37,
  base: "main",
  commits: 3,
  durationMs: 12 * 60_000 + 4_000,
  logPath: "/Users/sunday/state/logs/ieuanign-sunday-37.log",
  model: "claude-opus-4-6",
  stat: { files: 16, insertions: 1533, deletions: 49 },
};

const headings = (body: string): string[] => [...body.matchAll(/^## (.+)$/gm)].map((m) => m[1]);

/** One section's content — everything under its heading up to the next one or the
 *  footer rule. */
const section = (body: string, heading: string): string =>
  (`\n${body}`.split(`\n## ${heading}\n`)[1] ?? "").split(/\n## |\n---\n/)[0].trim();

/** Everything below the footer's rule. */
const footer = (body: string): string => body.split(/\n---\n/).slice(1).join("\n---\n").trim();

// ── every section is present, in the order #31 lists them, with the footer behind the
//    rule: a reviewer reads top-down, and a section that moved is a section that is
//    looked for and not found ──
{
  const result: IssueResult = {
    signal: "ready",
    description: "Composed the PR body in code.",
    context: "A template file would drift from the sections.",
    typeOfChange: ["new feature"],
    risk: "low",
    verification: "npm run typecheck && npm run lint && npm test",
    relatedIssues: [31],
    review: { verdict: "APPROVED", body: "No findings." },
  };
  const body = composeBody(result, FACTS);
  ok(
    "order: the seven sections, as #31 lists them",
    JSON.stringify(headings(body)) ===
      JSON.stringify(["Description", "Related issue", "Context", "Type of change", "Risk", "Verification", "Review findings"]),
    JSON.stringify(headings(body)),
  );
  ok("footer: sits behind a `---` rule, below every section", footer(body).length > 0 && body.indexOf("\n---\n") > body.indexOf("## Review findings"), body);
  ok("description: the agent's own prose is what a reviewer reads first", section(body, "Description") === "Composed the PR body in code.", section(body, "Description"));
  ok("context: the reasoning the diff cannot show", section(body, "Context") === "A template file would drift from the sections.", section(body, "Context"));
  ok("verification: what was actually run", section(body, "Verification").includes("npm test"), section(body, "Verification"));
}

// ── the closing keyword is the HOST's, once (AC2): v1 omitted it on a failed run and
//    every one of those PRs merged leaving its issue open and its dependents deferred
//    forever, so it is written here from the issue number, never from prose ──
{
  const body = composeBody(
    { signal: "ready", description: "Done.", relatedIssues: [31, 36] },
    { ...FACTS, issue: 37 },
  );
  ok("closes: written exactly once", body.match(/Closes #37/g)?.length === 1, body);
  ok("closes: it lives in the Related issue section, not in prose", section(body, "Related issue").includes("Closes #37."), section(body, "Related issue"));
  ok(
    "related: the agent's issue NUMBERS are rendered as references by the host",
    section(body, "Related issue").includes("#31") && section(body, "Related issue").includes("#36"),
    section(body, "Related issue"),
  );
  ok(
    "related: a listed issue is never closed by being listed",
    !/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\W+#(?:31|36)/i.test(body),
    section(body, "Related issue"),
  );
}

// ── agent prose can never close an issue (AC2, the sensitive path): a keyword the agent
//    wrote in ANY section closes that issue on merge otherwise — silently, and for
//    somebody else's work item ──
{
  const live = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*(?:#\d+|GH-\d+|[\w.-]+\/[\w.-]+#\d+|https?:\/\/\S+?\/issues\/\d+)/gi;
  const body = composeBody(
    {
      signal: "draft",
      description: "Fixes #12 along the way.",
      context: "This resolves #9, which the composer inherited.",
      verification: "Reproduced the report in fixed https://github.com/ieuanign/sunday/issues/8 by hand.",
      review: { verdict: "CHANGES_REQUESTED", body: "Accepted: the helper stays. Closed GH-7 in passing." },
    },
    FACTS,
  );
  ok(
    "defuse: the ONLY live closing keyword in the whole body is the host's own",
    JSON.stringify(body.match(live)) === JSON.stringify(["Closes #37"]),
    JSON.stringify(body.match(live)),
  );
  ok("defuse: the description's reference is still readable", section(body, "Description").includes("Fixes #") && section(body, "Description").includes("12"), section(body, "Description"));
  ok("defuse: the context's reference is still readable", section(body, "Context").includes("resolves #") && section(body, "Context").includes("9,"), section(body, "Context"));
  ok("defuse: the verification's issue URL is still readable", section(body, "Verification").includes("github.com/ieuanign/sunday/issues/") && section(body, "Verification").includes("8"), section(body, "Verification"));
  ok("defuse: the review's `GH-` reference is still readable", section(body, "Review findings").includes("Closed GH-") && section(body, "Review findings").includes("7"), section(body, "Review findings"));
  ok("defuse: prose that names no issue is left exactly as the agent wrote it", section(body, "Description").startsWith("Fixes #") && section(body, "Description").endsWith("along the way."), section(body, "Description"));
}

// ── a result carrying only the prose still ships every section (AC5): the new fields
//    are optional so a malformed emit costs a section, not the run — and a section that
//    was not answered SAYS so, rather than vanishing (a reviewer cannot tell an absent
//    section from one nobody thought to write) ──
{
  const body = composeBody({ signal: "ready", description: "Bumped the timeout." }, FACTS);
  ok(
    "degrade: all seven sections are still there",
    JSON.stringify(headings(body)) ===
      JSON.stringify(["Description", "Related issue", "Context", "Type of change", "Risk", "Verification", "Review findings"]),
    JSON.stringify(headings(body)),
  );
  for (const name of ["Context", "Type of change", "Risk", "Verification"]) {
    ok(`degrade: ${name} says it was not provided rather than reading as empty`, /not provided/i.test(section(body, name)), `${name}: "${section(body, name)}"`);
  }
  ok("degrade: the closing keyword survives a bare result", section(body, "Related issue").includes("Closes #37."), section(body, "Related issue"));
  ok("degrade: the description itself is the agent's, untouched", section(body, "Description") === "Bumped the timeout.", section(body, "Description"));
}

// ── the review section always carries a VERDICT (AC4): an absent review is NOT_RUN, not
//    a blank section that reads as a clean bill of health ──
{
  const withReview = (review: IssueResult["review"]) =>
    section(composeBody({ signal: "ready", description: "d", ...(review ? { review } : {}) }, FACTS), "Review findings");

  const absent = withReview(undefined);
  ok("review: an absent review renders NOT_RUN", absent.includes("NOT_RUN"), absent);
  ok("review: NOT_RUN never presents as approved or as a finding-free pass", !absent.includes("APPROVED") && absent.length > "NOT_RUN".length, absent);
  ok("review: NOT_RUN is not just the generic missing-section copy", !/not provided/i.test(absent), absent);

  const approved = withReview({ verdict: "APPROVED", body: "Nothing to change." });
  const errored = withReview({ verdict: "ERROR", body: "The reviewer crashed on the second file." });
  ok("review: APPROVED states its verdict and its findings", approved.includes("APPROVED") && approved.includes("Nothing to change."), approved);
  ok("review: ERROR is distinguishable from APPROVED — a review that blew up is not clean", errored.includes("ERROR") && !errored.includes("APPROVED"), errored);
  ok("review: the findings the review reported are the agent's own prose", errored.includes("crashed on the second file"), errored);

  const silent = withReview({ verdict: "CHANGES_REQUESTED", body: "   " });
  ok("review: a verdict with no findings still states the verdict", silent.includes("CHANGES_REQUESTED"), silent);
  ok("review: and says the findings are missing rather than showing an empty list", /not provided/i.test(silent), silent);
}

// ── risk is ONE level (AC3), so a reviewer can triage on it — in the same FORM as the
//    Type of change section directly above it: the whole vocabulary, exactly one tick
//    (the dogfooded template, `docs/agents/dev-loop.md`). Two adjacent sections that
//    disagree in form is what a reader trips over ──
{
  const risk = (level: IssueResult["risk"]) => section(composeBody({ signal: "ready", description: "d", ...(level ? { risk: level } : {}) }, FACTS), "Risk");
  for (const level of ["low", "medium", "high"] as const) {
    const rendered = risk(level);
    ok(`risk: \`${level}\` is the level ticked…`, new RegExp(`- \\[x\\] ${level}$`, "im").test(rendered), rendered);
    ok(`risk: …and it is the only tick — a body cannot state two`, (rendered.match(/\[x\]/gi) ?? []).length === 1, rendered);
    ok(`risk: …with the levels it is not still listed, unticked`, (rendered.match(/^- \[/gm) ?? []).length === 3, rendered);
  }
  ok("risk: an absent level says so rather than being guessed at", !/low|medium|high/i.test(risk(undefined)) && risk(undefined).length > 0, risk(undefined));
  ok(
    "risk: an absent level is NOT an all-unticked list — that form reads as a deliberate 'no level applies'",
    !risk(undefined).includes("- ["),
    risk(undefined),
  );
}

// ── the type of change ticks the subset the agent chose, out of the whole vocabulary —
//    a reviewer triages on what was NOT ticked as much as on what was ──
{
  const kinds = (types: IssueResult["typeOfChange"]) =>
    section(composeBody({ signal: "ready", description: "d", ...(types ? { typeOfChange: types } : {}) }, FACTS), "Type of change");

  const some = kinds(["new feature", "docs"]);
  ok("types: the ticked ones are the agent's subset", /- \[x\] New feature/i.test(some) && /- \[x\] Docs/i.test(some), some);
  ok("types: the rest are shown unticked, not hidden", /- \[ \] Breaking change/i.test(some) && /- \[ \] Bug fix/i.test(some), some);
  ok("types: exactly two ticks for a two-item subset", (some.match(/\[x\]/gi) ?? []).length === 2, some);

  const none = kinds([]);
  ok("types: an empty list is a real answer — nothing ticked, every kind still listed", (none.match(/\[x\]/gi) ?? []).length === 0 && (none.match(/- \[/g) ?? []).length === 4, none);
  ok("types: an ABSENT list is a missing answer, and says so", /not provided/i.test(kinds(undefined)), kinds(undefined));
}

// ── the footer is the HOST's own account of the run (AC6): six facts the agent is never
//    asked for, under the attribution every Sunday-authored surface carries ──
{
  const foot = footer(composeBody({ signal: "ready", description: "d" }, FACTS));
  ok("footer: carries the Sunday attribution", foot.includes(SUNDAY_SIGN), foot);
  ok("footer: commits — the count the host measured", /\b3 commits\b/.test(foot), foot);
  ok("footer: file stats", foot.includes("16 files") && foot.includes("1533") && foot.includes("49"), foot);
  ok("footer: base", foot.includes("main"), foot);
  ok("footer: model", foot.includes("claude-opus-4-6"), foot);
  ok("footer: duration, as a human reads it", foot.includes("12m 04s"), foot);
  ok("footer: this run's log path, verbatim", foot.includes(FACTS.logPath), foot);
  ok("footer: one commit is not `1 commits`", footer(composeBody({ signal: "ready", description: "d" }, { ...FACTS, commits: 1 })).includes("1 commit ·"), footer(composeBody({ signal: "ready", description: "d" }, { ...FACTS, commits: 1 })));
}

// ── the two facts the host may not have: the stat read is best-effort AFTER the push
//    (a `git` blip there must not turn a shipped PR into a failed run), and only the
//    agent adapter knows the model ──
{
  const foot = footer(composeBody({ signal: "ready", description: "d" }, { ...FACTS, model: undefined, stat: undefined }));
  ok("footer: an unread file stat degrades that fact only", foot.includes(SUNDAY_SIGN) && foot.includes("3 commits") && foot.includes(FACTS.logPath), foot);
  ok("footer: and neither missing fact is fabricated", !foot.includes("0 files") && !/model `/.test(foot), foot);
  ok("footer: both are named as unavailable rather than dropped", (foot.match(/unavailable|unknown|not reported/gi) ?? []).length === 2, foot);
}

console.log(fails === 0 ? "\nAll issue-body smokes pass." : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
