// issue/prompt.mts — what an issue run SAYS to the agent, and the shape it must answer
// in. One file so the `<sunday-result>` literal, the schema that validates it and the
// prompts that carry it cannot drift apart: the agent library extracts the result BY the
// tag, so a prompt that names a different one is a run that spends its whole quota and
// then fails to be understood.

import { z } from "zod";

/** The XML tag the agent wraps its one result in (`docs/sandbox-prompt.md` §4). */
export const RESULT_TAG = "sunday-result";

/** What the agent decided. `ready`/`draft` ship, `gate` stops to ask a human, `fail`
 *  reports honestly — v1's four signals, unchanged, because the baseline prompt every
 *  routed repo already carries names exactly these. */
export const resultSchema = z.object({
  signal: z.enum(["ready", "draft", "gate", "fail"]),
  summary: z.string(),
  /** The question a `gate` is asking. */
  question: z.string().optional(),
});

export type IssueResult = z.infer<typeof resultSchema>;

/** Appended to a resume prompt. The human's reply carries no tag, and the library
 *  requires the literal in the resolved prompt — so the reminder both satisfies that and
 *  tells the agent to finish the same way it did before it gated. */
const RESUME_REMINDER =
  `\n\n---\n\nWhen you have addressed this, finish exactly as before: emit one ` +
  `\`<${RESULT_TAG}>{ "signal": …, "summary": …, "question": … }</${RESULT_TAG}>\` result.`;

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
