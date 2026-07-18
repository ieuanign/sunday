// listener/run-one.mts — Sunday's one-shot wrapper (M1, hand-invoked).
//
//   node --env-file=.env listener/run-one.mts <repo> <issue#>
//
// The sandbox DECIDES (plan → test → implement → commit locally); this TS host
// does ALL I/O (compose the prompt, push the branch, open the PR). See Lesson 09.
//
// Fully generic — nothing child-specific is hardcoded; `<repo>` drives every
// path, the image name, and (via cwd) which origin gh/git act on.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { run, claudeCode } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

import { sh } from "./helper.mts";

// ── args ────────────────────────────────────────────────────────────────
const [repo, issue] = process.argv.slice(2);
if (!repo || !issue) {
  console.error(
    "usage: node --env-file=.env listener/run-one.mts <repo> <issue#>",
  );
  process.exit(1);
}

const model = process.env.MODEL;
if (!model) {
  console.error(
    "MODEL is unset — run with `node --env-file=.env` so the parent .env loads.",
  );
  process.exit(1);
}

// ── paths — all ABSOLUTE (promptFile resolves vs process.cwd(), not cwd) ──
const parentRoot = resolve(import.meta.dirname, "..");
const childDir = resolve(parentRoot, "repos", repo);
const baselinePath = resolve(parentRoot, "docs", "sandbox-prompt.md");
const promptFile = resolve(
  parentRoot,
  ".scratch",
  `prompt-${repo}-${issue}.md`,
);
const branch = `feat/${issue}`;
const imageName = `${repo}-sandbox:latest`;

// ── the baseline discipline the composed prompt builds on ─────────────────
const baseline = readFileSync(baselinePath, "utf8");

// ── 1. compose the prompt (host reads; the issue IS the spec) ─────────────
// gh runs in the child, so it auto-detects the repo from its origin (the
// routing schema that would map <repo> → owner/repo is M2).
const { title, body } = JSON.parse(
  sh("gh", ["issue", "view", issue, "--json", "title,body"], childDir),
) as { title: string; body: string };

const prompt =
  baseline.replaceAll("{{REPO}}", repo).replaceAll("{{ISSUE}}", issue) +
  `\n\n---\n\n# Issue #${issue}: ${title}\n\n${body}\n`;

writeFileSync(promptFile, prompt, "utf8");

// ── 2. delegate to the sandbox (it decides; it has no credentials) ────────
console.log(
  `▶ ${repo}#${issue} → ${branch}  (model ${model}, image ${imageName})`,
);

const result = await run({
  agent: claudeCode(model),
  sandbox: docker({ imageName }),
  cwd: childDir,
  promptFile,
  branchStrategy: { type: "branch", branch, baseBranch: "main" },
  logging: { type: "stdout" },
});

// ── 3. the host tail — ALL I/O lives here ("commits ⇒ ship") ──────────────
if (result.commits.length === 0) {
  console.log(
    `✋ No commits on ${branch} — the agent produced nothing or opened a gate. Nothing to ship.`,
  );
  process.exit(0);
}

sh("git", ["push", "origin", branch], childDir);

const prUrl = sh(
  "gh",
  [
    "pr",
    "create",
    "--base",
    "main",
    "--head",
    branch,
    "--title",
    title,
    "--body",
    `Automated implementation of #${issue} via Sunday (M1 hand-run).\n\n` +
      `${result.commits.length} commit(s) on \`${branch}\`.\n\nCloses #${issue}.`,
  ],
  childDir,
);

console.log(`✅ Pushed ${result.commits.length} commit(s); opened PR: ${prUrl}`);
