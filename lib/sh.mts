// lib/sh.mts — shelling out. Ported from v1 (`listener/helper.mts`) rather than
// imported: v1 and V2 must not cross-import until cutover deletes v1.
//
// Changed from v1 deliberately: the stderr write-through is GONE — it was itself a bare
// console write, and the stderr still travels on the thrown error, which is what the
// classifier actually reads.

import { spawnSync } from "node:child_process";

/** The error a shelled-out command throws: the command's own stderr, prefixed by a
 *  SHORT label — deliberately NOT the full argv. The classifier regex-matches this
 *  message and our argv carries agent-authored prose (`gh pr create --title/--body …`);
 *  a real PR body saying "credential-free sandbox" matched the auth rule and got a
 *  failed create classified as a P1 auth halt on the agent's own wording. */
function cmdError(file: string, args: string[], stderr: string): Error {
  // Keep only the leading positional args (the subcommand path), capped: agent prose is
  // always a FLAG VALUE (`--title …`, `--body …`), so stopping at the first flag can
  // never include it.
  const firstFlag = args.findIndex((a) => a.startsWith("-"));
  const label = [file, ...args.slice(0, firstFlag === -1 ? 3 : Math.min(firstFlag, 3))].join(" ");
  const detail = stderr.trim();
  return new Error(detail ? `${label} failed: ${detail}` : `${label} failed (no stderr)`);
}

/** Run a command, return its trimmed stdout, throw on a non-zero exit. stderr is
 *  captured onto the thrown error. Pass `cwd` to resolve against a specific repo. */
export function sh(file: string, args: string[], cwd?: string): string {
  const r = spawnSync(file, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (r.error) throw r.error;
  if (r.status !== 0) throw cmdError(file, args, r.stderr ?? "");
  return (r.stdout ?? "").trim();
}
