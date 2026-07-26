// services/agent/claude.mts — the one Agent implementation, and one of only two files
// allowed to import the sandbox library (the other is services/sandbox.mts).
//
// Everything Claude-specific stops here: the library's run options, reasoning effort,
// session resume, the discipline floor, and the token accounting the run's session file
// feeds. What leaves this file is plain data, and what LEAVES IT ON A FAILURE is a plain
// `Error` carrying the library's message — #39's classifier reads that text, and a
// library error class escaping the seam would make the classifier depend on the library
// too.
//
// Deliberately NOT here: composing the prompt, resolving the start point, and anything
// that touches the child's host git state. The caller hands those in already resolved
// (v1 proved the library prefers a stale local branch when handed a bare branch name),
// and the run modules (#36/#44) own them.

import { rmSync } from "node:fs";
import { claudeCode, Output, run as sandcastleRun } from "@ai-hero/sandcastle";

import { SandboxService, type SandboxHandle } from "#services/sandbox.mts";
import { assembleFloor, floorDir } from "./floor.mts";
import { emitReport } from "./token-report.mts";
import type { Logger, ModuleLogger } from "#services/logger.mts";
import type { Agent, AgentRunRequest, AgentRunResult, AgentUsage } from "./index.mts";
import { EFFORTS, isEffort, type Effort } from "#config/roster.mts";

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The orchestrator session's reasoning effort: the request's, else `.env`'s global
 *  fallback, else the model's own default. Validated HERE rather than trusted, because
 *  both sources are hand-edited text and a run costs minutes of quota. */
function resolveEffort(requested: string | undefined): Effort | undefined {
  const raw = (requested ?? process.env.MODEL_EFFORT)?.trim();
  if (!raw) return undefined;
  if (!isEffort(raw)) {
    throw new Error(`effort "${raw}" is invalid — one of ${EFFORTS.join(", ")}.`);
  }
  return raw;
}

/** The library's per-iteration usage snapshot, as plain totals. Structurally typed on
 *  purpose: naming the library's type here would put it in this module's exports by
 *  inference. */
function usageOf(u: {
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
}): AgentUsage {
  return {
    input: u.inputTokens,
    cacheCreation: u.cacheCreationInputTokens,
    cacheRead: u.cacheReadInputTokens,
    output: u.outputTokens,
    contextTokens: u.inputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens,
  };
}

export class ClaudeAgent implements Agent {
  // Declared, not parameter properties: Node runs `.mts` in strip-only mode, which
  // rejects `constructor(private x)`.
  private readonly log: ModuleLogger;
  private readonly sandbox: SandboxService;

  constructor(logger: Logger) {
    this.log = logger.child("agent");
    this.sandbox = new SandboxService(logger);
  }

  async run<T = string>(request: AgentRunRequest<T>): Promise<AgentRunResult<T>> {
    // Both settings are validated before anything is assembled, spawned or spent: a
    // typo must cost nothing (listener/run-issue.mts:140-147).
    const model = request.model ?? process.env.MODEL;
    if (!model) {
      throw new Error("MODEL is unset — load .env first (node --env-file=.env …).");
    }
    const effort = resolveEffort(request.effort);

    // One floor per work item, assembled fresh and removed however this ends: `.scratch/`
    // is throwaway (plan.md decision #7) and concurrent forked runs (ADR-0001) must not
    // share a floor dir.
    const floorRoot = floorDir(request.key);
    const startedAt = Date.now();
    try {
      // A SINGLE read-write `~/.claude` mount, never two read-only sub-mounts: two make
      // Docker create the parent root-owned, the agent user cannot write
      // `~/.claude/projects/`, and session capture — and with it resume — fails. Probe
      // result, not preference (see Floor in ./floor.mts).
      const { dir } = assembleFloor(floorRoot);
      const sandbox = this.sandbox.forImage(request.repo.imageName, [
        { hostPath: dir, sandboxPath: "~/.claude", readonly: false },
      ]);

      this.log.info(
        `▶ ${request.branch} from ${request.startPoint} in ${request.repo.imageName} ` +
          `(${model}${effort ? `, effort ${effort}` : ""}${request.resumeSession ? ", resume" : ""}) → ${request.logPath}`,
        { repo: request.repo.fullName },
      );

      const result = await this.invoke(request, sandbox, model, effort);

      const last = result.iterations.at(-1);
      const sessionId = last?.sessionId;
      // The run is over and succeeded; accounting rides on the back of it and never
      // throws (see emitReport).
      if (sessionId && last?.sessionFilePath) {
        emitReport(this.log, request.repo.fullName, last.sessionFilePath, sessionId);
      }
      return {
        // Sound by the contract: with a schema the library returns that schema's type,
        // and without one `T` is the interface's `string` default.
        output: result.output as T,
        sessionId,
        usage: last?.usage ? usageOf(last.usage) : undefined,
        // The RESOLVED model, not the request's: the fallback to `.env`'s `MODEL` happens
        // here and nowhere else, so this is the only place that can say what actually ran.
        model,
        commits: result.commits.map((c) => c.sha),
        preservedWorktreePath: result.preservedWorktreePath,
        durationMs: Date.now() - startedAt,
        logPath: request.logPath,
      };
    } catch (err) {
      // Re-thrown PLAIN, message preserved and no `cause`: nothing library-shaped may
      // escape the seam — a `StructuredOutputError` reaching #39's classifier would make
      // the classifier import the library too — and the MESSAGE is what it matches on.
      throw new Error(describe(err));
    } finally {
      rmSync(floorRoot, { recursive: true, force: true });
    }
  }

  /** The library call itself. The two output shapes are the same run with a different
   *  contract: a schema means the tag carries JSON to validate, no schema means the
   *  tag's raw text is the result. One automatic re-emit (`maxRetries: 1`) covers an
   *  agent that malformed its tag. */
  private async invoke<T>(
    request: AgentRunRequest<T>,
    sandbox: SandboxHandle,
    model: string,
    effort: Effort | undefined,
  ) {
    const { tag, schema } = request.output;
    const options = {
      agent: claudeCode(model, effort ? { effort } : undefined),
      sandbox,
      cwd: request.repo.childDir,
      prompt: request.prompt,
      branchStrategy: { type: "branch", branch: request.branch, baseBranch: request.startPoint },
      logging: { type: "file", path: request.logPath },
      ...(request.resumeSession ? { resumeSession: request.resumeSession } : {}),
    } as const;
    return schema
      ? await sandcastleRun({ ...options, output: Output.object({ tag, schema, maxRetries: 1 }) })
      : await sandcastleRun({ ...options, output: Output.string({ tag, maxRetries: 1 }) });
  }
}
