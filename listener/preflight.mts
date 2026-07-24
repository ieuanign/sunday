// listener/preflight.mts — boot sandbox-image preflight.
//
// Root-caused from the 2026-07-24 fail-safe halt: finance was in the routing
// table but its sandbox image was never built, so the first admitted issue died
// mid-run as a Provider create failure (class `unknown` → pipeline halt). Boot
// now (re)builds EVERY configured image from the child's `.sandcastle/` — the
// same `sandcastle docker build-image` the onboarding recipe runs by hand.
// Always building (not exists-only) keeps images fresh too: docker's layer
// cache makes an unchanged rebuild take seconds, while a `.sandcastle/`
// Dockerfile edit or an updated local base image (`FROM <child>-dev`) is picked
// up instead of silently drifting into mystery in-run failures.
//
// Shape constraints (why this isn't a simple sync call at module top):
//   - A build takes minutes; blocking before server.listen() starves the
//     readiness probe and process-compose SIGKILLs the boot (see helper.mts on
//     the reconcile sweep). So builds are async; listen.mts sequences them after
//     listen() but before reconcile, holding the scheduler paused meanwhile.
//   - A build failure must NOT throw out of boot — under `restart: always` that
//     is an infinite rebuild loop. listen.mts converts it to a durable setup
//     halt instead (same act-layer semantics as a mid-run create failure).
//   - listen.mts also re-runs this from its setup-halt watcher (with a freshly
//     re-read repos.json), so a fixed environment self-resumes the pipeline.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { RepoConfig } from "#config/repos.mts";

/** Pure: an unedited `sandcastle init` Dockerfile — its FROM is still the
 *  scaffold placeholder, so building it can only fail; the actionable fix is
 *  editing the Dockerfile, not retrying the build. */
export function isScaffoldPlaceholder(dockerfile: string): boolean {
  return dockerfile.includes("your-child-dev-image");
}

/** (Re)build every configured repo's sandbox image via its `.sandcastle/`.
 *  Sequential (one docker build at a time), streaming progress to the console.
 *  Throws with an actionable message on a placeholder Dockerfile or a failed
 *  build. */
export async function buildSandboxImages(table: Record<string, RepoConfig>, parentRoot: string): Promise<void> {
  for (const [fullName, cfg] of Object.entries(table)) {
    const childDir = resolve(parentRoot, cfg.path);
    const dockerfile = resolve(childDir, ".sandcastle", "Dockerfile");
    if (isScaffoldPlaceholder(readFileSync(dockerfile, "utf8"))) {
      throw new Error(
        `${fullName}: ${dockerfile} still has the scaffold placeholder FROM — ` +
          `edit it (base it on the child's dev image); the pipeline resumes once it builds`,
      );
    }
    console.log(`⏳ preflight: building ${cfg.imageName} for ${fullName} (cached — unchanged images take seconds)`);
    await new Promise<void>((res, rej) => {
      const p = spawn(
        resolve(parentRoot, "node_modules/.bin/sandcastle"),
        ["docker", "build-image", "--image-name", cfg.imageName],
        { cwd: childDir, stdio: ["ignore", "inherit", "inherit"] },
      );
      p.on("error", rej);
      p.on("close", (code) =>
        code === 0
          ? res()
          : rej(new Error(`${fullName}: sandcastle docker build-image (${cfg.imageName}) exited ${code}`)),
      );
    });
    console.log(`✓ preflight: ${cfg.imageName} up to date`);
  }
}
