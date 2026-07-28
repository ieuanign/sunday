// assignor/dag.mts — what an issue's BLOCKERS mean for admission: start it on `main`,
// stack it on its blocker's branch, or hold it back until the answer changes.

import type { Blocker, GitHub } from "#services/github/index.mts";

/** The branch an unblocked issue bases on, and the base its PR targets. */
const MAIN = "main";

/** Admission's answer for one issue: the branch it bases on, or why it waits.
 *
 *  `unreadable` separates the two ways of waiting, and they are not the same incident:
 *  a blocker that has not landed yet is the mechanism working, while a read Sunday
 *  could not perform is somebody's service being down — admission says the second one
 *  out loud (constraint 5). Both resolve toward WAITING (constraint 16): admitting an
 *  issue whose blockers are unknown starts a real agent run on a wrong base. */
export type BaseDecision = { admit: true; base: string } | { admit: false; reason: string; unreadable?: true };

/** The base-selection table, ported from v1's `listener/dag.mts` unchanged. Async only
 *  because the open-PR probe is — nothing here reaches the world itself. */
export async function decideBase(
  blockers: Blocker[],
  hasOpenPr: (blocker: number) => Promise<boolean>,
): Promise<BaseDecision> {
  const open = blockers.filter((blocker) => blocker.state !== "closed");
  if (open.length === 0) return { admit: true, base: MAIN };
  // More than one open blocker cannot be stacked on: a branch has ONE base, and picking
  // either of them would ship the other's work unreviewed. They all have to land first.
  if (open.length > 1) return { admit: false, reason: `blockers still open: ${open.map((b) => `#${b.number}`).join(", ")}` };
  const only = open[0].number;
  // The PR is the gate, not the branch: a blocker nobody has pushed for yet has nothing
  // worth forking from, and a fork from `main` wearing its name would be a lie.
  return (await hasOpenPr(only))
    ? { admit: true, base: `feat/${only}` }
    : { admit: false, reason: `blocker #${only} has no open PR yet` };
}

/** Issue refs as a body actually carries them: `#N`, and the URL GitHub leaves behind
 *  when a link is pasted (v1 recognised only the first, so a section written the second
 *  way matched nothing — `listener/dag.mts:57`). The `owner/repo#N` shorthand is matched
 *  TOO, and deliberately: not to resolve it, but so its number is never mistaken for
 *  this repo's (constraint 7). */
const REF = /https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)|([\w.-]+\/[\w.-]+)?#(\d+)/g;

/** The issue numbers a `## Blocked by` section names, or `undefined` when it names
 *  something this repo cannot resolve — which is a read that did not happen, not a zero.
 *
 *  HEADING-SCOPED, which is the whole rule: bodies in this tracker carry prose containing
 *  "blocked by" (#31, #40), and a looser match would read a sentence as a dependency and
 *  hold real work back forever. No heading at all is a genuine zero. PURE. */
function parseBlockedBy(body: string, repo: string): number[] | undefined {
  const section = body.split(/^##\s+/m).find((part) => /^blocked by/i.test(part));
  if (!section) return [];
  const numbers = new Set<number>();
  for (const [, urlRepo, urlNumber, refRepo, refNumber] of section.matchAll(REF)) {
    // A cross-repo ref's number names a DIFFERENT issue in this repo, so resolving it
    // would be a wrong answer rather than an error.
    if ((urlRepo ?? refRepo) !== undefined && (urlRepo ?? refRepo) !== repo) return undefined;
    numbers.add(Number(urlNumber ?? refNumber));
  }
  // A heading naming nothing this repo can resolve is a section written some way Sunday
  // does not read — the same unknown as a failed request, and it waits for the same reason.
  return numbers.size > 0 ? [...numbers] : undefined;
}

/** Everything that blocks `issue`: GitHub's native dependency links, and the body
 *  fallback for a repo that has none. An EMPTY native result is a real answer — this
 *  repo populates no links — which is why the fallback gets its turn there and never
 *  after a read that THREW (constraint 3).
 *
 *  Exported for the restack's dependent scan (#43), which asks the same question in the
 *  other direction — "does this open PR's issue name the one that just merged?" — and
 *  must inherit the THROW: a read that failed is not "not a dependent". */
export async function readBlockers(github: GitHub, repo: string, issue: number): Promise<Blocker[]> {
  const native = await github.blockedBy(repo, issue);
  if (native.length > 0) return native;
  const refs = parseBlockedBy((await github.readIssue(repo, issue)).body, repo);
  // Thrown rather than returned: an unresolvable section is one more read Sunday could
  // not perform, and `resolveBase` already turns every one of those into the same wait.
  if (!refs) throw new Error("a `## Blocked by` section names nothing resolvable in this repo");
  // The body says WHICH issues, never whether they landed — that is one read each.
  return await Promise.all(refs.map(async (number) => ({ number, state: await github.issueState(repo, number) })));
}

/** Decide admission and base from what GitHub says blocks `issue`.
 *
 *  ONE `try` around the lot, and it is the point of this whole module: every read here
 *  — the native links, the fallback's body, the stacking probe — answers a question
 *  whose only safe unknown is "wait". v1 caught the native read alone and fell through
 *  to the body on a 502 (`listener/dag.mts:45`), which is how a blocked issue reached
 *  `main`. A read that did not happen is not an answer, whichever read it was. */
export async function resolveBase(github: GitHub, repo: string, issue: number): Promise<BaseDecision> {
  try {
    const blockers = await readBlockers(github, repo, issue);
    return await decideBase(blockers, async (blocker) => (await github.openPrForHead(repo, `feat/${blocker}`)) !== undefined);
  } catch (err) {
    return { admit: false, unreadable: true, reason: `blockers unreadable — ${err instanceof Error ? err.message : String(err)}` };
  }
}
