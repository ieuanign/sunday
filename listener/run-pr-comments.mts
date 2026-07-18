// listener/run-pr-comments.mts — the @sunday-on-a-PR action (M2, PR feedback).
//
// A human summons Sunday with @sunday on a PR (conversation or inline on a file
// line). This runs a FRESH credential-free sandbox with the PR-comment baseline
// (docs/sandbox-pr-comment-prompt.md): the agent reads the diff + the injected
// @sunday comments, fixes what's warranted via /implement (commits locally), and
// emits per-comment replies. This host pushes (if it committed) and posts each
// reply — inline comments thread, conversation comments are quoted.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { run, claudeCode, Output } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { z } from "zod";

import { sh, isSummon } from "./helper.mts";
import { sundayComment } from "./run-issue.mts";
import type { RepoConfig } from "#config/repos.mts";

const parentRoot = resolve(import.meta.dirname, "..");
const PR_PROMPT_FILE = "docs/sandbox-pr-comment-prompt.md";
const SIGNAL_TAG = "sunday-result";

// The agent's result (same tag as run-issue, different shape): did it commit any
// fix (→ push), and one reply per @sunday comment (→ post to that comment).
const prResultSchema = z.object({
  committed: z.boolean(),
  summary: z.string(),
  replies: z.array(
    z.object({ comment: z.number(), fixed: z.boolean(), body: z.string() }),
  ),
});

export interface SundayComment {
  id: number;
  kind: "inline" | "conversation";
  author: string;
  /** "path:line" for inline comments; absent for conversation. */
  location?: string;
  body: string;
}

/** The @sunday comments on a PR, from both sources: the conversation timeline
 *  (issue comments) and inline review comments (the Files-changed tab). Our own
 *  comments (marker) are excluded. */
export function gatherComments(fullName: string, childDir: string, pr: string): SundayComment[] {
  const conv = JSON.parse(
    sh("gh", ["api", `repos/${fullName}/issues/${pr}/comments`,
      "--jq", "[.[] | { id, author: .user.login, body }]"], childDir),
  ) as { id: number; author: string; body: string }[];
  const inline = JSON.parse(
    sh("gh", ["api", `repos/${fullName}/pulls/${pr}/comments`,
      "--jq", "[.[] | { id, author: .user.login, body, path, line }]"], childDir),
  ) as { id: number; author: string; body: string; path: string; line: number }[];

  return [
    ...conv
      .filter((c) => isSummon(c.body))
      .map((c): SundayComment => ({ id: c.id, kind: "conversation", author: c.author, body: c.body })),
    ...inline
      .filter((c) => isSummon(c.body))
      .map((c): SundayComment => ({
        id: c.id, kind: "inline", author: c.author, location: `${c.path}:${c.line}`, body: c.body,
      })),
  ];
}

/** Baseline prompt + the injected @sunday comments (each keyed by its id, which
 *  the agent echoes back in its replies). */
export function composePrompt(
  fullName: string, pr: string, issue: string, base: string, comments: SundayComment[],
): string {
  const baseline = readFileSync(resolve(parentRoot, PR_PROMPT_FILE), "utf8")
    .replaceAll("{{REPO}}", fullName)
    .replaceAll("{{PR}}", pr)
    .replaceAll("{{ISSUE}}", issue)
    .replaceAll("{{BASE}}", base);
  const list = comments
    .map((c) => `## comment ${c.id} — ${c.kind}${c.location ? `, ${c.location}` : ""} (@${c.author})\n${c.body}`)
    .join("\n\n");
  return `${baseline}\n\n---\n\n# @sunday comments on PR #${pr}\n\n${list}\n`;
}

/** Post one reply to its comment: inline → threaded reply; conversation → a new
 *  PR comment quoting the original (conversation comments don't thread). Both
 *  carry our marker + visible sign via sundayComment. */
function postReply(fullName: string, childDir: string, pr: string, c: SundayComment, body: string): void {
  const marked = sundayComment(body);
  if (c.kind === "inline") {
    sh("gh", ["api", `repos/${fullName}/pulls/${pr}/comments/${c.id}/replies`, "-f", `body=${marked}`], childDir);
  } else {
    const quoted = `> @${c.author}: ${c.body.split("\n")[0]}\n\n${marked}`;
    sh("gh", ["pr", "comment", pr, "--body", quoted], childDir);
  }
}

/**
 * Address the @sunday comments on one PR. Reads the PR's branch/base, gathers the
 * comments, runs a fresh sandbox on that branch, then (if it committed) pushes
 * and posts every reply. Throws on a missing MODEL, a malformed result after one
 * retry, or any git/gh failure.
 */
export async function runPrComments(fullName: string, cfg: RepoConfig, pr: string): Promise<void> {
  const model = process.env.MODEL;
  if (!model) {
    throw new Error("MODEL is unset — load .env first (node --env-file=.env …).");
  }
  const childDir = resolve(parentRoot, cfg.path);

  const { headRefName: branch, baseRefName: base } = JSON.parse(
    sh("gh", ["pr", "view", pr, "--json", "headRefName,baseRefName"], childDir),
  ) as { headRefName: string; baseRefName: string };
  const issue = branch.replace(/^feat\//, "");

  const comments = gatherComments(fullName, childDir, pr);
  if (comments.length === 0) {
    console.log(`  · ${fullName} PR#${pr}: no @sunday comments to address`);
    return;
  }

  // Freshen the branch so the sandbox works on the PR's current head (base ref is
  // ignored — the branch already exists — but diffing needs it current too).
  sh("git", ["fetch", "origin", branch], childDir);

  const promptFile = resolve(
    parentRoot, ".scratch", `prompt-pr-${fullName.replaceAll("/", "-")}-${pr}.md`,
  );
  writeFileSync(promptFile, composePrompt(fullName, pr, issue, base, comments), "utf8");

  console.log(
    `▶ ${fullName} PR#${pr} → ${branch}: ${comments.length} @sunday comment(s) (model ${model}, image ${cfg.imageName})`,
  );
  const result = await run({
    agent: claudeCode(model),
    sandbox: docker({ imageName: cfg.imageName }),
    cwd: childDir,
    promptFile,
    branchStrategy: { type: "branch", branch, baseBranch: base },
    logging: { type: "stdout" },
    output: Output.object({ tag: SIGNAL_TAG, schema: prResultSchema, maxRetries: 1 }),
  });

  const { committed, summary, replies } = result.output;
  if (committed) {
    sh("git", ["push", "origin", branch], childDir);
  }

  const byId = new Map(comments.map((c) => [c.id, c]));
  for (const r of replies) {
    const c = byId.get(r.comment);
    if (!c) {
      console.log(`  · ${fullName} PR#${pr}: reply to unknown comment ${r.comment} — skipped`);
      continue;
    }
    postReply(fullName, childDir, pr, c, r.body);
  }
  console.log(
    `💬 ${fullName} PR#${pr}: ${committed ? "pushed + " : ""}replied to ${replies.length} comment(s) — ${summary}`,
  );
}
