// test/smoke-run-one.mts — hermetic smoke for the hand-run driver (#38): what
// `issue/run-one.mts` decides BEFORE it spends anything.
//   devbox run node test/smoke-run-one.mts
// The real `planRun` over a fake routing table, a fake GitHub seam and a throwaway
// `var/` — the driver forks a real agent run from a terminal, so what it refuses is the
// only thing standing between a mistyped key and real quota. The fork itself is wiring
// (`assignor/fork.mts`, driven by test/smoke-spine-fork.mts). $0, no network, no docker.

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";

import type { RepoConfig } from "#config/repos.mts";
import { planRun } from "#issue/run-one.mts";
import { acquireLock, releaseLock } from "#lib/lock.mts";
import type { GitHub } from "#services/github/index.mts";

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : `\n    ${detail}`}`);
};

const dir = resolve(import.meta.dirname, "..", ".scratch", `smoke-run-one-${process.pid}`);

const CONFIG: RepoConfig = {
  path: "repos/finance",
  imageName: "sunday-finance",
  promptFile: "prompts/finance.md",
  triggerLabels: ["sunday"],
};
const REPOS: Record<string, RepoConfig> = { "acme/finance": CONFIG };
/** The work item every case below is about. */
const KEY = "acme/finance#57";

/** Every path the driver hands the child, pointed at this smoke's own dir — nothing here
 *  goes near the real `var/`. */
const paths = {
  resultPath: (key: string) => resolve(dir, "results", `${key.replace(/[^A-Za-z0-9._-]/g, "-")}.json`),
  pidPath: (key: string) => resolve(dir, "running", `${key.replace(/[^A-Za-z0-9._-]/g, "-")}.pid`),
  runLogPath: (fullName: string, flow: string) => resolve(dir, "log", fullName, flow, "run.log"),
  eventLogPath: resolve(dir, "log", "events.jsonl"),
};

/** A GitHub seam answering "nothing blocks this issue". */
function github(over: Partial<GitHub> = {}): GitHub {
  return {
    claim: () => {},
    release: () => {},
    blockedBy: async () => [],
    issueState: async () => "closed",
    readIssue: async () => ({ title: "", body: "" }),
    openPrForHead: async () => undefined,
    // #44's read: a hand run is an ISSUE run, and this smoke never reaches a pull request.
    readPr: async () => {
      throw new Error("readPr: a hand run does not read pull requests");
    },
    ...over,
  };
}

try {
  // ── the key. It becomes a path segment, an issue a real agent is pointed at and a
  //    branch pushed to origin, and it is typed by a human at a terminal: a repo this
  //    workspace does not route is refused rather than resolved to something near it ──
  {
    const planned = await planRun("acme/legal#57", { repos: REPOS, github: github(), paths });
    ok(
      "a key naming a repo the routing table does not route is refused",
      "refuse" in planned && planned.refuse.includes("acme/legal#57"),
      JSON.stringify(planned),
    );
  }

  // ── …and a key naming a PULL REQUEST (#44). The key parses — `#pr<n>` is a work item —
  //    but this driver runs the ISSUE lane, so resolving one would point a real agent at
  //    whatever issue happens to be numbered `n` and open a pull request for it ──
  {
    const asked: string[] = [];
    const planned = await planRun("acme/finance#pr57", {
      repos: REPOS,
      github: github({ blockedBy: async () => (asked.push("blockedBy"), []) }),
      paths,
    });
    ok(
      "a pull request's key is refused — a hand run is an issue run, and #pr57 is not issue 57",
      "refuse" in planned && planned.refuse.includes("acme/finance#pr57"),
      JSON.stringify(planned),
    );
    ok("and refused before anything is asked of GitHub about an issue nobody named", asked.length === 0, JSON.stringify(asked));
  }

  // ── the guard that costs money if it is missing: this driver forks a real agent from
  //    a terminal, and the parent may already have one on the item. Two agents on one
  //    issue is duplicate quota, two pushes to one branch and a duplicate pull request ──
  {
    const asked: string[] = [];
    acquireLock(paths.pidPath(KEY), process.pid); // a live holder — this very process
    const planned = await planRun(KEY, {
      repos: REPOS,
      github: github({ blockedBy: async () => (asked.push("blockedBy"), []) }),
      paths,
    });
    ok(
      "an item another process still holds the lock on is refused, naming who holds it",
      "refuse" in planned && planned.refuse.includes(String(process.pid)),
      JSON.stringify(planned),
    );
    ok("and it is refused before anything is asked of GitHub", asked.length === 0, JSON.stringify(asked));
  }

  // ── the other half of that guard: a lock is evidence only while its holder is there.
  //    A child killed mid-run leaves one behind, and reading that as a live holder wedges
  //    the item — the hand run is exactly how an operator gets past it ──
  {
    acquireLock(paths.pidPath(KEY), spawnSync(process.execPath, ["-e", ""]).pid!); // certainly exited
    const planned = await planRun(KEY, { repos: REPOS, github: github(), paths });
    ok("a lock whose holder has died does not refuse the run", "job" in planned, JSON.stringify(planned));
    releaseLock(paths.pidPath(KEY));
  }

  // ── the base: the same `resolveBase` admission uses, so a hand-run item stacks exactly
  //    as an admitted one does (#42) ──
  {
    const stacked = await planRun(KEY, {
      repos: REPOS,
      github: github({ blockedBy: async () => [{ number: 42, state: "open" }], openPrForHead: async () => "https://x/1" }),
      paths,
    });
    ok(
      "an item whose blocker has a PR open is forked on its blocker's branch, not on main",
      "job" in stacked && stacked.job.base === "feat/42",
      JSON.stringify(stacked),
    );

    // Never `main` as a fallback: a hand run that ignores its blockers opens a pull
    // request carrying somebody else's commits.
    const deferred = await planRun(KEY, {
      repos: REPOS,
      github: github({ blockedBy: async () => [{ number: 42, state: "open" }] }),
      paths,
    });
    ok(
      "an item whose blocker has nothing to stack on is refused rather than run on main",
      "refuse" in deferred && deferred.refuse.includes("#42"),
      JSON.stringify(deferred),
    );
  }

  // ── the job itself: the child derives no path of its own, so a driver that resolved
  //    one wrong writes an outcome nobody applies and a run log nobody finds ──
  {
    const planned = await planRun(KEY, { repos: REPOS, github: github(), paths });
    ok(
      "the job names the item, its repo config and the base, and points at the durable layout it was handed",
      "job" in planned &&
        planned.job.key === KEY &&
        planned.job.repo === "acme/finance" &&
        planned.job.issue === 57 &&
        planned.job.config === CONFIG &&
        planned.job.base === "main" &&
        planned.job.resultPath === paths.resultPath(KEY) &&
        planned.job.pidPath === paths.pidPath(KEY) &&
        planned.job.runLogPath === paths.runLogPath("acme/finance", "57") &&
        planned.job.eventLogPath === paths.eventLogPath,
      JSON.stringify(planned),
    );
    // A hand run is a FRESH run: a session handle belongs to the gate the parent kept it
    // for, and a retry error to the one retry #39 grants.
    ok(
      "and it carries neither a session to resume nor a previous run's error",
      "job" in planned && planned.job.resume === undefined && planned.job.retryError === undefined,
      JSON.stringify(planned),
    );
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
