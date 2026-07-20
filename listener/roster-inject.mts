// listener/roster-inject.mts — assemble the per-run discipline floor (M5.1b).
//
// Sunday's floor is the tracked `.claude/agents/*.md` (the real sub-agents) + the 3
// tracked floor skills — one discipline source. `config/roster.*` is the per-phase
// model/effort MATRIX. This module merges them: for each roster phase it reads the
// tracked agent BODY, overrides only its `model:`/`effort:` frontmatter from the
// matrix row, and writes it to a per-run dir; it copies the floor skills alongside.
// run-issue.mts mounts the two dirs read-only at `~/.claude/{agents,skills}` (the
// sandbox USER level), so a child's own project-level `.claude/` overrides by
// presence (Claude Code project>user name-based shadowing — proven via the probe
// `.scratch/probe-mount.mts`: the mounted sub-agents dispatch and the mounted skills
// load inside headless `claude -p`).

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { loadRoster, PHASES, type Roster } from "#config/roster.mts";

const parentRoot = resolve(import.meta.dirname, "..");
const trackedAgentsDir = resolve(parentRoot, ".claude", "agents");
const trackedSkillsDir = resolve(parentRoot, ".claude", "skills");

/** The floor skills injected into every run (the agents preload them via
 *  `skills:[…]` frontmatter). NOT the whole `.claude/skills/` — only the floor. */
const FLOOR_SKILLS = ["tdd", "code-review-mp", "diagnosing-bugs"] as const;

/** Set (or insert) a `key: value` line inside the leading `---…---` frontmatter of a
 *  Markdown agent def. Only the frontmatter is touched — the body is untouched. */
function setFrontmatter(md: string, key: string, value: string): string {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) throw new Error("roster-inject: agent def is missing YAML frontmatter");
  const block = m[1];
  const re = new RegExp(`^${key}:.*$`, "m");
  const line = `${key}: ${value}`;
  const next = re.test(block) ? block.replace(re, line) : `${block}\n${line}`;
  return md.replace(block, next);
}

export interface Floor {
  /** Mount this **read-write at `~/.claude`** (it holds `agents/` + `skills/`, and
   *  claude also writes `projects/` etc. here at runtime). A SINGLE `~/.claude` mount
   *  is deliberate: two separate `~/.claude/{agents,skills}` bind-mounts make Docker
   *  auto-create the parent `~/.claude` ROOT-owned, so the agent user (501) can't
   *  write `~/.claude/projects/` and Sandcastle's session capture fails (proven via
   *  `.scratch/probe-sandcastle-mount.mts`). rw is required — a read-only `~/.claude`
   *  would block the session write too. */
  dir: string;
  agentsDir: string;
  skillsDir: string;
}

/**
 * Assemble the per-run floor under `destRoot`: one `agents/<agent>.md` per roster
 * phase (tracked body + matrix model/effort) and `skills/<name>/` for each floor
 * skill. Wipes `destRoot` first so a re-run (resume) never inherits a stale def.
 * Throws if a phase names an agent with no tracked def (fail fast — the roster and
 * `.claude/agents/` must agree).
 */
export function assembleFloor(destRoot: string, roster: Roster = loadRoster()): Floor {
  const agentsDir = resolve(destRoot, "agents");
  const skillsDir = resolve(destRoot, "skills");
  rmSync(destRoot, { recursive: true, force: true });
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(skillsDir, { recursive: true });

  for (const phase of PHASES) {
    const { agent, model, effort } = roster[phase];
    let md: string;
    try {
      md = readFileSync(resolve(trackedAgentsDir, `${agent}.md`), "utf8");
    } catch {
      throw new Error(
        `roster-inject: roster phase "${phase}" → agent "${agent}" has no .claude/agents/${agent}.md`,
      );
    }
    md = setFrontmatter(md, "model", model);
    md = setFrontmatter(md, "effort", effort);
    writeFileSync(resolve(agentsDir, `${agent}.md`), md, "utf8");
  }

  for (const skill of FLOOR_SKILLS) {
    cpSync(resolve(trackedSkillsDir, skill), resolve(skillsDir, skill), { recursive: true });
  }

  return { dir: destRoot, agentsDir, skillsDir };
}
