// listener/helper.mts — shared plumbing for the TS host (M1 wrapper, M2
// listener): shelling out, the comment marker, and comment routing.

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

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

// Human-visible attribution. Same account posts for both Sunday and the human, so
// the hidden SUNDAY_MARKER (for the listener) is paired with this line (for people
// reading the thread) — you can tell at a glance who authored a comment/PR.
export const SUNDAY_SIGN = "🤖 **Sunday** · autonomous agent";

/** Compose a comment WE author: hidden marker (top) + visible attribution + the
 *  content. Every comment Sunday posts goes through here — the issue gate, PR
 *  replies, operability notices — so all carry the same dual sign. Lives here (a
 *  leaf) so every module can share it without an import cycle. */
export function sundayComment(body: string): string {
  return `${SUNDAY_MARKER}\n${SUNDAY_SIGN}\n\n${body}`;
}

// The summon keyword. A human writes it to hand work to Sunday; case-insensitive,
// `\b` so `@sundays` doesn't match. (Our own comments carry the marker, not
// `@sunday`, so this never matches them — but the marker check runs first.)
const SUNDAY_MENTION = /@sunday\b/i;

// A `spec` issue is a manifest (the shape of a feature), never a unit of work —
// its child tickets are what get implemented. Admission always skips it; when it
// also carries the trigger labels (a human mis-labelled the manifest for the
// agent) we nudge once. Separate marker so the nudge is idempotent independent of
// the gate marker.
export const SPEC_LABEL = "spec";
const SUNDAY_SPEC_MARKER = "<!-- sunday:spec-nudge -->";

/** A human summoning Sunday: mentions @sunday and isn't one of our own comments
 *  (marker). Used for inline review comments, which route outside handleComment. */
export function isSummon(body: string): boolean {
  return !body.includes(SUNDAY_MARKER) && SUNDAY_MENTION.test(body);
}

/** Per-flow run-log path: `.scratch/<repo>/<flow>/run.log` (flow = the issue number
 *  for an issue run, or `pr-<n>` for a PR-comment run). Ensures the directory
 *  exists and returns the absolute path. One place so both run paths write the same
 *  layout — no drift. Sandcastle streams the agent's full output here
 *  (`logging:{type:"file"}`) instead of the shared stdout, so concurrent runs no
 *  longer interleave; the listener stdout stays a terse one-line-per-event summary.
 *  Under gitignored `.scratch/`. */
export function runLogPath(fullName: string, flow: string): string {
  const dir = resolve(parentRoot, ".scratch", fullName, flow);
  mkdirSync(dir, { recursive: true });
  return resolve(dir, "run.log");
}

/** The tag the handoff turn emits its note inside (M5.2). One place, shared by the
 *  instructions builder and run-issue's Output.string extractor. */
export const HANDOFF_TAG = "sunday-handoff";

/** The bounded handoff-turn prompt: the real `/handoff` skill's OWN instructions,
 *  read at runtime with the frontmatter stripped and its "save to OS temp" line
 *  swapped for "emit as tagged output" — identical summary quality, no box-file
 *  problem, no dependence on skill-invocation in headless (M5.2 D3). */
export function handoffInstructions(): string {
  const skill = readFileSync(resolve(parentRoot, ".claude/skills/handoff/SKILL.md"), "utf8");
  const body = skill.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
  const adapted = body.replace(
    /Save to the temporary directory of the user's OS[^\n]*/i,
    `Do NOT write any file — you are in a credential-free sandbox. Emit the entire handoff document inside a single \`<${HANDOFF_TAG}>…</${HANDOFF_TAG}>\` tag.`,
  );
  return (
    `You are compacting THIS session into a handoff document for a fresh agent that will ` +
    `continue and finish the work. Do only this — write no code, touch no files, make no commits.\n\n` +
    `${adapted}\n\n` +
    `Emit the document as your only output, inside one \`<${HANDOFF_TAG}>…</${HANDOFF_TAG}>\` tag.`
  );
}

/** Paths the pipeline/floor writes INTO a child's sandbox worktree that must not
 *  dirty its git status — chiefly `.scratch/`, where the injected floor sub-agents
 *  (e.g. architecture-engineer) drop their plan docs (cwd-relative inside the box).
 *  A dirty worktree makes Sandcastle preserve it, which then blocks branch cleanup. */
const SANDBOX_WORKTREE_IGNORES = [".scratch/"];

/** Keep pipeline/floor scratch out of a child's worktree `git status`, idempotently,
 *  via the child clone's LOCAL `.git/info/exclude` — per-clone, **never committed**
 *  (so it never leaks into a PR and never touches the child's own tracked `.gitignore`),
 *  and shared across all of the clone's worktrees. Runs before every run (self-heals
 *  children onboarded before this existed) and at `repo:init`. Best-effort. */
export function ensureSandboxIgnores(childDir: string): void {
  const excludePath = resolve(childDir, ".git", "info", "exclude");
  let current = "";
  try {
    current = readFileSync(excludePath, "utf8");
  } catch {
    /* fresh clone / no exclude yet */
  }
  const have = new Set(current.split("\n").map((l) => l.trim()));
  const missing = SANDBOX_WORKTREE_IGNORES.filter((ig) => !have.has(ig));
  if (missing.length === 0) return;
  try {
    mkdirSync(dirname(excludePath), { recursive: true });
    const lead = current && !current.endsWith("\n") ? "\n" : "";
    appendFileSync(excludePath, `${lead}# Sunday: keep pipeline/floor scratch out of the worktree\n${missing.join("\n")}\n`);
  } catch (err) {
    console.log(`  · could not update ${childDir}/.git/info/exclude: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Per-issue handoff doc path `.scratch/<repo>/handoff/<issue>-<n>.md` (M5.2). Ensures
 *  the dir exists. */
export function handoffDocPath(fullName: string, issue: string, seq: number): string {
  const dir = resolve(parentRoot, ".scratch", fullName, "handoff");
  mkdirSync(dir, { recursive: true });
  return resolve(dir, `${issue}-${seq}.md`);
}

/** Drop an issue's spent handoff docs (`<issue>-*.md`) once the run reaches its
 *  terminal push — the retired sessions' notes are done (M5.2 D6). Best-effort. */
export function cleanupHandoffs(fullName: string, issue: string): void {
  const dir = resolve(parentRoot, ".scratch", fullName, "handoff");
  try {
    for (const f of readdirSync(dir)) {
      if (f.startsWith(`${issue}-`) && f.endsWith(".md")) rmSync(resolve(dir, f), { force: true });
    }
  } catch {
    /* no handoff dir — nothing to clean */
  }
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

/** A spec issue that ALSO carries all trigger labels — i.e. a manifest a human
 *  labelled for the agent by mistake. Pure so both admission paths (live + reconcile)
 *  decide identically and a smoke can drive it. A bare spec (no triggers) isn't
 *  "activated" and is left alone — nudging every backlog spec on each boot would spam. */
export function isActivatedSpec(labels: string[], triggerLabels: string[]): boolean {
  return labels.includes(SPEC_LABEL) && triggerLabels.every((l) => labels.includes(l));
}

/** Post the one-line "label the child tickets" nudge on an activated spec, once.
 *  Idempotent via a hidden marker (re-checked cheaply, posted at most once per
 *  issue). No-op unless the issue is an activated spec. Called from BOTH the live
 *  admission skip and reconcile's issue scan — one helper so they can't drift.
 *  admitIssue already rejects the spec, so this only handles the human-facing nudge. */
export function nudgeSpecIfActivated(
  fullName: string,
  cfg: RepoConfig,
  issue: string,
  labels: string[],
  childDir: string,
): void {
  if (!isActivatedSpec(labels, cfg.triggerLabels)) return;
  const bodies = JSON.parse(
    sh("gh", ["api", `repos/${fullName}/issues/${issue}/comments`, "--jq", "[.[] | .body]"], childDir),
  ) as string[];
  if (bodies.some((b) => b.includes(SUNDAY_SPEC_MARKER))) return; // already nudged
  const tickets = cfg.triggerLabels.map((l) => `\`${l}\``).join(" + ");
  sh(
    "gh",
    [
      "issue", "comment", issue, "--body",
      `${SUNDAY_SPEC_MARKER}\n🤖 **Sunday** — this looks like a spec (a manifest, not a unit of work), ` +
        `so I won't implement it directly. Label the individual child tickets ${tickets} instead.`,
    ],
    childDir,
  );
  console.log(`  ✎ nudged spec ${fullName}#${issue} — label the child tickets`);
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
