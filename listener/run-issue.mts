// listener/run-issue.mts — the shared per-issue action (M2, steps 3 + 5).
//
// The ONE place M1's compose → run → decide lives. Both the one-shot CLI
// (run-one.mts) and the listener call this — they must not drift. The sandbox
// DECIDES (plan → test → implement → commit → emit a signal); this host does
// ALL I/O (push, PR, comment, label) from that signal.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { run, claudeCode, Output } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { z } from "zod";

import { sh, SUNDAY_MARKER } from "./helper.mts";
import type { RepoConfig } from "#config/repos.mts";

const parentRoot = resolve(import.meta.dirname, "..");

// The agent emits exactly one of these as its last output (see sandbox-prompt.md
// §4). Sandcastle extracts it from stdout by the `<sunday-result>` tag literal,
// JSON-parses it, and validates it against this schema before returning.
const SIGNAL_TAG = "sunday-result";
const resultSchema = z.object({
  signal: z.enum(["ready", "draft", "gate", "fail"]),
  summary: z.string(),
  question: z.string().optional(),
});
export type RunSignal = z.infer<typeof resultSchema>["signal"];

// Human-visible attribution. Same account posts for both Sunday and the human,
// so the hidden SUNDAY_MARKER (for the listener, from helper.mts) is paired with
// this line (for people reading the thread) — you can tell at a glance who
// authored a comment/PR.
export const SUNDAY_SIGN = "🤖 **Sunday** · autonomous agent";

/** Compose a comment WE author: hidden marker (top) + visible attribution + the
 *  content. Every comment Sunday posts goes through here — the issue gate today,
 *  PR comments once that path exists — so both carry the same dual sign. */
export function sundayComment(body: string): string {
  return `${SUNDAY_MARKER}\n${SUNDAY_SIGN}\n\n${body}`;
}

// Appended to a resume prompt: the human reply carries no tag, but Output.object
// requires the tag literal in the resolved prompt, and the agent needs reminding
// to finish the same way.
const RESUME_REMINDER =
  `\n\n---\n\nWhen you have addressed this, finish exactly as before: emit one ` +
  `\`<${SIGNAL_TAG}>{ "signal": …, "summary": …, "question": … }</${SIGNAL_TAG}>\` result.`;

export interface RunOutcome {
  signal: RunSignal;
  branch: string;
  /** Present when a PR was opened (ready/draft/fail with commits). */
  prUrl?: string;
  /** Present for filesystem-backed sessions — carries the gate/resume handle. */
  sessionId?: string;
  /** The gate question posted to the issue (signal === "gate"). */
  question?: string;
}

export interface RunOpts {
  /** Base for the branch, the ahead-count, and the PR (default "main"). A
   *  stacked ticket bases on its blocker's branch — the knob that turns waves
   *  on (M2 step 6). Inert at the default. */
  baseBranch?: string;
  /** Resume a gated session with a human reply instead of a fresh run. */
  resume?: { sessionId: string; reply: string };
}

/**
 * Run one issue end to end for a configured repo, or resume a gated session with
 * a human reply. Composes/continues the prompt, runs the credential-free
 * sandbox, then acts on the agent's structured signal: ready/draft/fail → push +
 * (draft) PR; gate → post the question + `awaiting-human`, no PR. Throws on a
 * missing MODEL, a malformed result after one retry, or any git/gh failure.
 */
export async function runIssue(
  fullName: string,
  cfg: RepoConfig,
  issue: string,
  opts: RunOpts = {},
): Promise<RunOutcome> {
  const { baseBranch = "main", resume } = opts;
  const model = process.env.MODEL;
  if (!model) {
    throw new Error("MODEL is unset — load .env first (node --env-file=.env …).");
  }

  const childDir = resolve(parentRoot, cfg.path);
  const branch = `feat/${issue}`;

  // Title is needed for the PR (fresh) and for a resume→ready PR (gate never
  // opened one). gh auto-detects the child repo from its origin.
  const { title, body } = JSON.parse(
    sh("gh", ["issue", "view", issue, "--json", "title,body"], childDir),
  ) as { title: string; body: string };

  // Prompt: fresh → baseline (§4 carries the tag literal) + issue; resume → the
  // reply + a reminder that carries the tag literal.
  const promptFile = resolve(
    parentRoot,
    ".scratch",
    `prompt-${fullName.replaceAll("/", "-")}-${issue}.md`,
  );
  if (resume) {
    writeFileSync(promptFile, resume.reply + RESUME_REMINDER, "utf8");
  } else {
    const baseline = readFileSync(resolve(parentRoot, cfg.promptFile), "utf8")
      .replaceAll("{{REPO}}", fullName)
      .replaceAll("{{ISSUE}}", issue);
    writeFileSync(
      promptFile,
      `${baseline}\n\n---\n\n# Issue #${issue}: ${title}\n\n${body}\n`,
      "utf8",
    );
  }

  // Stacking (6b): the base ref must be current locally before Sandcastle
  // branches feat/<issue> off it — baseBranch is consulted only when the target
  // branch is new (findings §3). At the "main" default this is a no-op.
  if (baseBranch !== "main") {
    sh("git", ["fetch", "origin", baseBranch], childDir);
  }

  // Delegate to the sandbox (it decides; it has no credentials). maxRetries:1 —
  // one automatic re-emit if the agent's tag is missing/malformed.
  console.log(
    `▶ ${fullName}#${issue} → ${branch}  (model ${model}, image ${cfg.imageName}` +
      `${resume ? ", resume" : ""})`,
  );
  const result = await run({
    agent: claudeCode(model),
    sandbox: docker({ imageName: cfg.imageName }),
    cwd: childDir,
    promptFile,
    branchStrategy: { type: "branch", branch, baseBranch },
    logging: { type: "stdout" },
    ...(resume ? { resumeSession: resume.sessionId } : {}),
    output: Output.object({ tag: SIGNAL_TAG, schema: resultSchema, maxRetries: 1 }),
  });

  const sessionId = result.iterations.at(-1)?.sessionId;
  const { signal, summary, question } = result.output;

  // Gate: no PR. Post the question (marked, so resume can skip our own comment)
  // and claim the issue for a human. The session lives on for resume.
  if (signal === "gate") {
    const ask = question ?? summary;
    sh("gh", ["issue", "comment", issue, "--body", sundayComment(ask)], childDir);
    sh("gh", ["issue", "edit", issue, "--add-label", "awaiting-human"], childDir);
    console.log(`⛔ ${fullName}#${issue}: gate — asked the human, awaiting-human.`);
    return { signal, branch, sessionId, question: ask };
  }

  // ready/draft/fail all ship a PR — but only if the branch actually has commits
  // ahead of main (robust across a resume, where prior commits sit on the branch
  // and result.commits may be empty for this iteration).
  const ahead = sh("git", ["rev-list", "--count", `${baseBranch}..${branch}`], childDir);
  if (ahead === "0") {
    console.log(`✋ ${fullName}#${issue}: signal ${signal} but no commits — nothing to ship.`);
    return { signal, branch, sessionId };
  }

  sh("git", ["push", "origin", branch], childDir);
  const draft = signal !== "ready";
  const prUrl = sh(
    "gh",
    [
      "pr", "create", "--base", baseBranch, "--head", branch,
      ...(draft ? ["--draft"] : []),
      "--title", title,
      "--body",
      `${signal === "fail" ? summary : `${summary}\n\nCloses #${issue}.`}\n\n---\n${SUNDAY_SIGN} opened this PR.`,
    ],
    childDir,
  );
  if (signal === "fail") {
    sh("gh", ["issue", "edit", issue, "--add-label", "agent-failed"], childDir);
  }
  console.log(
    `${signal === "ready" ? "✅" : "📝"} ${fullName}#${issue}: ${signal} — ${draft ? "draft " : ""}PR ${prUrl}`,
  );
  return { signal, branch, prUrl, sessionId };
}
