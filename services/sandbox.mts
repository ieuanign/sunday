// services/sandbox.mts — the container half of a run: sandbox images and the docker
// sandbox a run happens inside. Named for what it does, not for the library it uses
// (plan.md decision #8), and it is one of only two files allowed to import that
// library — the other is services/agent/claude.mts.
//
// The sweep REPORTS, it never CLASSIFIES: every routed repo yields an outcome, and a
// failed one carries the reason as text. Deciding that a dead daemon is pipeline-scope
// while a placeholder Dockerfile is repo-scope belongs to the classifier (#39), which
// reads these reasons — v1 threw out of the loop on the first failure instead, so one
// unbuildable child stopped every other child's images from being built at all.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

import type { Logger, ModuleLogger } from "./logger.mts";
import type { RepoConfig } from "#config/repos.mts";

/** Pure: an unedited `sandcastle init` Dockerfile — its FROM is still the scaffold
 *  placeholder, so building it can only fail; the actionable fix is editing the
 *  Dockerfile, not retrying the build. */
export function isScaffoldPlaceholder(dockerfile: string): boolean {
  return dockerfile.includes("your-child-dev-image");
}

/** One repo's image build, as the build step sees it. */
export interface ImageBuildJob {
  /** `<owner>/<repo>`, exactly as the routing table keys it. */
  fullName: string;
  imageName: string;
  /** The child checkout the build runs in — its `.sandcastle/` is the build context. */
  childDir: string;
}

/** How one image actually gets built. Rejecting is how a build failure is reported;
 *  the rejection's message becomes that repo's `reason`. Injected so the sweep's
 *  decisions are assertable with no docker running. */
export type BuildImage = (job: ImageBuildJob) => Promise<void>;

/** What the sweep says about one repo. `failed` stops that repo and nothing else
 *  (ADR-0002: setup → repo scope). */
export type ImageOutcome =
  | { fullName: string; imageName: string; status: "built" }
  | { fullName: string; imageName: string; status: "failed"; reason: string };

/** A host directory the caller wants inside the sandbox. Plain data, so a caller
 *  never has to name a library type to ask for a mount. */
export interface SandboxMount {
  hostPath: string;
  sandboxPath: string;
  readonly?: boolean;
}

/** The container a run happens inside, as the agent library wants it. The one library
 *  type this service hands out — it stops at services/agent/claude.mts and never
 *  reaches the agent seam's request or result. */
export type SandboxHandle = ReturnType<typeof docker>;

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** How much of a failed build's output rides along in the reason: enough to name the
 *  broken RUN line, bounded so a runaway build cannot blow up the log line. */
const OUTPUT_TAIL_CHARS = 2000;

/** The real build — `sandcastle docker build-image` in the child's own dir, the same
 *  command the onboarding recipe runs by hand. The CLI is this repo's own dev
 *  dependency, so it is resolved from this module rather than from the caller's root.
 *
 *  ASYNC, never spawnSync: a build takes minutes, and a synchronous sweep starved v1's
 *  readiness probe into a SIGKILL/restart loop. PIPED, never `stdio: "inherit"`: v1's
 *  build output went to stdout and nowhere else, so a failure left no durable trace —
 *  here the tail rides back on the rejection and reaches the Logger as the reason. */
async function sandcastleBuild(job: ImageBuildJob): Promise<void> {
  const cli = resolve(import.meta.dirname, "..", "node_modules", ".bin", "sandcastle");
  await new Promise<void>((res, rej) => {
    const build = spawn(cli, ["docker", "build-image", "--image-name", job.imageName], {
      cwd: job.childDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let tail = "";
    const keep = (chunk: Buffer): void => {
      tail = (tail + chunk.toString()).slice(-OUTPUT_TAIL_CHARS);
    };
    build.stdout?.on("data", keep);
    build.stderr?.on("data", keep);
    build.on("error", rej);
    build.on("close", (code) =>
      code === 0
        ? res()
        : rej(new Error(`sandcastle docker build-image (${job.imageName}) exited ${code}${tail.trim() ? ` — ${tail.trim()}` : ""}`)),
    );
  });
}

export class SandboxService {
  // Declared, not parameter properties: Node runs `.mts` in strip-only mode, which
  // rejects `constructor(private x)`.
  private readonly log: ModuleLogger;
  private readonly buildImage: BuildImage;

  constructor(logger: Logger, buildImage: BuildImage = sandcastleBuild) {
    this.log = logger.child("sandbox");
    this.buildImage = buildImage;
  }

  /** The sandbox one run happens inside: this repo's image, plus whatever the caller
   *  needs mounted. Credential-free of GitHub BY DESIGN — no token, no gh config and
   *  no git credential helper is mounted here or anywhere else, because the sandbox
   *  decides and the host performs every write (CONTEXT.md). */
  forImage(imageName: string, mounts: readonly SandboxMount[] = []): SandboxHandle {
    return docker({ imageName, mounts });
  }

  /** (Re)build every routed repo's sandbox image, one at a time, and report one
   *  outcome per repo. Never throws: a repo that cannot be built is a failed outcome
   *  for that repo, and the sweep carries on to the next one.
   *
   *  Always building (not exists-only) is deliberate — docker's layer cache makes an
   *  unchanged rebuild take seconds, while an edited `.sandcastle/Dockerfile` or an
   *  updated local base image is picked up instead of drifting into mystery in-run
   *  failures. */
  async buildImages(table: Record<string, RepoConfig>, parentRoot: string): Promise<ImageOutcome[]> {
    const outcomes: ImageOutcome[] = [];
    for (const [fullName, cfg] of Object.entries(table)) {
      outcomes.push(await this.buildOne(fullName, cfg, parentRoot));
    }
    return outcomes;
  }

  private async buildOne(fullName: string, cfg: RepoConfig, parentRoot: string): Promise<ImageOutcome> {
    const { imageName } = cfg;
    try {
      const childDir = resolve(parentRoot, cfg.path);
      const dockerfile = resolve(childDir, ".sandcastle", "Dockerfile");
      if (isScaffoldPlaceholder(readFileSync(dockerfile, "utf8"))) {
        throw new Error(
          `${dockerfile} still has the scaffold placeholder FROM — edit it (base it on ` +
            `the child's dev image); the repo resumes once it builds`,
        );
      }
      this.log.info(`building ${imageName} for ${fullName} (cached — unchanged images take seconds)`, { repo: fullName });
      await this.buildImage({ fullName, imageName, childDir });
      this.log.info(`${imageName} up to date`, { repo: fullName });
      return { fullName, imageName, status: "built" };
    } catch (err) {
      const reason = describe(err);
      this.log.error(`${fullName}: ${imageName} not built — ${reason}`, { repo: fullName });
      return { fullName, imageName, status: "failed", reason };
    }
  }
}
