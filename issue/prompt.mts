// issue/prompt.mts — what an issue run SAYS to the agent, and the shape it must answer
// in. One file so the `<sunday-result>` literal, the schema that validates it and the
// prompts that carry it cannot drift apart: the agent library extracts the result BY the
// tag, so a prompt that names a different one is a run that spends its whole quota and
// then fails to be understood.

import { z } from "zod";

/** The XML tag the agent wraps its one result in (`docs/sandbox-prompt.md` §4). */
export const RESULT_TAG = "sunday-result";

/** The XML tag the bounded handoff turn wraps its note in (#67). Its own tag, not the
 *  result one: that turn answers with prose and no schema, and a note arriving under
 *  `<sunday-result>` would be read as a signal the run then acts on. */
export const HANDOFF_TAG = "sunday-handoff";

/** The change kinds a PR body ticks. A fixed vocabulary, not free prose: the body ticks
 *  the subset the agent chose out of exactly these, and a reviewer triages on them. */
export const TYPES_OF_CHANGE = ["new feature", "breaking change", "bug fix", "docs"] as const;

/** How much of a blast radius the change has. A fixed vocabulary for the same reason:
 *  the body lists all three and ticks exactly the one the agent chose (AC3). */
export const RISK_LEVELS = ["low", "medium", "high"] as const;

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
  risk: z.enum(RISK_LEVELS).optional(),
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
 *  point resolves every path it is handed).
 *
 *  `retryError` is present on #39's ONE retry: what the previous attempt died on. It goes
 *  in LAST, and fenced and labelled as the previous run's — unmarked it reads as part of
 *  the issue the human wrote, and an agent that treats a stack trace as a requirement
 *  spends its run on the wrong problem. */
export function freshPrompt(
  baseline: string,
  repo: string,
  issue: number,
  title: string,
  body: string,
  retryError?: string,
): string {
  const resolved = baseline.replaceAll("{{REPO}}", repo).replaceAll("{{ISSUE}}", String(issue));
  const prompt = `${resolved}\n\n---\n\n# Issue #${issue}: ${title}\n\n${body}\n`;
  if (!retryError) return prompt;
  return (
    `${prompt}\n---\n\n# The previous attempt at this issue failed\n\n` +
    `Sunday already ran this issue once and it ended with the error below. It is the ` +
    `previous run's failure, not part of the issue: work out what it means for the work, ` +
    `and do not treat it as a requirement.\n\n` +
    "```\n" +
    `${retryError}\n` +
    "```\n"
  );
}

/** A gate resume's prompt: the human's answer, and the reminder that carries the tag.
 *  Deliberately NOT the baseline again — the session being resumed already has it. */
export function resumePrompt(reply: string): string {
  return `${reply}${RESUME_REMINDER}`;
}

/** The one bounded turn a session too big to resume gets (#67): compact yourself into a
 *  note a FRESH agent can continue from, and do nothing else.
 *
 *  The instructions are spelled here rather than lifted from `.claude/skills/handoff/`
 *  at runtime, as v1 did. That skill tells the agent to SAVE the document to a folder,
 *  and v1 regex-swapped that line for "emit it in a tag" — the line it matched no longer
 *  exists, so the swap is now a silent no-op that would leave an agent in a
 *  credential-free box writing a file into the worktree it is judged on. Its substance is
 *  four lines, and they are these.
 *
 *  A CONSTANT, not a composer: this turn is told nothing about the issue on purpose. It
 *  is summarising a session that already holds all of it, and every extra token here is
 *  spent on the one turn the handoff costs. */
export const handoffPrompt =
  `You are compacting THIS session into a handoff note for a fresh agent that will ` +
  `continue and finish the work. Do ONLY that: write no code, change no file, make no ` +
  `commit, run nothing.\n\n` +
  `Summarise the session so the fresh agent can carry on without you: what the work is, ` +
  `what has been done and committed so far, what is left, and the decisions and dead ends ` +
  `it would otherwise repeat. Name the skills it should invoke. Reference plans, ADRs, ` +
  `issues and commits by path or number rather than duplicating them. Redact anything ` +
  `sensitive — tokens, keys, personal data.\n\n` +
  `Emit the note as your ONLY output, inside one \`<${HANDOFF_TAG}>…</${HANDOFF_TAG}>\` ` +
  `tag. Do not write it to a file: you are in a sandbox with no credentials, and a file ` +
  `you leave behind dirties the worktree the work is judged on.`;

/** The lead-in that tells the fresh session what it is reading and why it exists. Without
 *  it the note reads as a brief someone wrote for it rather than as its own predecessor's
 *  last words — and the branch it describes is already checked out, with commits on it. */
const CONTINUE_LEADIN =
  `---\n\nThe note above is the handoff from the session that was doing this work: it grew ` +
  `too large to continue, so you are its fresh continuation. Its branch, its commits and ` +
  `its checkout are all already here — carry on from where the note leaves off. Below is ` +
  `the human's answer to the question that session stopped to ask.`;

/** What a handed-off run starts with: the retired session's note, the lead-in that frames
 *  it, then exactly what an ordinary resume would have said — the human's reply and the
 *  reminder that carries the result tag. The tail is `resumePrompt`'s own so the two
 *  cannot drift: a fresh session that is never told how to finish spends its whole run
 *  and then fails to be understood. */
export function handoffSeedPrompt(note: string, reply: string): string {
  return `${note}\n\n${CONTINUE_LEADIN}\n\n${resumePrompt(reply)}`;
}
