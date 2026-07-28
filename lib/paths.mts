// lib/paths.mts — the one place that names Sunday's durable `var/` layout, so no
// consumer invents its own spelling of a path. PURE: every export NAMES a path and
// creates nothing; whoever writes creates its own directory. (v1's runLogPath
// mkdirSync'd as a side effect, which made every consumer of it non-hermetic.)

import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");

/** Durable runtime state: survives restarts, never source, gitignored (`/var/`).
 *  Distinct from `.scratch/`, which is throwaway and gets rm -rf'd — v1 kept its
 *  save-data (state.json, pause.json) there. */
export const varDir = resolve(repoRoot, "var");

/** Per-work-item state — the save data. */
export const statePath = resolve(varDir, "state.json");

/** Pipeline pause state; absence of the file means "not paused". */
export const pausePath = resolve(varDir, "pause.json");

/** Where a forked work-item process drops its result for the parent to pick up,
 *  so a parent restart mid-run loses nothing (ADR-0001). */
export const resultsDir = resolve(varDir, "results");

/** PID locks held by live work-item processes — the parent sweeps these on boot. */
export const runningDir = resolve(varDir, "running");

/** Everything Sunday writes about what it did. */
export const logDir = resolve(varDir, "log");

/** Append-only JSONL event log: the durable record of milestones, alerts and errors. */
export const eventLogPath = resolve(logDir, "events.jsonl");

/** Where run-log lines land when there is no work item to attribute them to (boot,
 *  services, the assignor), so no line is durable-nowhere. */
export const fallbackLogPath = resolve(logDir, "sunday.log");

/** A work-item key (`<owner>/<repo>#<issue>`, `<owner>/<repo>#pr<n>`) as one path
 *  segment: everything outside `[A-Za-z0-9._-]` becomes `-`, so the key's `/` and `#`
 *  can never nest a file or walk out of its directory. */
function slug(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, "-");
}

/** Where a work item's forked process writes its result, named by work-item key. */
export function resultPath(key: string): string {
  return resolve(resultsDir, `${slug(key)}.json`);
}

/** The PID lock a running work item holds, named by work-item key. */
export function pidPath(key: string): string {
  return resolve(runningDir, `${slug(key)}.pid`);
}

/** One work item's run log: `var/log/<owner>/<repo>/<flow>/run.log`, where `flow` is
 *  the issue number for an issue run or `pr-<n>` for a PR-comment run. Concurrent
 *  runs each get their own file instead of interleaving on a shared stream. */
export function runLogPath(fullName: string, flow: string): string {
  return resolve(logDir, fullName, flow, "run.log");
}

/** The ephemeral detached worktree one branch's restack rebases in (#43). Under `var/`
 *  and NEVER inside the child checkout: v1 put it there, where an untracked directory
 *  dirties a concurrent run's worktree and gets it preserved host-side (#21). One path
 *  per repo+branch, which the scheduler's per-branch lock already keeps to one live
 *  restack at a time. */
export function restackWorktreePath(repo: string, branch: string): string {
  return resolve(varDir, "restack", slug(`${repo}#${branch}`));
}

/** The handoff note a retiring session leaves the fresh one (#67). ONE per work item — a
 *  second handoff overwrites the first, and both texts are in the run log. Under `var/`,
 *  never `.scratch/`, which CLAUDE.md §6 documents as `rm -rf`-able (v1 kept notes there). */
export function handoffNotePath(key: string): string {
  return resolve(varDir, "handoff", `${slug(key)}.md`);
}

/** Where one repo's token reports accumulate: `var/log/<owner>/<repo>/token-report/`,
 *  beside that repo's run logs. Durable, not throwaway — v1 kept them in `.scratch/`,
 *  which CLAUDE.md documents as `rm -rf`-able, so the spend history of every run so far
 *  died with the next clean-up. */
export function tokenReportDir(fullName: string): string {
  return resolve(logDir, fullName, "token-report");
}
