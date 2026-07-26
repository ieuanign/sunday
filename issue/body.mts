// issue/body.mts — the pull request body, composed in code. One pure function: the
// agent's result plus the host's own facts in, markdown out.
//
// Pure on purpose. It runs between the push and `gh pr create`, so a throw here would
// lose a pushed branch's PR (ADR-0001), and `issue/index.mts` stays a class over
// injected services that reads no file and resolves no path.

import { SUNDAY_SIGN } from "#lib/markers.mts";
import type { DiffStat } from "#services/git.mts";
import { TYPES_OF_CHANGE, type IssueResult } from "./prompt.mts";

/** What only the HOST knows: the issue the PR closes, and the six facts the footer
 *  states. The optional ones degrade their part of the footer rather than being
 *  fabricated — a `git` blip must not turn a shipped PR into a failed run. */
export interface BodyFacts {
  /** The issue this run was for — the `Closes #<n>` is written from this, always. */
  issue: number;
  base: string;
  /** Commits ahead of the base, as git counts them — NOT the agent's own commit list,
   *  which on a gate resume names only the resuming session's. */
  commits: number;
  durationMs: number;
  logPath: string;
  model?: string;
  stat?: DiffStat;
}

/** A closing keyword the agent wrote, up to (but not including) the number of the issue
 *  it would close: `Fixes #12`, `resolves owner/repo#9`, `closed GH-4`, `fixed
 *  https://github.com/o/r/issues/7`. Everything GitHub reads as "merging this finishes
 *  that issue". */
const CLOSING_REFERENCE =
  /\b(?:clos(?:e|es|ed)|fix(?:es|ed)?|resolv(?:e|es|ed))\b\s*:?\s*(?:#|GH-|[\w.-]+\/[\w.-]+#|https?:\/\/\S+?\/issues\/)(?=\d)/gi;

/** A zero-width space, as an HTML entity so it survives a round trip through markdown.
 *  Slipped between the keyword and the number, it renders invisibly — the reference
 *  still READS as `#12`, and GitHub no longer sees a reference there at all. */
const INERT = "&#8203;";

/** Every agent-supplied section goes through here (AC2). Not just the related-issues
 *  list: an agent that writes "Fixes #12" in its DESCRIPTION closes #12 on merge —
 *  somebody else's work item, silently, with its dependents released early. The agent
 *  may point at an issue; only the host may close one. */
function defuse(prose: string): string {
  return prose.replace(CLOSING_REFERENCE, (keyword) => `${keyword}${INERT}`);
}

/** What a section the agent did not answer says (AC5). Explicit, because the fields are
 *  optional so a missing one degrades its section instead of costing a finished run —
 *  and a section that simply vanished reads as one nobody thought to write. */
const NOT_PROVIDED = "_Not provided._";

/** One agent-supplied prose section: defused, or said to be missing. */
function prose(text: string | undefined): string {
  const trimmed = text?.trim();
  return trimmed ? defuse(trimmed) : NOT_PROVIDED;
}

function duration(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
}

/** The host's own account of the run (AC6), under the attribution every Sunday-authored
 *  surface carries. The two facts the host may not have say so: the stat is a
 *  best-effort read AFTER the push, and only the agent adapter knows a model — a
 *  fabricated `0 files` or a silently dropped fact is worse than either. */
function footer(facts: BodyFacts): string {
  const stat = facts.stat;
  return [
    SUNDAY_SIGN,
    `${facts.commits} commit${facts.commits === 1 ? "" : "s"}`,
    stat ? `${stat.files} file${stat.files === 1 ? "" : "s"}, +${stat.insertions}/−${stat.deletions}` : "file stats unavailable",
    `base \`${facts.base}\``,
    facts.model ? `model \`${facts.model}\`` : "model unknown",
    duration(facts.durationMs),
    `log \`${facts.logPath}\``,
  ].join(" · ");
}

/** The one section the agent cannot write: `Closes #<n>` comes from the issue the run
 *  was for and is UNCONDITIONAL (AC2) — v1 omitted it on a failed signal, and every one
 *  of those PRs merged leaving its issue open and its dependents deferred forever. What
 *  the agent may add is a list of OTHER issues, as plain references that close nothing. */
function relatedIssue(related: number[] | undefined, issue: number): string {
  const others = (related ?? []).filter((n) => n !== issue);
  const also = others.length ? `\n\nAlso related: ${others.map((n) => `#${n}`).join(", ")}` : "";
  return `Closes #${issue}.${also}`;
}

/** The whole vocabulary, with the agent's subset ticked. The unticked kinds stay on the
 *  page: "not a breaking change" is what a reviewer triages on, and it is only readable
 *  if the kind is listed at all. */
function typeOfChange(chosen: IssueResult["typeOfChange"]): string {
  if (!chosen) return NOT_PROVIDED;
  return TYPES_OF_CHANGE.map(
    (kind) => `- [${chosen.includes(kind) ? "x" : " "}] ${kind[0].toUpperCase()}${kind.slice(1)}`,
  ).join("\n");
}

/** What Sunday's own review phase concluded, verdict FIRST and always (AC4). An absent
 *  `review` is `NOT_RUN` — never `APPROVED` by default, and never an empty findings list
 *  a reviewer could read as a clean bill of health (#31 story 36). */
function reviewFindings(review: IssueResult["review"]): string {
  if (!review) return "**NOT_RUN** — this run reported no review phase, so nothing here has been reviewed by Sunday.";
  return `**${review.verdict}**\n\n${prose(review.body)}`;
}

/** The agent-supplied sections, in the order #31 lists them, then the host's footer. */
export function composeBody(result: IssueResult, facts: BodyFacts): string {
  return [
    `## Description\n\n${prose(result.description)}`,
    `## Related issue\n\n${relatedIssue(result.relatedIssues, facts.issue)}`,
    `## Context\n\n${prose(result.context)}`,
    `## Type of change\n\n${typeOfChange(result.typeOfChange)}`,
    `## Risk\n\n${result.risk ?? NOT_PROVIDED}`,
    `## Verification\n\n${prose(result.verification)}`,
    `## Review findings\n\n${reviewFindings(result.review)}`,
    `---\n\n${footer(facts)}`,
  ].join("\n\n");
}
