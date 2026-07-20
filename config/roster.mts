// config/roster.mts — Sunday's per-phase model/effort matrix (M5.1).
//
// The tuning surface for the in-sandbox discipline roster: one row per phase,
// each naming the sub-agent it dispatches to plus the model + reasoning effort to
// run that phase at. The listener merges these onto the tracked agent BODIES
// (.claude/agents/<agent>.md) at inject time (M5.1b) — bodies are the single
// discipline source; this file is the knob you edit to retune a phase.
//
// Unlike config/repos.json (gitignored — carries private child names), this file
// is generic and TRACKED: it ships Sunday's default matrix, no child specifics.
// The `.env` MODEL / MODEL_EFFORT stay the GLOBAL fallback (the orchestrator's own
// model/effort, and what a phase degrades to when its row is absent).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** The five roster phases, in dispatch order (sandbox-prompt.md §2). */
export const PHASES = ["plan", "implement", "review", "debug", "signoff"] as const;
export type Phase = (typeof PHASES)[number];

/** Reasoning-effort levels a phase can run at (Claude Code sub-agent `effort:`
 *  frontmatter — low..max; overrides the session/orchestrator effort). */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/** Type guard: is `x` one of the valid effort levels? Used to validate the roster
 *  and the `.env` MODEL_EFFORT before either reaches Sandcastle. */
export function isEffort(x: unknown): x is Effort {
  return typeof x === "string" && (EFFORTS as readonly string[]).includes(x);
}

export interface RosterEntry {
  /** The sub-agent this phase dispatches to (the tracked `.claude/agents/<agent>.md`
   *  whose body is injected, e.g. "architecture-engineer"). */
  agent: string;
  /** Model alias for this phase (e.g. "opus" | "sonnet" | "haiku"). Written into
   *  the injected sub-agent's `model:` frontmatter. */
  model: string;
  /** Reasoning effort for this phase (written into `effort:` frontmatter). */
  effort: Effort;
}

export type Roster = Record<Phase, RosterEntry>;

const rosterPath = resolve(import.meta.dirname, "roster.json");

/** Load + validate the matrix. Throws on a missing phase or a malformed entry. */
export function loadRoster(): Roster {
  const table = JSON.parse(readFileSync(rosterPath, "utf8")) as Record<
    string,
    Partial<RosterEntry>
  >;
  for (const phase of PHASES) {
    const entry = table[phase];
    if (!entry) {
      throw new Error(`config/roster.json: missing phase "${phase}"`);
    }
    for (const key of ["agent", "model"] as const) {
      if (typeof entry[key] !== "string" || entry[key]!.length === 0) {
        throw new Error(
          `config/roster.json: ${phase}.${key} must be a non-empty string`,
        );
      }
    }
    if (!isEffort(entry.effort)) {
      throw new Error(
        `config/roster.json: ${phase}.effort must be one of ${EFFORTS.join(", ")}`,
      );
    }
  }
  return table as Roster;
}
