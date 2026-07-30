// services/agent/floor.mts — assemble the per-run discipline floor (was v1's
// listener/roster-inject.mts).
//
// Sunday's floor is the tracked `.claude/agents/*.md` (the real sub-agents) + the
// tracked floor skills — one discipline source. `config/roster.*` is the per-phase
// model/effort MATRIX. This module merges them: for each roster phase it reads the
// tracked agent BODY, overrides only its `model:`/`effort:` frontmatter from the
// matrix row, and writes it to a per-work-item dir; it copies the floor skills
// alongside. The agent implementation (services/agent/claude.mts) mounts the result
// read-write at `~/.claude` (the sandbox USER level), so a child's own project-level
// `.claude/` overrides by presence (Claude Code project>user name-based shadowing —
// proven via the probe `.scratch/probe-mount.mts`: the mounted sub-agents dispatch and
// the mounted skills load inside headless `claude -p`).

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { loadRoster, PHASES, type Roster } from "#config/roster.mts";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const trackedAgentsDir = resolve(repoRoot, ".claude", "agents");
const trackedSkillsDir = resolve(repoRoot, ".claude", "skills");

/** The floor skills injected into every run: the three the agents preload via
 *  `skills:[…]` frontmatter, plus the two a PROMPT invokes by name (`/implement` in
 *  `docs/sandbox-pr-comment-prompt.md` §3, `/handoff` in `issue/prompt.mts`). NOT the
 *  whole `.claude/skills/` — only the floor. Exported so the smoke asserts the mounted
 *  set against the prompts that name them: a prompt naming a skill nobody mounted spends
 *  a whole run being ignored. */
export const FLOOR_SKILLS = ["tdd", "code-review-mp", "diagnosing-bugs", "implement", "handoff"] as const;

/** Set (or insert) a `key: value` line inside the leading `---…---` frontmatter of a
 *  Markdown agent def. Only the frontmatter is touched — the body is untouched. */
function setFrontmatter(md: string, key: string, value: string): string {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) throw new Error("floor: agent def is missing YAML frontmatter");
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

/** Where one work item's floor is assembled: throwaway by construction (`.scratch/` is
 *  `rm -rf`-able, plan.md decision #7) and one dir per work-item key
 *  (`<owner>/<repo>#<issue>`), because forked runs happen concurrently (ADR-0001) and
 *  must not share a floor. Everything outside `[A-Za-z0-9._-]` becomes `-`, so the
 *  key's `/` and `#` can never nest a dir or walk out of `.scratch/`. Names the path
 *  and creates nothing — `assembleFloor` makes its own dir. */
export function floorDir(key: string): string {
  return resolve(repoRoot, ".scratch", "floor", key.replace(/[^A-Za-z0-9._-]/g, "-"));
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
        `floor: roster phase "${phase}" → agent "${agent}" has no .claude/agents/${agent}.md`,
      );
    }
    md = setFrontmatter(md, "model", model);
    md = setFrontmatter(md, "effort", effort);
    writeFileSync(resolve(agentsDir, `${agent}.md`), md, "utf8");
  }

  for (const skill of FLOOR_SKILLS) {
    const dir = resolve(skillsDir, skill);
    cpSync(resolve(trackedSkillsDir, skill), dir, { recursive: true });
    // `implement` and `handoff` are tracked `disable-model-invocation: true` — on the host
    // a human types those. In the sandbox there is no human: the prompt names the skill and
    // the agent has to be able to invoke it, so the MOUNTED copy re-enables it. A no-op
    // insert on the three that never disabled it, so no skill needs special-casing here.
    const md = resolve(dir, "SKILL.md");
    writeFileSync(md, setFrontmatter(readFileSync(md, "utf8"), "disable-model-invocation", "false"), "utf8");
  }

  return { dir: destRoot, agentsDir, skillsDir };
}
