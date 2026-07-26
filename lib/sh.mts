// lib/sh.mts — shelling out. Ported from v1 (`listener/helper.mts`) rather than
// imported: v1 and V2 must not cross-import until cutover deletes v1.
//
// Changed from v1 deliberately: the stderr write-through is GONE — it was itself a bare
// console write, and the stderr still travels on the thrown error, which is what the
// classifier actually reads.

import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";

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

const execFileAsync = promisify(execFile);

/** Async twin of `sh`, same contract — trimmed stdout, throws on a non-zero exit — but
 *  the subprocess runs OFF the event loop. Boot's reconcile issues hundreds of `gh`
 *  reads, and doing that synchronously froze v1's loop for the whole sweep: the
 *  readiness probe went unanswered and the supervisor SIGKILL/restart-looped the parent
 *  (ADR-0001). Every read on the parent's own path uses this one.
 *
 *  The rejection is re-thrown as `cmdError` off the STDERR ALONE and never off the
 *  rejection's own message: `execFile` puts the full argv in that message ("Command
 *  failed: gh pr create --body …"), which is precisely the leak `cmdError` exists to
 *  prevent. A silent failure therefore reads "(no stderr)" rather than naming the argv. */
export async function shA(file: string, args: string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(file, args, { cwd, encoding: "utf8" });
    return stdout.trim();
  } catch (err) {
    throw cmdError(file, args, (err as { stderr?: string }).stderr ?? "");
  }
}
