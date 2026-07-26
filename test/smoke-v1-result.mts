// test/smoke-v1-result.mts — hermetic smoke for what v1 accepts as an agent result
// during the #37 rename window. V2 renames the prose field `summary` → `description`
// in docs/sandbox-prompt.md — which is not documentation but the LIVE baseline prompt
// for every routed repo (config/repos.json → promptFile), and `devbox services up`
// still runs that prompt through THIS listener until #45 cuts over. So v1 has to parse
// both names before the prompt is renamed, or the rename silently kills every running
// run at its last step (a valid result read as malformed → one wasted retry → failure).
//   devbox run node test/smoke-v1-result.mts
// Deleted with the rest of listener/ at cutover. $0, offline, no docker, no network.

import { resultSchema } from "../listener/run-issue.mts";

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : `\n    ${detail}`}`);
};

// ── the renamed field parses, and lands where the run reads its prose ──
{
  const r = resultSchema.safeParse({ signal: "ready", description: "renamed the field" });
  ok("description: parses", r.success, JSON.stringify(r.error?.issues));
  ok("description: carried as the run's prose", r.data?.description === "renamed the field", JSON.stringify(r.data));
}

// ── the old field still parses: the prompt has not been renamed yet at this commit,
//    and a gate resumed across the cutover replies in whichever name it was told ──
{
  const r = resultSchema.safeParse({ signal: "gate", summary: "old name", question: "which base?" });
  ok("summary: still parses", r.success, JSON.stringify(r.error?.issues));
  ok("summary: read as the run's prose", r.data?.description === "old name", JSON.stringify(r.data));
  ok("summary: question survives", r.data?.question === "which base?", JSON.stringify(r.data));
}

// ── both emitted → the new name wins (v1 is the one being retired, not the contract) ──
{
  const r = resultSchema.safeParse({ signal: "fail", summary: "old", description: "new" });
  ok("both: description preferred", r.data?.description === "new", JSON.stringify(r.data));
}

// ── neither → still malformed. Accepting the new name must not make the prose
//    optional: an empty PR body is worse than the one automatic re-emit. ──
{
  const r = resultSchema.safeParse({ signal: "ready" });
  ok("neither: rejected (agent gets its retry)", !r.success, JSON.stringify(r.data));
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
