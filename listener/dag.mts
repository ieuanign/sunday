// listener/dag.mts — dependency DAG read + base selection (M2, step 6b).
//
// Forward edges only. GitHub's native `.../dependencies/blocked_by` returns each
// blocker WITH its issue state inline (one call); a `## Blocked by` body-text
// section is the fallback for repos that don't populate native links. The
// inverse `.../dependencies/blocks` endpoint 404s, so "who does B block?" is
// never a reverse query — it's a re-check of candidates' forward edges (see the
// deferred set in listen.mts).
//
// Base selection (confirmed 2026-07-18):
//   0 blockers                 → main
//   1 blocker, closed          → main            (it landed)
//   1 blocker, open + open PR   → feat/<blocker>  (stack on its branch)
//   1 blocker, open + no PR     → defer
//   N>1 blockers, all closed    → main
//   N>1 blockers, any open      → defer  (can't stack on >1 base — wait for all)

import { sh } from "./helper.mts";

export interface Blocker {
  number: number;
  /** Lowercased issue state ("open" | "closed") — the REST API and `gh issue
   *  view` disagree on casing, so we normalize here. */
  state: string;
}

export type BaseDecision =
  | { admit: true; baseBranch: string }
  | { admit: false; reason: string };

/** Every ticket blocking `issue`, with each blocker's issue state. Native
 *  dependencies API first; an empty result falls back to `## Blocked by` body
 *  text. */
export function readBlockers(fullName: string, childDir: string, issue: string): Blocker[] {
  let tsv = "";
  try {
    tsv = sh(
      "gh",
      [
        "api", `repos/${fullName}/issues/${issue}/dependencies/blocked_by`,
        "--jq", ".[] | [.number, .state] | @tsv",
      ],
      childDir,
    );
  } catch {
    // native endpoint unsupported on this repo → text fallback
  }
  if (tsv) {
    return tsv.split("\n").map((line) => {
      const [n, state] = line.split("\t");
      return { number: Number(n), state: state.toLowerCase() };
    });
  }
  return readBlockersFromBody(childDir, issue);
}

const ISSUE_REF = /#(\d+)/g;

/** Fallback: `#N` refs under a `## Blocked by` heading, each with its looked-up
 *  state. Used only when the native API yields nothing. */
function readBlockersFromBody(childDir: string, issue: string): Blocker[] {
  const body = sh("gh", ["issue", "view", issue, "--json", "body", "--jq", ".body"], childDir);
  const section = body.split(/^##\s+/m).find((s) => /^blocked by/i.test(s));
  if (!section) return [];
  const nums = [...new Set([...section.matchAll(ISSUE_REF)].map((m) => Number(m[1])))];
  return nums.map((number) => ({
    number,
    state: sh(
      "gh", ["issue", "view", String(number), "--json", "state", "--jq", ".state"], childDir,
    ).toLowerCase(),
  }));
}

/** The pure base-selection decision — no I/O beyond the injected `hasOpenPr`, so
 *  every branch is unit-testable with synthetic blockers. */
export function decideBase(
  blockers: Blocker[],
  hasOpenPr: (blocker: number) => boolean,
): BaseDecision {
  if (blockers.length === 0) return { admit: true, baseBranch: "main" };

  const open = blockers.filter((b) => b.state !== "closed");

  if (blockers.length === 1) {
    const b = blockers[0];
    if (b.state === "closed") return { admit: true, baseBranch: "main" };
    // single open blocker: stack once its (draft) PR is up, else wait
    return hasOpenPr(b.number)
      ? { admit: true, baseBranch: `feat/${b.number}` }
      : { admit: false, reason: `blocker #${b.number} has no open PR yet` };
  }

  // >1 blocker can't be stacked on one base → all must land on main first
  return open.length === 0
    ? { admit: true, baseBranch: "main" }
    : { admit: false, reason: `blockers still open: ${open.map((b) => `#${b.number}`).join(", ")}` };
}

/** Decide admission + base branch from `issue`'s blockers (reads GitHub). */
export function resolveBase(fullName: string, childDir: string, issue: string): BaseDecision {
  const blockers = readBlockers(fullName, childDir, issue);
  return decideBase(blockers, (blocker) => hasOpenPr(childDir, blocker));
}

/** Does the blocker's branch have an open PR? The gate for stacking. */
function hasOpenPr(childDir: string, blocker: number): boolean {
  const out = sh(
    "gh",
    ["pr", "list", "--head", `feat/${blocker}`, "--state", "open", "--json", "number", "--limit", "1"],
    childDir,
  );
  return (JSON.parse(out) as unknown[]).length > 0;
}
