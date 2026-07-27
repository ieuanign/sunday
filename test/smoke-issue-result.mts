// test/smoke-issue-result.mts — hermetic smoke for the RESULT CONTRACT an issue run is
// answered in (issue #37): the shape `docs/sandbox-prompt.md` §4 tells every routed
// repo's agent to emit, and the shape the PR body is composed from. Asserted at the parse
// seam because that is where the contract is actually enforced — the agent library
// validates against this schema before the run ever sees an answer, so a field wrongly
// made required is a well-behaved agent's whole run wasted on a re-emit.
//   devbox run node test/smoke-issue-result.mts
// $0, offline, no docker, no network, no tokens.

import { resultSchema } from "#issue/prompt.mts";

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : `\n    ${detail}`}`);
};

// ── the prose field is REQUIRED: the rename is a rename, not a relaxation ──
{
  const r = resultSchema.safeParse({ signal: "ready" });
  ok("description: a result without it is malformed — an empty PR body is worse than a re-emit", !r.success, JSON.stringify(r.data));
}

// ── everything the body's sections are composed from is OPTIONAL (AC5): an agent that
//    emits only the prose degrades six sections, it does not fail its run ──
{
  const r = resultSchema.safeParse({ signal: "ready", description: "Added the guard and a test." });
  ok("minimal: signal + description alone parses", r.success, JSON.stringify(r.error?.issues));
  ok(
    "minimal: the six new fields are simply absent — never defaulted into something the agent did not say",
    r.data?.context === undefined &&
      r.data?.typeOfChange === undefined &&
      r.data?.risk === undefined &&
      r.data?.verification === undefined &&
      r.data?.relatedIssues === undefined &&
      r.data?.review === undefined,
    JSON.stringify(r.data),
  );
}

// ── a fully-filled result carries every section through to the composer ──
{
  const r = resultSchema.safeParse({
    signal: "ready",
    description: "Composed the PR body in code.",
    context: "A template file would drift from the sections.",
    typeOfChange: ["new feature", "docs"],
    risk: "low",
    verification: "npm run typecheck && npm run lint && npm test",
    relatedIssues: [31, 36],
    review: { verdict: "CHANGES_REQUESTED", body: "Findings: the footer dropped the base." },
  });
  ok("full: parses", r.success, JSON.stringify(r.error?.issues));
  ok("full: the ticked types survive as the subset the agent chose", JSON.stringify(r.data?.typeOfChange) === '["new feature","docs"]', JSON.stringify(r.data?.typeOfChange));
  ok("full: context and verification are the agent's own prose", r.data?.context?.startsWith("A template") === true && r.data?.verification?.includes("npm test") === true, JSON.stringify(r.data));
  ok("full: related issues arrive as NUMBERS — the host renders the reference itself", JSON.stringify(r.data?.relatedIssues) === "[31,36]", JSON.stringify(r.data?.relatedIssues));
  ok("full: the review verdict and its findings ride together", r.data?.review?.verdict === "CHANGES_REQUESTED" && r.data?.review?.body.includes("footer") === true, JSON.stringify(r.data?.review));
}

// ── risk records exactly ONE level (AC3) ──
{
  ok("risk: `medium` is a level", resultSchema.safeParse({ signal: "ready", description: "d", risk: "medium" }).success);
  ok("risk: an invented level is rejected rather than rendered as one", !resultSchema.safeParse({ signal: "ready", description: "d", risk: "critical" }).success);
  ok("risk: two levels are not representable", !resultSchema.safeParse({ signal: "ready", description: "d", risk: ["low", "high"] }).success);
}

// ── the review phase's verdict, including the one that says it never ran (AC4) ──
{
  ok(
    "review: NOT_RUN is sayable — a skipped review must be able to declare itself",
    resultSchema.safeParse({ signal: "draft", description: "d", review: { verdict: "NOT_RUN", body: "the phase was skipped" } }).success,
  );
  ok(
    "review: ERROR is distinct from APPROVED — a review that blew up is not a clean bill of health",
    resultSchema.safeParse({ signal: "draft", description: "d", review: { verdict: "ERROR", body: "the reviewer crashed" } }).success,
  );
  ok(
    "review: an off-vocabulary verdict is rejected, so the body can never claim one Sunday does not know",
    !resultSchema.safeParse({ signal: "ready", description: "d", review: { verdict: "LGTM", body: "ship it" } }).success,
  );
}

// ── the type-of-change vocabulary is fixed: the body ticks a known list ──
{
  ok("typeOfChange: an off-vocabulary type is rejected", !resultSchema.safeParse({ signal: "ready", description: "d", typeOfChange: ["refactor"] }).success);
  ok("typeOfChange: the empty list parses — nothing ticked is a legitimate answer", resultSchema.safeParse({ signal: "ready", description: "d", typeOfChange: [] }).success);
}

console.log(fails === 0 ? "\nAll issue-result smokes pass." : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
