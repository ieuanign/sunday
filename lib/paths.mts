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
