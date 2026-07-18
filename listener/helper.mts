// listener/helper.mts — shared plumbing for the TS host (M1 wrapper, M2 listener).

import { execFileSync } from "node:child_process";

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
