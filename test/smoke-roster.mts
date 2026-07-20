// test/smoke-roster.mts — no-quota smoke for the M5.1a roster matrix + loader.
//   devbox run node test/smoke-roster.mts
// Asserts the tracked config/roster.json parses to the 5-phase matrix with valid
// model/effort, and the shared isEffort guard (used to validate .env MODEL_EFFORT
// before it reaches Sandcastle). Pure host-side — no sandbox, no quota.

import { loadRoster, isEffort, PHASES, EFFORTS } from "../config/roster.mts";

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : `\n    ${detail}`}`);
};

const roster = loadRoster();

// ── all five phases present, in order ──
ok("phases: all five present", PHASES.every((p) => roster[p] !== undefined), Object.keys(roster).join(","));

// ── the spec's starting matrix (issue #11 Part 1) ──
const expected = {
  plan: { agent: "architecture-engineer", model: "opus", effort: "max" },
  implement: { agent: "code-writer", model: "opus", effort: "xhigh" },
  review: { agent: "reviewer", model: "sonnet", effort: "high" },
  debug: { agent: "debugger", model: "opus", effort: "xhigh" },
  signoff: { agent: "sign-off", model: "sonnet", effort: "medium" },
} as const;
for (const p of PHASES) {
  const e = roster[p];
  const x = expected[p];
  ok(`${p}: ${x.agent} ${x.model}/${x.effort}`, e.agent === x.agent && e.model === x.model && e.effort === x.effort, JSON.stringify(e));
}

// ── every effort is a valid level ──
ok("efforts: all valid", PHASES.every((p) => EFFORTS.includes(roster[p].effort)));

// ── isEffort guard (the MODEL_EFFORT validator) ──
ok("isEffort: accepts every level", EFFORTS.every((e) => isEffort(e)));
ok("isEffort: rejects a typo", !isEffort("ultra") && !isEffort("HIGH") && !isEffort("") && !isEffort(undefined));

console.log(fails === 0 ? "\nAll roster smokes pass." : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
