// config/repos.mts — Sunday's per-repo routing table (M2).
//
// Maps a GitHub `repository.full_name` (exactly as webhook payloads carry it,
// e.g. "owner/repo") to how Sunday runs that child. Real entries live in the
// gitignored config/repos.json; config/repos.example.json is the tracked
// template — no private child names in the public repo.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface RepoConfig {
  /** Child checkout dir, relative to the parent workspace root. */
  path: string;
  /** Pre-built sandbox image (per the onboarding recipe). */
  imageName: string;
  /** Baseline prompt the listener composes the issue onto, relative to root. */
  promptFile: string;
  /** ALL must be present on an issue to admit it (AND). */
  triggerLabels: string[];
}

const configPath = resolve(import.meta.dirname, "repos.json");

/** Load + validate the routing table. Throws on a malformed entry. */
export function loadRepos(): Record<string, RepoConfig> {
  const table = JSON.parse(readFileSync(configPath, "utf8")) as Record<
    string,
    RepoConfig
  >;
  for (const [fullName, cfg] of Object.entries(table)) {
    for (const key of ["path", "imageName", "promptFile"] as const) {
      if (typeof cfg?.[key] !== "string" || cfg[key].length === 0) {
        throw new Error(
          `config/repos.json: ${fullName}.${key} must be a non-empty string`,
        );
      }
    }
    if (!Array.isArray(cfg.triggerLabels) || cfg.triggerLabels.length === 0) {
      throw new Error(
        `config/repos.json: ${fullName}.triggerLabels must be a non-empty array`,
      );
    }
  }
  return table;
}
