// test/git-fixture.mts — the real-git fixture harness (V2, issue #32).
//
// The merge races V2 re-anchors stacking against (ADR-0003) — a blocker's branch
// deleted on merge, a blocker force-pushed, a swallowed blocker read — are rare,
// silent, and unprovable by hand. This harness is the second test seam the PRD
// names: real git against a temporary BARE ORIGIN, so a scenario can script
// merge, squash-merge, branch deletion and force-push and then drive production
// code against the result. Offline, no docker, no agent, no tokens.
//
// Not a smoke — `test/run.mts` only picks up `smoke-*.mts`. It is imported BY the
// smokes.

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import type { WorkItem } from "#listener/scheduler.mts";
import type { RepoConfig } from "#config/repos.mts";

/** The repo root — `test/..`. Fixtures hang off it under `.scratch/`. */
const ROOT = resolve(import.meta.dirname, "..");

/** Every fixture root built in this process, removed on exit so a scenario leaves
 *  nothing behind whether it passed, failed, or threw. */
const builtRoots: string[] = [];
process.on("exit", () => {
  for (const root of builtRoots) rmSync(root, { recursive: true, force: true });
});

/** Run git in `dir` and return its trimmed stdout. Throws (with git's own stderr)
 *  on a non-zero exit — a fixture that can't be built must fail loudly, not
 *  silently produce a repo the scenario then misreads. */
function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Identity + signing config every fixture clone gets, so a developer's global git
 *  config (a signing key, a different committer) cannot break the suite. */
function configure(clone: string): void {
  git(clone, "config", "user.email", "fixture@sunday.local");
  git(clone, "config", "user.name", "sunday fixture");
  git(clone, "config", "commit.gpgsign", "false");
}

// ── the stub gh ───────────────────────────────────────────────────────────────

/** What the stub answers with. A bare string is stdout with a zero exit. */
export interface StubReply {
  stdout?: string;
  stderr?: string;
  /** Non-zero makes `sh` throw carrying `stderr` — how a scenario models a 502. */
  exitCode?: number;
}

/** The scenario's declared `gh` surface. Each key is matched as a SUBSTRING of the
 *  joined argv and the longest match wins, so a broad `pr list` can be overridden
 *  by a specific `pr list --head feat/9`. */
export type StubResponses = Record<string, string | StubReply>;

/** What the stub prints when a scenario drove a `gh` call it never declared. Also
 *  the probe `stubGhInEffect` looks for — the real `gh` never says this. */
const UNSTUBBED = "no response declared";

function writeStubGh(binDir: string, responses: StubResponses): void {
  mkdirSync(binDir, { recursive: true });
  const stub = resolve(binDir, "gh");
  // Deliberately syntax that is valid as both CommonJS and ESM (no import/require):
  // an extensionless file's module kind is not something a fixture should depend on.
  writeFileSync(
    stub,
    [
      `#!${process.execPath}`,
      `const RESPONSES = ${JSON.stringify(responses)};`,
      `const argv = process.argv.slice(2).join(" ");`,
      `let key = null;`,
      `for (const k of Object.keys(RESPONSES)) {`,
      `  if (argv.includes(k) && (key === null || k.length > key.length)) key = k;`,
      `}`,
      `if (key === null) {`,
      `  process.stderr.write("stub gh: ${UNSTUBBED} for \`gh " + argv + "\`\\n");`,
      `  process.exit(1);`,
      `}`,
      `const r = RESPONSES[key];`,
      `const reply = typeof r === "string" ? { stdout: r } : r;`,
      `if (reply.stdout) process.stdout.write(reply.stdout + "\\n");`,
      `if (reply.stderr) process.stderr.write(reply.stderr + "\\n");`,
      `process.exit(reply.exitCode ?? 0);`,
      ``,
    ].join("\n"),
    "utf8",
  );
  chmodSync(stub, 0o755);
  // `sh` inherits process.env, so prepending here covers every production call.
  const path = process.env.PATH ?? "";
  if (!path.startsWith(`${binDir}:`)) process.env.PATH = `${binDir}:${path}`;
}

/** Is the `gh` on PATH ours? Probes an undeclared subcommand: the stub answers
 *  with its own refusal, the real `gh` never does. Every scenario asserts this
 *  BEFORE it drives production code — a fall-through to the real `gh` would be a
 *  live write against a real repository. */
export function stubGhInEffect(): boolean {
  const probe = spawnSync("gh", ["__sunday_stub_probe__"], { encoding: "utf8" });
  return probe.status !== 0 && (probe.stderr ?? "").includes(UNSTUBBED);
}

export interface Fixture {
  /** `.scratch/git-fixture/<scenario>/` — removed on process exit. */
  readonly root: string;
  /** The bare origin. Stands in for GitHub: the only repo both clones share. */
  readonly origin: string;
  /** The clone the scenario authors history in. Never the repo under test. */
  readonly author: string;
  /** Routing entry for the child, ready to hand to production code. Its `path` is
   *  RELATIVE TO THE REPO ROOT — that is what the listener resolves it against. */
  readonly cfg: RepoConfig;
  /** Run git in `dir` (any of the fixture's repos) and return trimmed stdout. */
  git(dir: string, ...args: string[]): string;
  /** Check `branch` out in the author clone, creating it at `from` when given. */
  checkout(branch: string, from?: string): void;
  /** Commit `content` to `file` on the author's current branch; returns the sha. */
  commit(file: string, content: string, msg: string): string;
  /** Push the author's `branch` to origin. */
  push(branch: string): void;
  /** Force-push the author's `branch`, replacing whatever the origin had. Models a
   *  blocker rewriting its history after a dependent already forked from it. */
  forcePush(branch: string): void;
  /** Merge `branch` into main the way GitHub's "Create a merge commit" does — a
   *  `--no-ff` merge, pushed — and record the PR head at `refs/pull/<pr>/head` on
   *  the origin. Returns the merged head sha (what the merge webhook carries). */
  merge(branch: string, pr: number): string;
  /** Merge `branch` into main the way GitHub's "Squash and merge" does — ONE new
   *  commit on main carrying the branch's tree changes, so the branch's own
   *  commits never enter main's ancestry — and record `refs/pull/<pr>/head`.
   *  Returns the merged head sha. */
  squashMerge(branch: string, pr: number): string;
  /** Delete `branch` from the origin, as GitHub's "automatically delete head
   *  branches" does on merge. Only the `refs/heads` entry goes; whatever
   *  `refs/pull/<n>/head` was recorded still holds the tip. */
  deleteOnOrigin(branch: string): void;
  /** Install (or replace) the scenario's stub `gh` on `PATH`. Call it again to
   *  change the answers as the scenario moves — e.g. once a PR has merged. */
  stubGh(responses: StubResponses): void;
  /** Clone the child production code is driven against, and return its path.
   *  `--no-local` is MANDATORY and load-bearing: a plain local clone hardlinks the
   *  whole object database, so a tip the origin keeps only outside `refs/heads`
   *  (a branch deleted on merge, `refs/pull/<n>/head`) would still be present
   *  locally and the races this harness exists to reproduce could not happen. */
  cloneChild(): string;
}

/** Build a fixture: a bare origin plus the author clone that writes to it. The
 *  scenario adds branches and commits through the returned primitives, then
 *  clones the child it drives production code against. */
export function makeFixture(scenario: string): Fixture {
  const root = resolve(ROOT, ".scratch", "git-fixture", scenario);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  builtRoots.push(root);

  const origin = resolve(root, "origin.git");
  const author = resolve(root, "author");
  const child = resolve(root, "child");
  git(root, "init", "--bare", "-b", "main", origin);
  git(root, "clone", origin, author);
  configure(author);

  /** Shared shape of both merge styles: capture the PR head, apply the merge on
   *  main, publish it, and record the head at `refs/pull/<pr>/head`. GitHub keeps
   *  every PR head there forever — it is NOT under `refs/heads`, so a plain `git
   *  fetch` never brings it down. That is what makes a merged-then-deleted branch
   *  recoverable on the origin yet absent in a child clone. */
  function landOnMain(branch: string, pr: number, apply: () => void): string {
    const head = git(author, "rev-parse", branch);
    git(author, "checkout", "main");
    apply();
    git(author, "push", "origin", "main");
    git(origin, "update-ref", `refs/pull/${pr}/head`, head);
    return head;
  }

  return {
    root,
    origin,
    author,
    cfg: {
      path: relative(ROOT, child),
      imageName: "sunday-fixture:none",
      promptFile: "docs/sandbox-prompt.md",
      triggerLabels: ["ready-for-agent"],
    },
    git,
    checkout(branch, from) {
      git(author, "checkout", ...(from ? ["-b", branch, from] : [branch]));
    },
    commit(file, content, msg) {
      writeFileSync(resolve(author, file), content, "utf8");
      git(author, "add", file);
      git(author, "commit", "-m", msg);
      return git(author, "rev-parse", "HEAD");
    },
    push(branch) {
      git(author, "push", "origin", branch);
    },
    forcePush(branch) {
      git(author, "push", "--force", "origin", branch);
    },
    merge(branch, pr) {
      return landOnMain(branch, pr, () => {
        git(author, "merge", "--no-ff", "-m", `Merge pull request #${pr} from ${branch}`, branch);
      });
    },
    squashMerge(branch, pr) {
      return landOnMain(branch, pr, () => {
        git(author, "merge", "--squash", branch);
        git(author, "commit", "-m", `${branch} (#${pr})`);
      });
    },
    deleteOnOrigin(branch) {
      git(origin, "update-ref", "-d", `refs/heads/${branch}`);
    },
    stubGh(responses) {
      writeStubGh(resolve(root, "bin"), responses);
    },
    cloneChild() {
      git(root, "clone", "--no-local", origin, child);
      configure(child);
      return child;
    },
  };
}

// ── the restack lane ──────────────────────────────────────────────────────────

export interface RestackDrain {
  /** Hand this to `makeRestacker` in place of `scheduler.enqueueRestack`. */
  enqueue(item: WorkItem): void;
  /** Run everything queued — including whatever a running step enqueues — to
   *  completion, one at a time. */
  drain(): Promise<void>;
  /** Errors that escaped a step, in completion order. The real restack lane
   *  swallows these into a log line, so a scenario that wants to prove one escaped
   *  has to read them here. */
  readonly errors: Error[];
}

/** An inline stand-in for the scheduler's restack lane. The scheduler itself is
 *  out of scope for these scenarios — its concurrency cap, branch lock and dedup
 *  are unit-tested elsewhere — but a restack step enqueues its own cascade, so a
 *  scenario still needs something to drain. */
export function restackDrain(): RestackDrain {
  const queue: WorkItem[] = [];
  const errors: Error[] = [];
  return {
    errors,
    enqueue(item) {
      queue.push(item);
    },
    async drain() {
      for (let item = queue.shift(); item; item = queue.shift()) {
        try {
          await item.run();
        } catch (err) {
          errors.push(err instanceof Error ? err : new Error(String(err)));
        }
      }
    },
  };
}

// ── assertions ────────────────────────────────────────────────────────────────

let fails = 0;

/** A behaviour that must hold. */
export function ok(label: string, cond: boolean, detail = ""): void {
  if (!cond) fails++;
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : `\n    ${detail}`}`);
}

/** A behaviour we WANT but do not yet have: `desired` is the assertion the fixed
 *  code would satisfy. While the defect is present it is announced loudly and
 *  costs nothing — `npm test` has to stay green so it can keep gating the rest of
 *  V2 rather than being a permanently red suite nobody reads. The moment the
 *  defect is fixed the marker FAILS, which is the point: it forces whoever fixed
 *  it to promote this line to a real `ok` and delete the marker. */
export function knownDefect(label: string, desired: boolean, detail = ""): void {
  if (desired) {
    fails++;
    console.log(`✗ KNOWN DEFECT NO LONGER REPRODUCES — promote this to ok() and drop the marker:\n    ${label}`);
    return;
  }
  console.log(`🐞 KNOWN DEFECT (expected failure, not counted): ${label}${detail ? `\n    ${detail}` : ""}`);
}

/** Print the tally and exit — the last line of every scenario file. */
export function report(): never {
  console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
  process.exit(fails === 0 ? 0 : 1);
}
