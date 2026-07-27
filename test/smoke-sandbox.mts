// test/smoke-sandbox.mts — hermetic smoke for the sandbox service (issue #33).
//   devbox run node test/smoke-sandbox.mts
// Was smoke-preflight.mts: the pure half (isScaffoldPlaceholder) is unchanged, and the
// image sweep is now driven with a SUBSTITUTED build step, so what is asserted is the
// sweep's decisions (which repo ends up built, which failed and why) with no docker
// running. Container creation and the real sandcastle build stay untested here — the
// staged cutover (#45) validates those. $0, offline, no docker, no tokens.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { Logger, type Destinations, type LogLine } from "#services/logger.mts";
import { SandboxService, isScaffoldPlaceholder, type ImageOutcome } from "#services/sandbox.mts";
import type { RepoConfig } from "#config/repos.mts";

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : `\n    ${detail}`}`);
};

// ── fixtures ──────────────────────────────────────────────────────────────────

/** A throwaway parent workspace, removed however this process ends. */
const fixtureRoot = resolve(import.meta.dirname, "..", ".scratch", `smoke-sandbox-${process.pid}`);
process.on("exit", () => rmSync(fixtureRoot, { recursive: true, force: true }));

const REAL_DOCKERFILE = "FROM acme-dev\nRUN echo built\n";
const SCAFFOLD_DOCKERFILE = "# EDIT ME: base this on YOUR child's own dev image.\nFROM your-child-dev-image\n";

/** One scenario's parent workspace on disk: a child checkout per repo, each carrying
 *  the `.sandcastle/Dockerfile` the sweep reads. `null` leaves the file out — the
 *  child that was never `sandcastle init`ed. Returns the parent root. */
function workspace(scenario: string, children: Record<string, string | null>): string {
  const root = resolve(fixtureRoot, scenario);
  for (const [name, dockerfile] of Object.entries(children)) {
    mkdirSync(resolve(root, name, ".sandcastle"), { recursive: true });
    if (dockerfile !== null) writeFileSync(resolve(root, name, ".sandcastle", "Dockerfile"), dockerfile, "utf8");
  }
  return root;
}

/** The routing table for those children — `<name>` under `acme/`. */
function routingTable(children: string[]): Record<string, RepoConfig> {
  return Object.fromEntries(
    children.map((name) => [
      `acme/${name}`,
      { path: name, imageName: `${name}-sandbox`, promptFile: "docs/sandbox-prompt.md", triggerLabels: ["ready-for-agent"] },
    ]),
  );
}

/** A real Logger whose console destination records — console is the one sink every
 *  level reaches exactly once, so a line is captured whatever level it was emitted at. */
function recordingLogger(): { lines: LogLine[]; logger: Logger } {
  const lines: LogLine[] = [];
  const drop = () => {};
  const dests: Destinations = {
    console: (line) => void lines.push(line),
    runLog: drop,
    eventLog: drop,
    github: drop,
    phone: drop,
  };
  return { lines, logger: new Logger(dests) };
}

const find = (outcomes: ImageOutcome[], fullName: string): ImageOutcome | undefined =>
  outcomes.find((o) => o.fullName === fullName);

// ── isScaffoldPlaceholder: the unedited `sandcastle init` Dockerfile is refused ──
{
  ok("placeholder: scaffold detected", isScaffoldPlaceholder(SCAFFOLD_DOCKERFILE));
  ok("placeholder: a real Dockerfile passes", !isScaffoldPlaceholder("FROM node:22-alpine\nRUN apk add bash\n"));
}

// ── the sweep: one repo's failure is that repo's outcome, not the sweep's ──
{
  const root = workspace("one-fails", { finance: REAL_DOCKERFILE, drive: REAL_DOCKERFILE, liddlemise: REAL_DOCKERFILE });
  const { lines, logger } = recordingLogger();
  const attempted: string[] = [];
  const sandbox = new SandboxService(logger, async (job) => {
    attempted.push(job.fullName);
    // How a dead daemon reaches the sweep: the build step rejects.
    if (job.fullName === "acme/drive") throw new Error("Cannot connect to the Docker daemon");
  });

  let thrown: unknown;
  const outcomes = await sandbox
    .buildImages(routingTable(["finance", "drive", "liddlemise"]), root)
    .catch((err: unknown): ImageOutcome[] => {
      thrown = err;
      return [];
    });
  ok("sweep: a failing build does not throw out of the sweep", thrown === undefined, String(thrown));

  ok("sweep: one outcome per routed repo", outcomes.length === 3, JSON.stringify(outcomes));
  ok("sweep: the healthy repos are built", find(outcomes, "acme/finance")?.status === "built" && find(outcomes, "acme/liddlemise")?.status === "built", JSON.stringify(outcomes));
  const failed = find(outcomes, "acme/drive");
  ok("sweep: the failing repo is failed, carrying the reason", failed?.status === "failed" && failed.reason.includes("Cannot connect to the Docker daemon"), JSON.stringify(failed));
  ok("sweep: a repo's outcome names its image", find(outcomes, "acme/finance")?.imageName === "finance-sandbox", JSON.stringify(outcomes));
  ok("sweep: the repos after the failure are still built", attempted.join(",") === "acme/finance,acme/drive,acme/liddlemise", attempted.join(","));

  // v1 logged its builds to stdout and nowhere else, so a failed image was invisible
  // until an issue died mid-run. Every line the sweep produces goes through the Logger.
  const errors = lines.filter((l) => l.level === "error");
  ok(
    "sweep: the failure is reported at error, against the repo it happened to",
    errors.length === 1 && errors[0]!.context.repo === "acme/drive" && errors[0]!.message.includes("Cannot connect to the Docker daemon"),
    JSON.stringify(errors),
  );
  ok(
    "sweep: progress is reported at info, naming the image being built",
    lines.some((l) => l.level === "info" && l.message.includes("finance-sandbox")),
    JSON.stringify(lines.map((l) => `${l.level}: ${l.message}`)),
  );
  ok("sweep: every line carries the service's own module tag", lines.every((l) => l.module === "sandbox"), JSON.stringify(lines.map((l) => l.module)));
}

// ── the Dockerfile the build would use: unbuildable is this repo's failure too ──
{
  const root = workspace("dockerfile-refused", { finance: SCAFFOLD_DOCKERFILE, drive: null, liddlemise: REAL_DOCKERFILE });
  const { logger } = recordingLogger();
  const attempted: string[] = [];
  const sandbox = new SandboxService(logger, async (job) => void attempted.push(job.fullName));

  const outcomes = await sandbox.buildImages(routingTable(["finance", "drive", "liddlemise"]), root);
  const scaffold = find(outcomes, "acme/finance");
  ok(
    "dockerfile: an unedited scaffold FROM fails its repo, with the edit-it fix in the reason",
    scaffold?.status === "failed" && scaffold.reason.includes("placeholder") && scaffold.reason.includes(".sandcastle"),
    JSON.stringify(scaffold),
  );
  const unreadable = find(outcomes, "acme/drive");
  ok(
    "dockerfile: one that cannot be read fails its repo, not the sweep",
    unreadable?.status === "failed" && unreadable.reason.includes("Dockerfile"),
    JSON.stringify(unreadable),
  );
  ok("dockerfile: the other repos still build", find(outcomes, "acme/liddlemise")?.status === "built", JSON.stringify(outcomes));
  ok("dockerfile: no build is spent on a Dockerfile that can only fail", attempted.join(",") === "acme/liddlemise", attempted.join(","));
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
