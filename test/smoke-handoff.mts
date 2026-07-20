// test/smoke-handoff.mts — no-quota smoke for the M5.2 pure pieces.
//   devbox run node test/smoke-handoff.mts
// Covers: handoffInstructions() (reuses /handoff SKILL.md, frontmatter stripped,
// save-to-file line swapped for emit-as-tag), classify()'s summarize-failed class
// (D4b, clear message preserved), and the handoff doc path + cleanup glob.
// The threshold fork itself needs a live run (owed) — these are the host-side bits.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  handoffInstructions,
  HANDOFF_TAG,
  handoffDocPath,
  cleanupHandoffs,
} from "../listener/helper.mts";
import { classify } from "../listener/classify.mts";

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : `\n    ${detail}`}`);
};

// ── handoffInstructions: reuse the skill text, adapted for the sandbox ──
{
  const p = handoffInstructions();
  ok("handoff: frontmatter stripped (no disable-model-invocation)", !p.includes("disable-model-invocation"));
  ok("handoff: reuses skill body (mentions suggested skills)", /suggested skills/i.test(p));
  ok("handoff: OS-temp save line swapped out", !/Save to the temporary directory of the user's OS/i.test(p));
  ok(`handoff: emits inside <${HANDOFF_TAG}> tag`, p.includes(`<${HANDOFF_TAG}>`));
  ok("handoff: forbids writing files/commits", /write no code|no files|make no commits/i.test(p));
}

// ── classify: SUMMARIZE_FAILED → summarize-failed, P2, clear message preserved ──
{
  const msg = "couldn't compact an oversized session (≥120000 ctx) for owner/repo#5 into a handoff note — the old session was not reused; a retry starts fresh.";
  const e = classify({ error: new Error(`SUMMARIZE_FAILED: ${msg}`) });
  ok("classify: class summarize-failed", e.class === "summarize-failed", e.class);
  ok("classify: severity P2", e.severity === "P2", e.severity);
  ok("classify: clear message preserved (prefix stripped)", e.summary === msg, e.summary);
  // a plain run failure must NOT be misread as summarize-failed
  ok("classify: unrelated error unaffected", classify({ error: new Error("boom") }).class === "unknown");
}

// ── handoffDocPath + cleanupHandoffs ──
{
  const repo = "smoke-owner/smoke-repo";
  const p1 = handoffDocPath(repo, "5", 1);
  const p2 = handoffDocPath(repo, "5", 2);
  ok("path: <issue>-<n>.md under .scratch/<repo>/handoff", p2.endsWith("smoke-owner/smoke-repo/handoff/5-2.md"), p2);
  writeFileSync(p1, "n1", "utf8");
  writeFileSync(p2, "n2", "utf8");
  const other = resolve(p2, "..", "6-1.md");
  writeFileSync(other, "keep", "utf8");
  cleanupHandoffs(repo, "5");
  ok("cleanup: removed 5-*.md", !existsSync(p1) && !existsSync(p2));
  ok("cleanup: kept another issue's 6-1.md", existsSync(other));
  // tidy up the smoke dir
  const { rmSync } = await import("node:fs");
  rmSync(resolve(import.meta.dirname, "..", ".scratch", "smoke-owner"), { recursive: true, force: true });
}

console.log(fails === 0 ? "\nAll handoff smokes pass." : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
