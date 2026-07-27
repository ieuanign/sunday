// pr/prompt.mts — what a PR-comment run SAYS to the agent, and the shape it must answer
// in. One file so the `<sunday-result>` literal, the schema that validates it and the
// prompt that carries it cannot drift apart: the agent library extracts the result BY the
// tag, so a prompt that names a different one is a run that spends its whole quota and
// then fails to be understood.

import { z } from "zod";

/** The XML tag the agent wraps its one result in (`docs/sandbox-pr-comment-prompt.md`
 *  §5). The same literal an issue run uses — the two lanes never run in one session, and
 *  what differs is the SHAPE inside it. */
export const RESULT_TAG = "sunday-result";

/** What the agent decided. No `committed` field: whether anything is pushed is GIT's
 *  answer, counted against the SHA the run started from (constraint 9), and an agent that
 *  merely believes it committed must not be able to trigger a push — or to suppress one.
 *
 *  `replies` is the deliverable: one entry per gathered comment, `fixed` saying whether
 *  code changed for it and `body` the prose a human reads. A comment the agent omits is
 *  still answered (constraint 8) — the run composes that one itself. */
export const resultSchema = z.object({
  /** One line for the run log: what the agent changed overall. */
  summary: z.string(),
  replies: z.array(
    z.object({
      /** The gathered comment's own GitHub id, echoed back from the prompt. */
      comment: z.number(),
      fixed: z.boolean(),
      body: z.string(),
    }),
  ),
});

export type PrResult = z.infer<typeof resultSchema>;

/** One `@sunday` comment this run has to answer, from either stream. `kind` is what
 *  decides HOW it is answered — an inline comment threads under itself, a conversation
 *  one cannot and is quoted instead — and it travels into the prompt too: an agent told
 *  which file and line a request sits on opens that line before it judges it. */
export interface GatheredComment {
  /** GitHub's own id, which the agent echoes back in its reply. */
  id: number;
  kind: "inline" | "conversation";
  /** `path:line` for an inline comment; absent on a conversation one. */
  location?: string;
  body: string;
}

/** The prompt one PR-comment run hands the agent: the repo's baseline with its
 *  placeholders filled, then the comments it has to answer — each headed by the id it
 *  must echo back in its reply, and inline ones by the `file:line` to open before
 *  judging. The baseline TEXT is passed in; the run module reads no files.
 *
 *  `retryError` is present on #39's ONE retry: what the previous attempt died on. It goes
 *  in LAST, and fenced and labelled as the previous run's — unmarked it reads as one more
 *  thing a human asked for, and an agent that treats a stack trace as a request spends
 *  its run on the wrong problem. */
export function prPrompt(
  baseline: string,
  pr: { repo: string; number: number; base: string },
  comments: GatheredComment[],
  retryError?: string,
): string {
  const resolved = baseline
    .replaceAll("{{REPO}}", pr.repo)
    .replaceAll("{{PR}}", String(pr.number))
    .replaceAll("{{BASE}}", pr.base);
  const list = comments
    .map((c) => `## comment ${c.id} — ${c.kind}${c.location ? `, ${c.location}` : ""}\n\n${c.body}`)
    .join("\n\n");
  const prompt = `${resolved}\n\n---\n\n# @sunday comments on PR #${pr.number}\n\n${list}\n`;
  if (!retryError) return prompt;
  return (
    `${prompt}\n---\n\n# The previous attempt at these comments failed\n\n` +
    `Sunday already ran this pull request once and it ended with the error below. It is ` +
    `the previous run's failure, not something anybody asked for: work out what it means ` +
    `for the work, and do not treat it as a request.\n\n` +
    "```\n" +
    `${retryError}\n` +
    "```\n"
  );
}
