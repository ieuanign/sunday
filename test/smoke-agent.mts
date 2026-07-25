// test/smoke-agent.mts — hermetic smoke for the agent seam (V2, issue #33).
//   devbox run node test/smoke-agent.mts
// What can be wrong here without spending quota: which implementation the AGENT setting
// selects, what an unsupported setting says, and what is refused BEFORE a run starts.
// What the implementation hands the agent library is deliberately NOT asserted — that
// is wiring (spec.md: it breaks on every refactor and catches nothing), and the staged
// cutover (#45) is what proves a real run. $0, offline, no docker, no tokens.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { Logger, type Destinations } from "../services/logger.mts";
import { ClaudeAgent } from "../services/agent/claude.mts";
import { floorDir } from "../services/agent/floor.mts";
import { selectAgent, type AgentRunRequest } from "../services/agent/index.mts";
import { EFFORTS } from "#config/roster.mts";

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : `\n    ${detail}`}`);
};

/** A real Logger with every sink dropped: these assertions are about what the seam
 *  decides, not what it says. */
function silentLogger(): Logger {
  const drop = () => {};
  const dests: Destinations = { console: drop, runLog: drop, eventLog: drop, github: drop, phone: drop };
  return new Logger(dests);
}

// ── selection: the AGENT setting finally picks something (v1 read it nowhere) ──
{
  const log = silentLogger();
  ok("selection: AGENT=claude selects the Claude implementation", selectAgent("claude", log) instanceof ClaudeAgent);
  ok("selection: an unset AGENT defaults to Claude", selectAgent(undefined, log) instanceof ClaudeAgent);
  ok("selection: an empty AGENT= line defaults to Claude", selectAgent("", log) instanceof ClaudeAgent);
}

// ── an unsupported agent is refused, saying what IS supported ──
{
  const log = silentLogger();
  let thrown: unknown;
  try {
    selectAgent("gemini", log);
  } catch (err) {
    thrown = err;
  }
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  ok("selection: an unsupported AGENT fails rather than silently running the default", thrown !== undefined);
  ok("selection: the failure quotes the value it was given", message.includes("gemini"), message);
  ok("selection: the failure names what IS supported", message.includes("claude"), message);
}

/** A fully-resolved request for a repo that does not exist: every assertion below is
 *  about a run that must be refused BEFORE it goes anywhere near a container. */
function request(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    key: "acme/finance#57",
    repo: {
      fullName: "acme/finance",
      childDir: resolve(import.meta.dirname, "..", ".scratch", "no-such-child"),
      imageName: "finance-sandbox",
    },
    prompt: "<sunday-result> …",
    branch: "feat/57",
    startPoint: "origin/main",
    logPath: resolve(import.meta.dirname, "..", ".scratch", `smoke-agent-${process.pid}.log`),
    output: { tag: "sunday-result" },
    model: "claude-opus-4-8",
    ...overrides,
  };
}

const rejection = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
};

// ── a run whose settings are already wrong never reaches the sandbox ──
// v1 validated MODEL_EFFORT up front for exactly this reason: a typo must fail before
// quota is spent, not eleven minutes into a run (listener/run-issue.mts:140-147).
{
  const agent = selectAgent("claude", silentLogger());
  const key = "acme/finance#effort";
  const message = await rejection(agent.run(request({ key, effort: "turbo" })));

  ok("effort: a typo'd effort is refused", message !== "", "the run was not refused");
  ok("effort: the refusal quotes the value it was given", message.includes("turbo"), message);
  ok(
    "effort: the refusal names every level that IS valid",
    EFFORTS.every((e) => message.includes(e)),
    message,
  );
  ok(
    "effort: refused before the run starts — no floor was even assembled",
    !existsSync(floorDir(key)),
    floorDir(key),
  );
}

// ── …and neither does a run with no model at all ──
{
  // The seam falls back to `.env`'s global MODEL when the request omits one; unsetting
  // it here is what makes the fallback's absence deterministic in this subprocess.
  delete process.env.MODEL;
  const agent = selectAgent("claude", silentLogger());
  const key = "acme/finance#model";
  const message = await rejection(agent.run(request({ key, model: undefined })));

  ok("model: a run with no model is refused, naming MODEL", message.includes("MODEL"), message || "the run was not refused");
  ok("model: refused before the run starts — no floor was even assembled", !existsSync(floorDir(key)), floorDir(key));
}

// ── the boundary: the sandbox library is behind the seam, not spread through the tree ──
// The seam is only worth having if it holds, and "no module outside the implementation
// references the sandbox library" is otherwise a claim nobody rechecks. A scan, not a new
// lint script — the repo's smokes are where this kind of rule already lives.
{
  const repoRoot = resolve(import.meta.dirname, "..");
  /** The two files plan.md gives the library to: the implementation, and the service
   *  that owns containers and images. */
  const ALLOWED = ["services/agent/claude.mts", "services/sandbox.mts"];
  /** `listener/` is v1, which imports it and is deleted at cutover (#45); `repos/` holds
   *  child clones that are not this repo's code. */
  const SKIP = new Set(["node_modules", "listener", "repos"]);
  const IMPORTS_LIBRARY = /(?:from|import|require)\s*\(?\s*["']@ai-hero\/sandcastle/;

  const importers: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !SKIP.has(entry.name)) walk(path);
      } else if (entry.name.endsWith(".mts") && IMPORTS_LIBRARY.test(readFileSync(path, "utf8"))) {
        importers.push(relative(repoRoot, path));
      }
    }
  };
  walk(repoRoot);

  // Without this, a scan that found nothing at all would pass the next assertion.
  ok(
    "boundary: the scan does find the two files that own the library",
    ALLOWED.every((f) => importers.includes(f)),
    importers.join(", "),
  );
  const leaked = importers.filter((f) => !ALLOWED.includes(f));
  ok(
    "boundary: nothing else imports the sandbox library — a second agent is a new file, not a refactor",
    leaked.length === 0,
    leaked.join(", "),
  );
}

console.log(fails === 0 ? "\nAll agent-seam smokes pass." : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
