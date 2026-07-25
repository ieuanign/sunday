// lib/lock.mts — the PID lock a forked work item holds while it lives. It is the guard
// the in-memory queue cannot be: children deliberately outlive the parent (hot-reload,
// crash, deploy), so a parent that comes back up asks this file — not its own memory —
// whether someone is still working an item. ADR-0001.
// Every function takes the path it works on: a smoke points a real child at a temp dir
// instead of the real `var/running/`.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Who holds a lock, and whether that process is still there. */
export interface Lock {
  pid: number;
  alive: boolean;
}

/** Take the lock at `path`. `pid` defaults to this process — a child locks its own item
 *  — and is injectable so a caller can record a lock on another process's behalf.
 *  Makes its own directory: `lib/paths.mts` only names paths. */
export function acquireLock(path: string, pid: number = process.pid): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${pid}\n`, "utf8");
  renameSync(tmp, path);
}

/** Who holds the lock at `path`, or `undefined` when nobody does — which includes a file
 *  that names no process at all. Such a file proves nothing and must not read as a live
 *  holder, or the work item is wedged for good; `0` in particular is a number but
 *  signals the whole process group rather than one child. */
export function readLock(path: string): Lock | undefined {
  if (!existsSync(path)) return undefined;
  const pid = Number(readFileSync(path, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  return { pid, alive: isAlive(pid) };
}

/** Drop the lock at `path`. Idempotent: the child releases as it exits and the parent
 *  clears it again while applying the outcome (a child outlives its parent, so neither
 *  can assume it went first). */
export function releaseLock(path: string): void {
  rmSync(path, { force: true });
}

/** Signal 0 checks for a process without touching it. Only `ESRCH` — no such process —
 *  means the holder is gone; `EPERM` means it is there and owned by someone else, and
 *  reading that as gone would start a second agent on an item someone is still running. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
