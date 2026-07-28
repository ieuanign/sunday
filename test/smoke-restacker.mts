// test/smoke-restacker.mts — hermetic smoke for restack-on-merge (#43).
//   node test/smoke-restacker.mts
//
// Real git against a temporary bare origin (test/git-fixture.mts), a real StateStore
// and a real FailurePolicy; GitHub is the one thing substituted, because every method
// on that seam is a write to somebody's repository. Offline, $0.
//
// What is asserted is observable state — what the origin holds and what Sunday was
// asked to do to the PR — never which git command was built.

import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { FailurePolicy } from "#assignor/failure.mts";
import { PauseStore } from "#assignor/pause.mts";
import { Restacker, type RestackerDeps } from "#assignor/restack.mts";
import type { Scheduler, SchedulerSnapshot } from "#assignor/scheduler.mts";
import { StateStore } from "#assignor/state.mts";
import { GitCli } from "#services/git.mts";
import {
  AWAITING_HUMAN_LABEL,
  type Blocker,
  type GitHubRestack,
  type IssueDetail,
  type MergedPullRequest,
  type OpenPullRequest,
  type PrDetail,
} from "#services/github/index.mts";
import { Logger, type Destination, type Destinations, type LogLine } from "#services/logger.mts";
import { makeFixture, ok, report, restackDrain, stubGhInEffect, type Fixture, type RestackDrain } from "./git-fixture.mts";

/** The repo root — what the routing table's child paths are resolved against. */
const ROOT = resolve(import.meta.dirname, "..");

/** The routed repo the scenarios pretend to be. */
const FULL_NAME = "sunday-fixture/child";

// ── the GitHub seam, substituted ──────────────────────────────────────────────

/** What GitHub would answer and what it was asked to write. Substituted rather than
 *  driven through the fixture's stub `gh`: a retarget and a label are invisible in git,
 *  so the only way to assert them is to hold the seam. */
class FakeGitHub implements GitHubRestack {
  /** The forward edge the dependent scan reads: what is open, and what blocks it. */
  openPrs: Omit<OpenPullRequest, "labels">[] = [];
  blocks: Record<number, number[]> = {};
  /** Issues whose blocker read FAILS, the way a 502 does (constraint 7). */
  unreadable = new Set<number>();
  /** Head branch → the merged PR that shipped it: the fork-point recovery anchor. */
  merged: Record<string, MergedPullRequest> = {};
  /** Every write, in order — `pr <n> → <base>` and `pr <n> +<label>`. */
  writes: string[] = [];
  /** Make the retarget fail the way `gh` does, its own text and all. */
  retargetError?: string;

  async listOpenPrs(): Promise<OpenPullRequest[]> {
    // Labels filled in here rather than on every scenario's literal: the dependent scan
    // reads a PR's number and head and nothing else — labels are #44's re-derive asking
    // the same read whether an item is quarantined.
    return this.openPrs.map((pr) => ({ ...pr, labels: [] }));
  }

  async blockedBy(_repo: string, issue: number): Promise<Blocker[]> {
    if (this.unreadable.has(issue)) throw new Error("gh api repos failed: gh: Bad gateway (HTTP 502)");
    return (this.blocks[issue] ?? []).map((number) => ({ number, state: "closed" }));
  }

  /** No native links and no `## Blocked by` heading — a genuine "nothing blocks this". */
  async readIssue(): Promise<IssueDetail> {
    return { title: "", body: "" };
  }

  async mergedPrForHead(_repo: string, head: string): Promise<MergedPullRequest | undefined> {
    return this.merged[head];
  }

  async retargetPr(_repo: string, pr: number, base: string): Promise<void> {
    if (this.retargetError) throw new Error(this.retargetError);
    this.writes.push(`pr ${pr} → ${base}`);
  }

  async labelPr(_repo: string, pr: number, labels: string[]): Promise<void> {
    this.writes.push(`pr ${pr} +${labels.join(",")}`);
  }

  // Admission's reads, inherited with `GitHub` and never reached from a restack.
  claim(): void {
    throw new Error("the restack does not claim issues");
  }
  release(): void {
    throw new Error("the restack does not release issues");
  }
  async issueState(): Promise<string> {
    throw new Error("the restack does not read issue state");
  }
  async openPrForHead(): Promise<string | undefined> {
    throw new Error("the restack does not probe for open PRs");
  }
  async readPr(): Promise<PrDetail> {
    throw new Error("the restack does not read pull requests");
  }
}

// ── the harness ───────────────────────────────────────────────────────────────

/** A scheduler that records the halt and starts nothing: the restack lane itself is
 *  `restackDrain()`, and what this stands in for is the pipeline the failure policy
 *  stops (#39). */
function fakeScheduler(paused: string[]): Scheduler {
  return {
    enqueue() {},
    enqueueRestack() {},
    pause(reason) {
      paused.push(reason);
    },
    resume() {},
    isPaused: () => paused.length > 0,
    snapshot: (): SchedulerSnapshot => ({
      paused: paused.length > 0,
      regularInFlight: [],
      restackInFlight: [],
      regularQueued: [],
      restackQueued: [],
    }),
  };
}

interface Harness {
  restacker: Restacker;
  lane: RestackDrain;
  state: StateStore;
  pause: PauseStore;
  /** Everything Sunday said, in order. */
  lines: LogLine[];
  /** Why the pipeline was halted, if it was. */
  paused: string[];
  /** Where a rebase's ephemeral worktree goes — under the fixture, never the real `var/`. */
  worktreePath(repo: string, branch: string): string;
}

function harness(fx: Fixture, github: FakeGitHub, git: RestackerDeps["git"] = new GitCli()): Harness {
  const lines: LogLine[] = [];
  const record: Destination = (line) => void lines.push(line);
  const dests: Destinations = { console: record, runLog: record, eventLog: record, github: record, phone: record };
  const logger = new Logger(dests);
  const state = new StateStore(resolve(fx.root, "state.json"));
  const pause = new PauseStore(resolve(fx.root, "pause.json"));
  const paused: string[] = [];
  const lane = restackDrain();
  const worktreePath = (_repo: string, branch: string): string =>
    resolve(fx.root, "restack", branch.replaceAll("/", "-"));
  const failure = new FailurePolicy({
    pause,
    scheduler: fakeScheduler(paused),
    state,
    github: { addLabels: async () => {}, labelPr: async () => {} },
    log: logger.child("failure"),
  });
  const restacker = new Restacker({
    repos: { [FULL_NAME]: fx.cfg },
    github,
    git,
    enqueueRestack: lane.enqueue,
    state,
    failure,
    log: logger.child("restack"),
    parentRoot: ROOT,
    worktreePath,
  });
  return { restacker, lane, state, pause, lines, paused, worktreePath };
}

/** How many commits `branch` carries on top of main, ON THE ORIGIN. */
function aheadOfMain(fx: Fixture, branch: string): number {
  return Number(fx.git(fx.origin, "rev-list", "--count", `main..${branch}`));
}

function isAncestor(fx: Fixture, dir: string, maybeAncestor: string, ref: string): boolean {
  try {
    fx.git(dir, "merge-base", "--is-ancestor", maybeAncestor, ref);
    return true;
  } catch {
    return false;
  }
}

// ── a merged blocker moves its direct dependent onto main, and retargets its PR ──
//
// The dependent forked at B1 and its PR targets `feat/9`. The blocker then moved on and
// squash-merged with its branch deleted — GitHub's defaults — so nothing of feat/9 is
// left anywhere except the dependent's own ancestry (ADR-0003).
{
  const fx = makeFixture("restacker-direct");
  fx.stubGh({});
  ok("direct: the stub gh is in effect before any production code runs", stubGhInEffect());

  fx.commit("shared.txt", "base\n", "C0 base");
  fx.push("main");
  fx.checkout("feat/9", "main");
  const forkPoint = fx.commit("b.txt", "from the blocker\n", "B1");
  fx.push("feat/9");
  fx.checkout("feat/10", "feat/9");
  fx.commit("a.txt", "from the dependent\n", "A1");
  fx.push("feat/10");
  fx.checkout("feat/9");
  fx.commit("b.txt", "from the blocker, revised\n", "B2 (after the dependent forked)");
  fx.push("feat/9");
  fx.squashMerge("feat/9", 91);
  fx.deleteOnOrigin("feat/9");
  fx.cloneChild();

  const github = new FakeGitHub();
  github.openPrs = [{ number: 110, head: "feat/10" }];
  github.blocks = { 10: [9] };
  const h = harness(fx, github);
  // What the run that created feat/10 recorded (#42): the commit it branched from.
  h.state.set(`${FULL_NAME}#10`, { status: "in-flight", base: "feat/9", forkPoint });

  await h.restacker.onMerge(FULL_NAME, 9);
  await h.lane.drain();

  ok("direct: the dependent now descends from main", isAncestor(fx, fx.origin, "main", "feat/10"));
  ok(
    "direct: it carries its OWN commit and nothing else",
    aheadOfMain(fx, "feat/10") === 1,
    fx.git(fx.origin, "rev-list", "--oneline", "main..feat/10"),
  );
  ok(
    "direct: its own work survived the move",
    fx.git(fx.origin, "show", "feat/10:a.txt") === "from the dependent",
  );
  ok(
    "direct: the PR is retargeted at main — the branch it targeted no longer exists",
    github.writes.includes("pr 110 → main"),
    github.writes.join(" | "),
  );
  ok("direct: nothing escaped the lane", h.lane.errors.length === 0, h.lane.errors[0]?.message ?? "");

  // Constraint 3. Without this the next cascade poisons itself: the branch's recorded
  // fork point would still be the tip it was moved OFF, and replaying from there
  // duplicates the base's commits into it — the exact defect this issue exists to kill.
  const record = h.state.get(`${FULL_NAME}#10`);
  ok(
    "direct: the branch's NEW fork point is what state now holds",
    record?.forkPoint === fx.git(fx.origin, "rev-parse", "main"),
    `${record?.forkPoint} ≠ ${fx.git(fx.origin, "rev-parse", "main")}`,
  );
  ok(
    "direct: the rest of the item's record survives the write — and a retarget is not a rebase of `base`",
    record?.status === "in-flight" && record?.base === "feat/9",
    JSON.stringify(record),
  );
}

// ── the cascade: a dependent-of-a-dependent follows onto its parent's NEW tip ──
//
// feat/11 is stacked on feat/10, which is stacked on the blocker feat/9. When feat/9
// merges, feat/10 moves onto main and feat/11 has to follow it — onto the tip feat/10
// has AFTER its own rebase, and without changing base: it is still stacked on feat/10,
// which merely moved (AC6, AC7).
{
  const fx = makeFixture("restacker-cascade");
  fx.stubGh({});
  ok("cascade: the stub gh is in effect before any production code runs", stubGhInEffect());

  fx.commit("shared.txt", "base\n", "C0 base");
  fx.push("main");
  fx.checkout("feat/9", "main");
  const forkOf10 = fx.commit("b.txt", "from the blocker\n", "B1");
  fx.push("feat/9");
  fx.checkout("feat/10", "feat/9");
  const forkOf11 = fx.commit("a.txt", "from the middle\n", "A1");
  fx.push("feat/10");
  fx.checkout("feat/11", "feat/10");
  fx.commit("c.txt", "from the leaf\n", "C1");
  fx.push("feat/11");
  fx.squashMerge("feat/9", 91);
  fx.deleteOnOrigin("feat/9");
  fx.cloneChild();

  const github = new FakeGitHub();
  github.openPrs = [
    { number: 110, head: "feat/10" },
    { number: 111, head: "feat/11" },
  ];
  github.blocks = { 10: [9], 11: [10] };
  const h = harness(fx, github);
  h.state.set(`${FULL_NAME}#10`, { status: "in-flight", base: "feat/9", forkPoint: forkOf10 });
  h.state.set(`${FULL_NAME}#11`, { status: "in-flight", base: "feat/10", forkPoint: forkOf11 });

  await h.restacker.onMerge(FULL_NAME, 9);
  await h.lane.drain();

  ok("cascade: nothing escaped the lane", h.lane.errors.length === 0, h.lane.errors[0]?.message ?? "");
  ok(
    "cascade: the leaf sits on its parent's NEW tip",
    isAncestor(fx, fx.origin, "feat/10", "feat/11"),
    fx.git(fx.origin, "log", "--oneline", "-5", "feat/11"),
  );
  ok(
    "cascade: the leaf carries only its own commit over its parent",
    Number(fx.git(fx.origin, "rev-list", "--count", "feat/10..feat/11")) === 1,
    fx.git(fx.origin, "rev-list", "--oneline", "feat/10..feat/11"),
  );
  ok(
    "cascade: and only the two of them over main — nothing was replayed twice",
    aheadOfMain(fx, "feat/11") === 2,
    fx.git(fx.origin, "rev-list", "--oneline", "main..feat/11"),
  );
  ok("cascade: the leaf's own work survived", fx.git(fx.origin, "show", "feat/11:c.txt") === "from the leaf");
  ok(
    "cascade: only the merged blocker's DIRECT dependent changes base",
    github.writes.includes("pr 110 → main") && !github.writes.some((w) => w.startsWith("pr 111 →")),
    github.writes.join(" | "),
  );
  ok(
    "cascade: the leaf's fork point is its parent's new tip, not the tip it was moved off",
    h.state.get(`${FULL_NAME}#11`)?.forkPoint === fx.git(fx.origin, "rev-parse", "feat/10"),
    String(h.state.get(`${FULL_NAME}#11`)?.forkPoint),
  );
}

// ── a branch that already carries the new base is a SKIP, not a second rebase ──
//
// A redelivered merge, or a first pass that died between the push and the retarget: the
// branch is already where it belongs. Rebasing it again from a fork point it left behind
// replays commits it no longer owns and force-pushes the result (AC5). The retarget and
// the cascade still run — both idempotent, and either may be what the first pass missed.
{
  const fx = makeFixture("restacker-already-rebased");
  fx.stubGh({});
  ok("skip: the stub gh is in effect before any production code runs", stubGhInEffect());

  fx.commit("shared.txt", "base\n", "C0 base");
  fx.push("main");
  fx.checkout("feat/9", "main");
  const forkPoint = fx.commit("b.txt", "from the blocker\n", "B1");
  fx.push("feat/9");
  fx.checkout("feat/10", "feat/9");
  fx.commit("a.txt", "from the dependent\n", "A1");
  fx.push("feat/10");
  fx.squashMerge("feat/9", 91);
  fx.deleteOnOrigin("feat/9");
  // The first pass already moved it — and died before it recorded the new fork point.
  fx.checkout("feat/10");
  fx.git(fx.author, "rebase", "--onto", "main", forkPoint);
  fx.forcePush("feat/10");
  const tipBefore = fx.git(fx.origin, "rev-parse", "feat/10");
  fx.cloneChild();

  const github = new FakeGitHub();
  github.openPrs = [{ number: 110, head: "feat/10" }];
  github.blocks = { 10: [9] };
  // Real git throughout — what is watched is only whether the rebase was ASKED for.
  const rebased: string[] = [];
  const cli = new GitCli();
  const git: RestackerDeps["git"] = {
    fetchPrune: (dir) => cli.fetchPrune(dir),
    resolveRef: (dir, ref) => cli.resolveRef(dir, ref),
    isAncestor: (dir, ancestor, ref) => cli.isAncestor(dir, ancestor, ref),
    fetchRef: (dir, ref) => cli.fetchRef(dir, ref),
    rebaseOnto: (rebase) => {
      rebased.push(rebase.branch);
      return cli.rebaseOnto(rebase);
    },
  };
  const h = harness(fx, github, git);
  h.state.set(`${FULL_NAME}#10`, { status: "in-flight", base: "feat/9", forkPoint });

  await h.restacker.onMerge(FULL_NAME, 9);
  await h.lane.drain();

  ok("skip: nothing escaped the lane", h.lane.errors.length === 0, h.lane.errors[0]?.message ?? "");
  ok("skip: the rebase was not attempted a second time", rebased.length === 0, rebased.join(", "));
  ok(
    "skip: the branch a human is looking at was not force-pushed again",
    fx.git(fx.origin, "rev-parse", "feat/10") === tipBefore,
  );
  ok(
    "skip: the retarget still runs — the first pass may be what died before it",
    github.writes.includes("pr 110 → main"),
    github.writes.join(" | "),
  );
  ok(
    "skip: and the fork point is recorded, so the next cascade is anchored",
    h.state.get(`${FULL_NAME}#10`)?.forkPoint === fx.git(fx.origin, "rev-parse", "main"),
    String(h.state.get(`${FULL_NAME}#10`)?.forkPoint),
  );
}

// ── a conflict is a decided outcome: gate the PR, push nothing, cascade no further ──
//
// The conflicting file is `src/auth/credentials.ts` deliberately (constraint 8): the
// failure classifier matches the bare word `credential` and auth is pipeline-scope, so a
// conflict routed through it would read as a dead credential and HALT THE WHOLE
// PIPELINE. A conflict is Sunday's own verdict, not a tool's error text.
{
  const fx = makeFixture("restacker-conflict");
  fx.stubGh({});
  ok("conflict: the stub gh is in effect before any production code runs", stubGhInEffect());

  fx.commit("src-auth-credentials.ts", "export const token = 'base';\n", "C0 base");
  fx.push("main");
  fx.checkout("feat/9", "main");
  const forkOf10 = fx.commit("src-auth-credentials.ts", "export const token = 'blocker v1';\n", "B1");
  fx.push("feat/9");
  // The dependent rewrites the same line…
  fx.checkout("feat/10", "feat/9");
  const forkOf11 = fx.commit("src-auth-credentials.ts", "export const token = 'dependent';\n", "A1");
  fx.push("feat/10");
  fx.checkout("feat/11", "feat/10");
  fx.commit("c.txt", "from the leaf\n", "C1");
  fx.push("feat/11");
  // …and so does the blocker, after the fork — so replaying A1 onto main cannot apply.
  fx.checkout("feat/9");
  fx.commit("src-auth-credentials.ts", "export const token = 'blocker v2';\n", "B2");
  fx.push("feat/9");
  fx.squashMerge("feat/9", 91);
  fx.deleteOnOrigin("feat/9");
  const tipBefore = fx.git(fx.origin, "rev-parse", "feat/10");
  const leafBefore = fx.git(fx.origin, "rev-parse", "feat/11");
  const child = fx.cloneChild();

  const github = new FakeGitHub();
  github.openPrs = [
    { number: 110, head: "feat/10" },
    { number: 111, head: "feat/11" },
  ];
  github.blocks = { 10: [9], 11: [10] };
  const h = harness(fx, github);
  h.state.set(`${FULL_NAME}#10`, { status: "in-flight", base: "feat/9", forkPoint: forkOf10 });
  h.state.set(`${FULL_NAME}#11`, { status: "in-flight", base: "feat/10", forkPoint: forkOf11 });

  await h.restacker.onMerge(FULL_NAME, 9);
  await h.lane.drain();

  ok("conflict: nothing escaped the lane", h.lane.errors.length === 0, h.lane.errors[0]?.message ?? "");
  ok("conflict: the branch is left exactly as the human last saw it", fx.git(fx.origin, "rev-parse", "feat/10") === tipBefore);
  ok(
    "conflict: the ephemeral worktree is gone, on this path too",
    !existsSync(h.worktreePath(FULL_NAME, "feat/10")) &&
      !fx.git(child, "worktree", "list", "--porcelain").includes(h.worktreePath(FULL_NAME, "feat/10")),
    fx.git(child, "worktree", "list", "--porcelain"),
  );
  ok(
    "conflict: the PR is labelled for a human",
    github.writes.includes(`pr 110 +${AWAITING_HUMAN_LABEL}`),
    github.writes.join(" | "),
  );
  ok(
    "conflict: and told what happened, on the PR itself",
    h.lines.some((l) => l.level === "error" && l.context.repo === FULL_NAME && l.context.target === 110),
    JSON.stringify(h.lines.map((l) => `${l.level} ${l.context.target ?? "-"}: ${l.message}`)),
  );
  ok(
    "conflict: nothing stacked on the stuck branch is moved onto a tip that did not change",
    fx.git(fx.origin, "rev-parse", "feat/11") === leafBefore,
  );
  ok(
    "conflict: the stuck branch's fork point is untouched — it did not move",
    h.state.get(`${FULL_NAME}#10`)?.forkPoint === forkOf10,
    String(h.state.get(`${FULL_NAME}#10`)?.forkPoint),
  );
  // Constraint 8, the whole reason the conflicting file is named what it is.
  ok(
    "conflict: a `credentials.ts` in the conflict does not read as a dead credential",
    h.paused.length === 0 && h.pause.read() === undefined,
    h.paused.join(" | "),
  );
}

// ── a fork point Sunday cannot read back is RECOVERED, never guessed ─────────
//
// A branch created before the fork point was recorded (#42), or a state file lost with
// the disk it was on. The merged blocker's PR head is the one anchor GitHub keeps
// forever — `refs/pull/<n>/head` survives the branch being deleted (ADR-0003) — and it
// is fetched rather than assumed, because a guessed anchor force-pushes somebody else's
// commits onto this branch (AC10).
{
  const fx = makeFixture("restacker-recovered-fork-point");
  fx.stubGh({});
  ok("recovery: the stub gh is in effect before any production code runs", stubGhInEffect());

  fx.commit("shared.txt", "base\n", "C0 base");
  fx.push("main");
  fx.checkout("feat/9", "main");
  fx.commit("b.txt", "from the blocker\n", "B1");
  fx.push("feat/9");
  fx.checkout("feat/10", "feat/9");
  fx.commit("a.txt", "from the dependent\n", "A1");
  fx.push("feat/10");
  const mergedHead = fx.squashMerge("feat/9", 91);
  fx.deleteOnOrigin("feat/9");
  fx.cloneChild();

  const github = new FakeGitHub();
  github.openPrs = [{ number: 110, head: "feat/10" }];
  github.blocks = { 10: [9] };
  github.merged = { "feat/9": { number: 91, headOid: mergedHead } };
  const h = harness(fx, github);
  // Nothing in state at all: this branch predates the fork point being recorded.

  await h.restacker.onMerge(FULL_NAME, 9);
  await h.lane.drain();

  ok("recovery: nothing escaped the lane", h.lane.errors.length === 0, h.lane.errors[0]?.message ?? "");
  ok("recovery: the dependent still moved onto main", isAncestor(fx, fx.origin, "main", "feat/10"));
  ok(
    "recovery: carrying its own commit and nothing else",
    aheadOfMain(fx, "feat/10") === 1,
    fx.git(fx.origin, "rev-list", "--oneline", "main..feat/10"),
  );
  ok(
    "recovery: an item Sunday has no record of does not get one invented for it",
    h.state.get(`${FULL_NAME}#10`) === undefined,
    JSON.stringify(h.state.get(`${FULL_NAME}#10`)),
  );
}

// ── the cascade carries its OWN anchor: the parent's PRE-REBASE tip ──────────
//
// The other recovery route, and the only one a cascaded dependent has: `refs/pull/<n>/head`
// answers for the MERGED blocker, and feat/11 never forked from that — it forked from
// feat/10, whose tip is what the force-push is about to make unfindable. So the parent's
// step captures that tip before it moves and hands it down. Here feat/11's record predates
// the fork point being written at all (#42), which is exactly the state file a running
// Sunday was upgraded on, and this is a FORCE-PUSHING path: an anchor guessed one commit
// too early replays its parent's commits into it under its own name.
{
  const fx = makeFixture("restacker-cascaded-recovery");
  fx.stubGh({});
  ok("cascaded recovery: the stub gh is in effect before any production code runs", stubGhInEffect());

  fx.commit("shared.txt", "base\n", "C0 base");
  fx.push("main");
  fx.checkout("feat/9", "main");
  const forkOf10 = fx.commit("b.txt", "from the blocker\n", "B1");
  fx.push("feat/9");
  fx.checkout("feat/10", "feat/9");
  fx.commit("a.txt", "from the middle\n", "A1");
  fx.push("feat/10");
  fx.checkout("feat/11", "feat/10");
  fx.commit("c.txt", "from the leaf\n", "C1");
  fx.push("feat/11");
  fx.squashMerge("feat/9", 91);
  fx.deleteOnOrigin("feat/9");
  fx.cloneChild();

  const github = new FakeGitHub();
  github.openPrs = [
    { number: 110, head: "feat/10" },
    { number: 111, head: "feat/11" },
  ];
  github.blocks = { 10: [9], 11: [10] };
  // Deliberately no `merged` entry: the blocker's PR head is the DIRECT dependent's
  // anchor and nothing the leaf could fork from, so the cascade is the only way it can
  // be anchored at all.
  const h = harness(fx, github);
  h.state.set(`${FULL_NAME}#10`, { status: "in-flight", base: "feat/9", forkPoint: forkOf10 });
  // The leaf has a record, and no fork point in it.
  h.state.set(`${FULL_NAME}#11`, { status: "in-flight", base: "feat/10" });

  await h.restacker.onMerge(FULL_NAME, 9);
  await h.lane.drain();

  ok("cascaded recovery: nothing escaped the lane", h.lane.errors.length === 0, h.lane.errors[0]?.message ?? "");
  ok(
    "cascaded recovery: the leaf followed its parent, on an anchor state could not give it",
    isAncestor(fx, fx.origin, "feat/10", "feat/11"),
    fx.git(fx.origin, "log", "--oneline", "-5", "feat/11"),
  );
  ok(
    "cascaded recovery: carrying its own commit and NOT a replay of its parent's",
    Number(fx.git(fx.origin, "rev-list", "--count", "feat/10..feat/11")) === 1,
    fx.git(fx.origin, "rev-list", "--oneline", "feat/10..feat/11"),
  );
  ok(
    "cascaded recovery: and only the two of them over main",
    aheadOfMain(fx, "feat/11") === 2,
    fx.git(fx.origin, "rev-list", "--oneline", "main..feat/11"),
  );
  ok(
    "cascaded recovery: the leaf's own work survived the move",
    fx.git(fx.origin, "show", "feat/11:c.txt") === "from the leaf",
  );
  ok(
    "cascaded recovery: the recovered anchor is written back, so the next cascade is not poisoned",
    h.state.get(`${FULL_NAME}#11`)?.forkPoint === fx.git(fx.origin, "rev-parse", "feat/10") &&
      h.state.get(`${FULL_NAME}#11`)?.base === "feat/10",
    JSON.stringify(h.state.get(`${FULL_NAME}#11`)),
  );
  ok(
    "cascaded recovery: an anchor the cascade already holds is nobody's failure",
    h.lines.every((l) => l.level !== "error"),
    JSON.stringify(h.lines.filter((l) => l.level === "error").map((l) => l.message)),
  );
}

// ── …and when there is nothing to recover from, the branch is LEFT ALONE ──────
{
  const fx = makeFixture("restacker-unrecoverable-fork-point");
  fx.stubGh({});
  ok("unrecoverable: the stub gh is in effect before any production code runs", stubGhInEffect());

  fx.commit("shared.txt", "base\n", "C0 base");
  fx.push("main");
  fx.checkout("feat/9", "main");
  fx.commit("b.txt", "from the blocker\n", "B1");
  fx.push("feat/9");
  fx.checkout("feat/10", "feat/9");
  fx.commit("a.txt", "from the dependent\n", "A1");
  fx.push("feat/10");
  fx.merge("feat/9", 91);
  const tipBefore = fx.git(fx.origin, "rev-parse", "feat/10");
  fx.cloneChild();

  const github = new FakeGitHub();
  github.openPrs = [{ number: 110, head: "feat/10" }];
  github.blocks = { 10: [9] };
  // No stored fork point, and the blocker never merged through a PR Sunday can find.
  const h = harness(fx, github);

  await h.restacker.onMerge(FULL_NAME, 9);
  await h.lane.drain();

  ok(
    "unrecoverable: the branch is left exactly where it was — a guessed anchor is a force-push of somebody else's commits",
    fx.git(fx.origin, "rev-parse", "feat/10") === tipBefore,
  );
  ok(
    "unrecoverable: and a human is told, rather than the failure being logged and dropped",
    h.lines.some((l) => l.level === "error" && l.context.repo === FULL_NAME && l.message.includes("feat/10")),
    JSON.stringify(h.lines.map((l) => `${l.level}: ${l.message}`)),
  );
  ok("unrecoverable: one branch nobody can anchor is not a pipeline halt", h.paused.length === 0, h.paused.join(" | "));
}

// ── the #39 wire: a wall met during a restack stops the pipeline ─────────────
//
// v1 logged a failed restack and dropped it, so a 403 or a spent quota hit here was
// invisible while every other lane kept feeding the same wall. Every failure in this
// module ends at the policy instead — with the repo and no work item, so a `gh` blip
// cannot spend a dependent ISSUE's one agent-run retry (constraint 9).
{
  const fx = makeFixture("restacker-403");
  fx.stubGh({});
  ok("403: the stub gh is in effect before any production code runs", stubGhInEffect());

  fx.commit("shared.txt", "base\n", "C0 base");
  fx.push("main");
  fx.checkout("feat/9", "main");
  const forkPoint = fx.commit("b.txt", "from the blocker\n", "B1");
  fx.push("feat/9");
  fx.checkout("feat/10", "feat/9");
  fx.commit("a.txt", "from the dependent\n", "A1");
  fx.push("feat/10");
  fx.squashMerge("feat/9", 91);
  fx.deleteOnOrigin("feat/9");
  fx.cloneChild();

  const github = new FakeGitHub();
  github.openPrs = [{ number: 110, head: "feat/10" }];
  github.blocks = { 10: [9] };
  github.retargetError = "gh pr edit failed: gh: HTTP 403: Resource not accessible (https://api.github.com/repos)";
  const h = harness(fx, github);
  h.state.set(`${FULL_NAME}#10`, { status: "in-flight", base: "feat/9", forkPoint });

  await h.restacker.onMerge(FULL_NAME, 9);
  await h.lane.drain();

  ok("403: nothing escaped the lane — the funnel caught it", h.lane.errors.length === 0, h.lane.errors[0]?.message ?? "");
  ok("403: the pipeline is halted", h.paused.length === 1, h.paused.join(" | "));
  ok("403: and the halt is durable, so a restart does not lift it", h.pause.read() !== undefined);
  ok(
    "403: the failure is reported where the stuck branch is",
    h.lines.some((l) => l.level === "error" && l.context.repo === FULL_NAME && l.context.target === 110),
    JSON.stringify(h.lines.filter((l) => l.level === "error").map((l) => l.message)),
  );
  ok(
    "403: the dependent's own work item keeps its retry — a `gh` wall is not its failure",
    h.state.get(`${FULL_NAME}#10`)?.retried === undefined && h.state.get(`${FULL_NAME}#10`)?.status === "in-flight",
    JSON.stringify(h.state.get(`${FULL_NAME}#10`)),
  );
}

// ── a read that failed is never an answer, and never the end of the pass ──────
//
// `readBlockers` throws by contract (#42). Reading that as "not a dependent" leaves a
// branch stacked on a merged blocker forever, and letting it escape costs every OTHER
// dependent its restack (constraint 7).
{
  const fx = makeFixture("restacker-unreadable-candidate");
  fx.stubGh({});
  ok("unreadable: the stub gh is in effect before any production code runs", stubGhInEffect());

  fx.commit("shared.txt", "base\n", "C0 base");
  fx.push("main");
  fx.checkout("feat/9", "main");
  const forkPoint = fx.commit("b.txt", "from the blocker\n", "B1");
  fx.push("feat/9");
  fx.checkout("feat/10", "feat/9");
  fx.commit("a.txt", "from the dependent\n", "A1");
  fx.push("feat/10");
  fx.checkout("feat/12", "main");
  fx.commit("d.txt", "somebody else\n", "D1");
  fx.push("feat/12");
  fx.squashMerge("feat/9", 91);
  fx.deleteOnOrigin("feat/9");
  const otherBefore = fx.git(fx.origin, "rev-parse", "feat/12");
  fx.cloneChild();

  const github = new FakeGitHub();
  // The unreadable one is scanned FIRST: the pass has to survive it, not stop at it.
  github.openPrs = [
    { number: 112, head: "feat/12" },
    { number: 110, head: "feat/10" },
  ];
  github.blocks = { 10: [9] };
  github.unreadable = new Set([12]);
  const h = harness(fx, github);
  h.state.set(`${FULL_NAME}#10`, { status: "in-flight", base: "feat/9", forkPoint });

  await h.restacker.onMerge(FULL_NAME, 9);
  await h.lane.drain();

  ok("unreadable: nothing escaped the lane", h.lane.errors.length === 0, h.lane.errors[0]?.message ?? "");
  ok(
    "unreadable: the dependent behind the unreadable one is still restacked",
    isAncestor(fx, fx.origin, "main", "feat/10") && aheadOfMain(fx, "feat/10") === 1,
    fx.git(fx.origin, "rev-list", "--oneline", "main..feat/10"),
  );
  ok(
    "unreadable: the candidate nobody could read is reported, not silently dropped",
    h.lines.some((l) => l.level === "error" && l.message.includes("#12")),
    JSON.stringify(h.lines.filter((l) => l.level === "error").map((l) => l.message)),
  );
  ok("unreadable: and left alone — a failed read is not permission to touch it", fx.git(fx.origin, "rev-parse", "feat/12") === otherBefore);
}

report();
