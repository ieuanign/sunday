// listener/run-issue.mts — the shared per-issue action (M2, step 3).
//
// The ONE place M1's compose → run → push → PR lives. Both the one-shot CLI
// (run-one.mts) and the listener call this — they must not drift. The sandbox
// DECIDES (plan → test → implement → commit); this host does ALL I/O.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { run, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

import { sh } from "./helper.mts";
import type { RepoConfig } from "#config/repos.mts";

const parentRoot = resolve(import.meta.dirname, "..");

export interface RunOutcome {
  committed: boolean;
  branch: string;
  prUrl?: string;
  sessionId?: string;
}

/**
 * Run one issue end to end for a configured repo: compose the prompt, run the
 * sandbox, and — only if the agent committed — push the branch and open the PR.
 * The sandbox is credential-free, so every GitHub side effect happens here.
 * Throws on a missing MODEL or any git/gh failure; the caller decides recovery.
 */
export async function runIssue(
  fullName: string,
  cfg: RepoConfig,
  issue: string,
): Promise<RunOutcome> {
  const model = process.env.MODEL;
  if (!model) {
    throw new Error("MODEL is unset — load .env first (node --env-file=.env …).");
  }

  const childDir = resolve(parentRoot, cfg.path);
  const baselinePath = resolve(parentRoot, cfg.promptFile);
  const promptFile = resolve(
    parentRoot,
    ".scratch",
    `prompt-${fullName.replaceAll("/", "-")}-${issue}.md`,
  );
  const branch = `feat/${issue}`;

  // 1. compose the prompt — the issue IS the spec (gh runs in the child, so it
  //    auto-detects the repo from origin).
  const { title, body } = JSON.parse(
    sh("gh", ["issue", "view", issue, "--json", "title,body"], childDir),
  ) as { title: string; body: string };

  const prompt =
    readFileSync(baselinePath, "utf8")
      .replaceAll("{{REPO}}", fullName)
      .replaceAll("{{ISSUE}}", issue) +
    `\n\n---\n\n# Issue #${issue}: ${title}\n\n${body}\n`;
  writeFileSync(promptFile, prompt, "utf8");

  // 2. delegate to the sandbox (it decides; it has no credentials).
  console.log(
    `▶ ${fullName}#${issue} → ${branch}  (model ${model}, image ${cfg.imageName})`,
  );
  const result = await run({
    agent: claudeCode(model),
    sandbox: docker({ imageName: cfg.imageName }),
    cwd: childDir,
    promptFile,
    branchStrategy: { type: "branch", branch, baseBranch: "main" },
    logging: { type: "stdout" },
  });

  // 3. the host tail — ALL I/O lives here ("commits ⇒ ship").
  const sessionId = result.iterations.at(-1)?.sessionId;
  if (result.commits.length === 0) {
    console.log(
      `✋ ${fullName}#${issue}: no commits (agent produced nothing or opened a gate).`,
    );
    return { committed: false, branch, sessionId };
  }

  sh("git", ["push", "origin", branch], childDir);
  const prUrl = sh(
    "gh",
    [
      "pr", "create", "--base", "main", "--head", branch,
      "--title", title,
      "--body",
      `Automated implementation of #${issue} via Sunday.\n\n` +
        `${result.commits.length} commit(s) on \`${branch}\`.\n\nCloses #${issue}.`,
    ],
    childDir,
  );
  console.log(
    `✅ ${fullName}#${issue}: pushed ${result.commits.length} commit(s); PR ${prUrl}`,
  );
  return { committed: true, branch, prUrl, sessionId };
}
