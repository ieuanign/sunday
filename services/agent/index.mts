// services/agent/index.mts — THE agent seam: one interface, one operation, and the
// setting that picks an implementation. Everything specific to a coding agent lives
// behind it (the sandbox library, session resume, reasoning effort, token accounting,
// the discipline floor), so no other module has to know which agent it is running.
//
// Nothing here names a type from the agent library — not in the request, not in the
// result, not in what a run throws. That is the whole deliverable: a second agent is a
// new file next to claude.mts, not a refactor of every consumer. zod IS allowed: it is
// how a caller states the shape it wants back, and it is not the sandbox library.
//
// No capability matrix (plan.md decision #15): building both sides of a conditional
// when only one side can execute adds surface without adding confidence.

import type { ZodType } from "zod";

import { ClaudeAgent } from "./claude.mts";
import type { Logger } from "#services/logger.mts";

/** The agents Sunday can run. Sourced from `.env`'s `AGENT`, which v1 declared and
 *  read nowhere (plan.md §2). */
export const AGENTS = ["claude"] as const;
export type AgentName = (typeof AGENTS)[number];

/** What a run is unattended without: the agent every repo gets unless `AGENT` says
 *  otherwise. */
const DEFAULT_AGENT: AgentName = "claude";

/** One repo, as a run needs it. Three fields, not the whole `RepoConfig`: a run does
 *  not read the routing table, and `childDir` is already resolved against the parent
 *  workspace by the time it gets here. */
export interface AgentRepo {
  /** `<owner>/<repo>` — what a log line and a token report are keyed by. */
  fullName: string;
  /** The child checkout the run happens against, absolute. */
  childDir: string;
  /** The sandbox image (services/sandbox.mts built it). */
  imageName: string;
}

/** How the agent must hand its result back. `schema` present → the tag's contents are
 *  JSON, validated against it, and `output` is that object; absent → `output` is the
 *  tag's raw text. The seam carries both so a caller with a JSON contract (the issue
 *  and PR-comment results) never parses the tag itself, and one without a schema still
 *  gets its text. */
export interface AgentOutputContract<T> {
  /** The XML tag the agent wraps its result in (e.g. `sunday-result`). The prompt must
   *  contain the literal — the caller composes the prompt, so the caller owns that. */
  tag: string;
  schema?: ZodType<T>;
}

/** One agent run, fully resolved. Nothing here is looked up again by the agent: the
 *  caller composed the prompt and RESOLVED the start point (`origin/<base>`, never a
 *  bare branch name — v1 proved the library prefers a stale local branch when handed
 *  one, `listener/run-issue.mts:191-196`). */
export interface AgentRunRequest<T = string> {
  /** The work-item key (`<owner>/<repo>#57`, `<owner>/<repo>#pr12`) — what the per-run
   *  floor dir is named for, so concurrent forked runs (ADR-0001) never share one. */
  key: string;
  repo: AgentRepo;
  /** The composed prompt, verbatim. Composition belongs to the run modules (#36/#44). */
  prompt: string;
  /** The branch the agent commits on. */
  branch: string;
  /** The ALREADY-RESOLVED ref the branch starts from, e.g. `origin/main`. */
  startPoint: string;
  /** Where this run's full agent output goes (`lib/paths.mts` names it). */
  logPath: string;
  output: AgentOutputContract<T>;
  /** Continue a prior session instead of starting fresh — the gate resume handle a
   *  previous run returned as `sessionId`. */
  resumeSession?: string;
  /** Reasoning effort for the orchestrator session. A `.env`/config string, so it is
   *  VALIDATED before the run starts rather than trusted — a typo must not cost quota. */
  effort?: string;
  /** Model for the orchestrator session; falls back to `.env`'s `MODEL`. */
  model?: string;
}

/** What one run consumed. Plain numbers — `#37`'s PR footer reports the totals and
 *  `#67`'s handoff threshold reads the context. */
export interface AgentUsage {
  input: number;
  cacheCreation: number;
  cacheRead: number;
  output: number;
  /** `input + cacheRead + cacheCreation` as the session ended: what one more turn on
   *  this session would start from. A session's context only grows, so this is also
   *  its peak. */
  contextTokens: number;
}

/** What a finished run hands back. Every field has a named consumer: `sessionId` is
 *  the gate/resume handle (#36), `usage`/`durationMs`/`commits`/`model` are the PR-body
 *  footer (#37), and `preservedWorktreePath` is what a run's cleanup force-removes
 *  before it can delete the branch (#36). */
export interface AgentRunResult<T = string> {
  /** The parsed structured output the contract asked for. */
  output: T;
  /** Present when the agent supports resume and the session was captured. */
  sessionId?: string;
  usage?: AgentUsage;
  /** The model this run actually ran on, resolved by the implementation — the request's
   *  or its own fallback. Optional because only the implementation knows one: nothing
   *  outside it may read `MODEL`, so a footer that wants to state the model has to be
   *  told, and an agent that cannot say degrades that line rather than fabricating it. */
  model?: string;
  /** SHAs the agent committed during this run. */
  commits: string[];
  /** Set when the run left uncommitted changes and the worktree was kept host-side. */
  preservedWorktreePath?: string;
  durationMs: number;
  logPath: string;
}

/** THE seam. One operation: run this request, hand back plain data. A failure is a
 *  plain `Error` whose message is the agent's — nothing library-shaped escapes, because
 *  #39's classifier reads that text. */
export interface Agent {
  run<T = string>(request: AgentRunRequest<T>): Promise<AgentRunResult<T>>;
}

function isAgentName(name: string): name is AgentName {
  return (AGENTS as readonly string[]).includes(name);
}

/** Pick the implementation `name` asks for. The name is a PARAMETER, never read from
 *  the environment here, so a test never has to set `process.env.AGENT` to drive this.
 *  Unset (or an empty `AGENT=` line) means the default; anything else fails fast naming
 *  what is supported, rather than silently running Claude under another agent's name. */
export function selectAgent(name: string | undefined, logger: Logger): Agent {
  const chosen = name?.trim() || DEFAULT_AGENT;
  if (!isAgentName(chosen)) {
    throw new Error(`AGENT="${chosen}" is not supported — one of ${AGENTS.join(", ")}.`);
  }
  return new ClaudeAgent(logger);
}
