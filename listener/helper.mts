// listener/helper.mts — shared plumbing for the TS host (M1 wrapper, M2
// listener): shelling out, the comment marker, and comment routing.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import type { RepoConfig } from "#config/repos.mts";
import { getIssue } from "./state.mts";

const parentRoot = resolve(import.meta.dirname, "..");

// Run a command, return its trimmed stdout, throw on non-zero exit. stderr
// streams live so git/gh errors surface. Pass `cwd` to resolve the command
// against a specific repo (e.g. a child under repos/); omit it for the
// process's own working directory.
export function sh(file: string, args: string[], cwd?: string): string {
  return execFileSync(file, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

// Hidden marker on every comment WE post, so comment routing can tell our own
// comment from a human's (both are authored by the same account, so the login
// can't distinguish them). Machine-only — invisible when rendered.
export const SUNDAY_MARKER = "<!-- sunday:gate -->";

// The summon keyword. A human writes it to hand work to Sunday; case-insensitive,
// `\b` so `@sundays` doesn't match. (Our own comments carry the marker, not
// `@sunday`, so this never matches them — but the marker check runs first.)
const SUNDAY_MENTION = /@sunday\b/i;

/** A human summoning Sunday: mentions @sunday and isn't one of our own comments
 *  (marker). Used for inline review comments, which route outside handleComment. */
export function isSummon(body: string): boolean {
  return !body.includes(SUNDAY_MARKER) && SUNDAY_MENTION.test(body);
}

/** Local `feat/*` branches in the child checkout (the branches Sandcastle's branch
 *  strategy leaves behind). Used by the terminal-PR cleanup + reconcile sweep. */
export function localFeatBranches(childDir: string): string[] {
  const out = sh("git", ["branch", "--format=%(refname:short)", "--list", "feat/*"], childDir);
  return out ? out.split("\n") : [];
}

/** Delete a local branch once it's no longer the only copy of its commits (a
 *  terminal PR means origin has the history). Best-effort: a branch checked out in
 *  a worktree, or already gone, just logs. Never touches origin. */
export function deleteLocalBranch(childDir: string, branch: string): void {
  try {
    if (!sh("git", ["branch", "--list", branch], childDir)) return; // already gone
    sh("git", ["branch", "-D", branch], childDir);
    console.log(`  🧹 deleted local ${branch}`);
  } catch (err) {
    console.log(`  · could not delete local ${branch}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Route a created comment. Our own comments (marker) are skipped. On a PR, an
 *  @sunday mention drives the PR-comment fix flow (`summonPr`, keyed by PR
 *  number). On an issue, a gate resume (any reply on an `awaiting-human` issue)
 *  takes precedence; otherwise an @sunday mention summons a run. `resume` and
 *  `summonPr` enqueue work — the scheduler lives in the listener, so both are
 *  injected. */
export function handleComment(opts: {
  fullName: string;
  cfg: RepoConfig;
  issue: string;
  body: string;
  labels: string[];
  onPr: boolean;
  resume: (sessionId: string, reply: string) => void;
  summonPr: (prNumber: string) => void;
}): void {
  const { fullName, cfg, issue, body, labels, onPr, resume, summonPr } = opts;
  const key = `${fullName}#${issue}`;
  if (body.includes(SUNDAY_MARKER)) return; // our own comment

  if (onPr) {
    if (SUNDAY_MENTION.test(body)) summonPr(issue); // `issue` is the PR number here
    return;
  }

  const prior = getIssue(key);
  if (prior?.status === "awaiting-human") {
    if (!prior.sessionId) {
      console.log(`  · skip ${key} — awaiting-human but no session to resume`);
      return;
    }
    console.log(`  ✓ RESUME ${key}`);
    resume(prior.sessionId, body);
  } else if (SUNDAY_MENTION.test(body)) {
    summon(fullName, cfg, issue, labels);
  }
}

/** @sunday summon (option 1): apply any missing trigger labels; the resulting
 *  `labeled` event runs the normal admission path. Labels stay the source of
 *  truth — @sunday is just a shortcut to applying them. Exported so reconcile can
 *  replay a summon missed while the listener was down. */
export function summon(fullName: string, cfg: RepoConfig, issue: string, labels: string[]): void {
  const key = `${fullName}#${issue}`;
  const missing = cfg.triggerLabels.filter((label) => !labels.includes(label));
  if (missing.length === 0) {
    console.log(`  · ${key} — @sunday but trigger labels already present`);
    return;
  }
  sh("gh", ["issue", "edit", issue, "--add-label", missing.join(",")], resolve(parentRoot, cfg.path));
  console.log(`  ✓ SUMMON ${key} — applied [${missing.join(", ")}]`);
}
