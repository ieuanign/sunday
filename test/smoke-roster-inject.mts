// test/smoke-roster-inject.mts — no-quota smoke for the M5.1b floor injector.
//   devbox run node test/smoke-roster-inject.mts
// Asserts assembleFloor() writes one agent def per roster phase (tracked body +
// the matrix's model/effort applied to frontmatter) + the 3 floor skills, into a
// throwaway dir. Pure host-side — no sandbox, no quota. Proves the model/effort
// OVERRIDE actually rewrites frontmatter (reviewer: tracked xhigh → roster high).

import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { assembleFloor } from "../listener/roster-inject.mts";
import { loadRoster, PHASES } from "../config/roster.mts";

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : `\n    ${detail}`}`);
};

const fm = (md: string, key: string): string | undefined =>
  md.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim();

const dest = resolve(import.meta.dirname, "smoke-floor");
const roster = loadRoster();
const { agentsDir, skillsDir } = assembleFloor(dest, roster);

// ── one agent def per phase, with the matrix's model/effort in frontmatter ──
for (const phase of PHASES) {
  const { agent, model, effort } = roster[phase];
  const p = resolve(agentsDir, `${agent}.md`);
  if (!existsSync(p)) {
    ok(`${phase}: ${agent}.md written`, false, p);
    continue;
  }
  const md = readFileSync(p, "utf8");
  ok(
    `${phase}: ${agent} → model ${model} / effort ${effort}`,
    fm(md, "model") === model && fm(md, "effort") === effort,
    `got model=${fm(md, "model")} effort=${fm(md, "effort")}`,
  );
  ok(`${phase}: ${agent} body preserved (has a name:)`, fm(md, "name") === agent);
}

// ── the override actually rewrote frontmatter (reviewer: tracked xhigh → high) ──
{
  const tracked = readFileSync(resolve(import.meta.dirname, "..", ".claude/agents/reviewer.md"), "utf8");
  const injected = readFileSync(resolve(agentsDir, "reviewer.md"), "utf8");
  ok("override: reviewer tracked effort is xhigh", fm(tracked, "effort") === "xhigh", fm(tracked, "effort"));
  ok("override: injected reviewer effort is high", fm(injected, "effort") === "high", fm(injected, "effort"));
}

// ── the 3 floor skills copied ──
for (const s of ["tdd", "code-review-mp", "diagnosing-bugs"]) {
  ok(`skill: ${s}/SKILL.md present`, existsSync(resolve(skillsDir, s, "SKILL.md")));
}

rmSync(dest, { recursive: true, force: true });
console.log(fails === 0 ? "\nAll roster-inject smokes pass." : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
