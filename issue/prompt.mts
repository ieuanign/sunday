// issue/prompt.mts — what an issue run SAYS to the agent, and the shape it must answer
// in. One file so the `<sunday-result>` literal, the schema that validates it and the
// prompts that carry it cannot drift apart: the agent library extracts the result BY the
// tag, so a prompt that names a different one is a run that spends its whole quota and
// then fails to be understood.

import { z } from "zod";

/** The XML tag the agent wraps its one result in (`docs/sandbox-prompt.md` §4). */
export const RESULT_TAG = "sunday-result";

/** The change kinds a PR body ticks. A fixed vocabulary, not free prose: the body ticks
 *  the subset the agent chose out of exactly these, and a reviewer triages on them. */
export const TYPES_OF_CHANGE = ["new feature", "breaking change", "bug fix", "docs"] as const;

/** What Sunday's own review phase concluded. `NOT_RUN` is sayable on purpose — a review
 *  that never happened has to be distinguishable from a clean one (#31 story 36), and an
 *  absent `review` is composed as this same verdict rather than as an empty finding list. */
export const REVIEW_VERDICTS = ["APPROVED", "CHANGES_REQUESTED", "ERROR", "NOT_RUN"] as const;

/** What the agent decided, and everything the PR body is composed from. `signal` and
 *  `description` are what a run ACTS on — v1's four signals unchanged, and the prose the
 *  outcome carries. Everything below them is a section of the body (#37 AC1) and is
 *  OPTIONAL (AC5): a missing one degrades its section, it never costs a run that was
 *  otherwise finished.
 *
 *  Nothing here can close an issue. `relatedIssues` are NUMBERS the host renders itself,
 *  and every prose field is defused of closing keywords before it is rendered
 *  (`issue/body.mts`) — the `Closes #<n>` in a Sunday PR is host-written, always. */
export const resultSchema = z.object({
  signal: z.enum(["ready", "draft", "gate", "fail"]),
  description: z.string(),
  /** The question a `gate` is asking. */
  question: z.string().optional(),
  /** Why the change took this shape — the reasoning a diff cannot show. */
  context: z.string().optional(),
  typeOfChange: z.array(z.enum(TYPES_OF_CHANGE)).optional(),
  /** Exactly one level (AC3) — a body cannot state two, and states none when absent. */
  risk: z.enum(["low", "medium", "high"]).optional(),
  /** What was actually run, so a reviewer knows what "verified" means here. */
  verification: z.string().optional(),
  relatedIssues: z.array(z.number()).optional(),
  review: z
    .object({
      verdict: z.enum(REVIEW_VERDICTS),
      /** What the review found: what was fixed, and what was accepted and why. */
      body: z.string(),
    })
    .optional(),
});

export type IssueResult = z.infer<typeof resultSchema>;

/** Appended to a resume prompt. The human's reply carries no tag, and the library
 *  requires the literal in the resolved prompt — so the reminder both satisfies that and
 *  tells the agent to finish the same way it did before it gated. */
const RESUME_REMINDER =
  `\n\n---\n\nWhen you have addressed this, finish exactly as before: emit one ` +
  `\`<${RESULT_TAG}>{ "signal": …, "description": …, "question": … }</${RESULT_TAG}>\` result.`;

/** A fresh run's prompt: the repo's baseline with its placeholders filled, then the issue
 *  itself. The baseline TEXT is passed in — the run module reads no files (the entry
 *  point resolves every path it is handed). */
export function freshPrompt(baseline: string, repo: string, issue: number, title: string, body: string): string {
  const resolved = baseline.replaceAll("{{REPO}}", repo).replaceAll("{{ISSUE}}", String(issue));
  return `${resolved}\n\n---\n\n# Issue #${issue}: ${title}\n\n${body}\n`;
}

/** A gate resume's prompt: the human's answer, and the reminder that carries the tag.
 *  Deliberately NOT the baseline again — the session being resumed already has it. */
export function resumePrompt(reply: string): string {
  return `${reply}${RESUME_REMINDER}`;
}
