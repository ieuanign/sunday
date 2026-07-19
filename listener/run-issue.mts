// listener/run-issue.mts — the shared per-issue action (M2, steps 3 + 5).
//
// The ONE place M1's compose → run → decide lives. Both the one-shot CLI
// (run-one.mts) and the listener call this — they must not drift. The sandbox
// DECIDES (plan → test → implement → commit → emit a signal); this host does
// ALL I/O (push, PR, comment, label) from that signal.

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { run, claudeCode, Output } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { z } from "zod";

import {
  sh,
  deleteLocalBranch,
  runLogPath,
  sundayComment,
  SUNDAY_SIGN,
  handoffInstructions,
  handoffDocPath,
  cleanupHandoffs,
  HANDOFF_TAG,
} from "./helper.mts";
import { assembleFloor } from "./roster-inject.mts";
import { emitReport } from "./token-report.mts";
import { sendTelegram } from "./telegram.mts";
import type { RepoConfig } from "#config/repos.mts";
import { isEffort, EFFORTS, type Effort } from "#config/roster.mts";

const parentRoot = resolve(import.meta.dirname, "..");

/** Does a ref resolve in the child repo? (`rev-parse --verify` exits non-zero when
 *  it doesn't; `sh` throws on that.) Used to detect a stacked base whose origin ref
 *  vanished — the blocker merged+was deleted while the ticket was gated. */
function refExists(childDir: string, ref: string): boolean {
  try {
    sh("git", ["rev-parse", "--verify", "--quiet", ref], childDir);
    return true;
  } catch {
    return false;
  }
}

// The agent emits exactly one of these as its last output (see sandbox-prompt.md
// §4). Sandcastle extracts it from stdout by the `<sunday-result>` tag literal,
// JSON-parses it, and validates it against this schema before returning.
const SIGNAL_TAG = "sunday-result";
const resultSchema = z.object({
  signal: z.enum(["ready", "draft", "gate", "fail"]),
  summary: z.string(),
  question: z.string().optional(),
});
export type RunSignal = z.infer<typeof resultSchema>["signal"];

// Appended to a resume prompt: the human reply carries no tag, but Output.object
// requires the tag literal in the resolved prompt, and the agent needs reminding
// to finish the same way.
const RESUME_REMINDER =
  `\n\n---\n\nWhen you have addressed this, finish exactly as before: emit one ` +
  `\`<${SIGNAL_TAG}>{ "signal": …, "summary": …, "question": … }</${SIGNAL_TAG}>\` result.`;

// M5.2 handoff-at-threshold. At a gate resume, if the prior orchestrator context
// (input + cacheRead + cacheCreation) is at/above this, don't resume the bloated
// session — hand off to a fresh one. Tunable via .env for later production tuning.
const HANDOFF_CTX_THRESHOLD = Number(process.env.HANDOFF_CTX_THRESHOLD ?? 120_000);

// Sunday-written lead-in for the fresh post-handoff session: it always frames the
// run as a continuation, so the prompt reads coherently and the handoff note is the
// context (the human reply is the instruction on top).
const CONTINUE_LEADIN =
  "You are picking up work already in progress on this issue. The document above is your " +
  "handoff — a summary of what a previous agent did. Continue from where it left off and " +
  "finish it, following the same rules (§1–§8 of your instructions). The human's latest " +
  "instruction follows.";

export interface RunOutcome {
  signal: RunSignal;
  branch: string;
  /** Present when a PR was opened (ready/draft/fail with commits). */
  prUrl?: string;
  /** Present for filesystem-backed sessions — carries the gate/resume handle. */
  sessionId?: string;
  /** The gate question posted to the issue (signal === "gate"). */
  question?: string;
  /** Orchestrator context at the end of this run (M5.2) — persisted, read at the
   *  next gate resume to decide resume-vs-handoff. Undefined if usage was absent. */
  ctxTokens?: number;
  /** The issue's handoff count after this run (M5.2) — advanced only when this run
   *  performed a threshold handoff; otherwise the caller keeps the prior value. */
  handoffSeq?: number;
}

export interface RunOpts {
  /** Base for the branch, the ahead-count, and the PR (default "main"). A
   *  stacked ticket bases on its blocker's branch — the knob that turns waves
   *  on (M2 step 6). Inert at the default. */
  baseBranch?: string;
  /** Resume a gated session with a human reply instead of a fresh run. `ctxTokens`
   *  + `handoffSeq` (persisted from the run that gated) drive the M5.2 threshold:
   *  ctx ≥ threshold → hand off to a fresh session instead of resuming. */
  resume?: { sessionId: string; reply: string; ctxTokens?: number; handoffSeq?: number };
  /** Cancels the in-sandbox run when aborted — the 403 halt fires this on every
   *  in-flight run (M3.2). run() rejects with the abort reason. */
  signal?: AbortSignal;
}

/**
 * Run one issue end to end for a configured repo, or resume a gated session with
 * a human reply. Composes/continues the prompt, runs the credential-free
 * sandbox, then acts on the agent's structured signal: ready/draft/fail → push +
 * (draft) PR; gate → post the question + `awaiting-human`, no PR. Throws on a
 * missing MODEL, a malformed result after one retry, or any git/gh failure.
 */
export async function runIssue(
  fullName: string,
  cfg: RepoConfig,
  issue: string,
  opts: RunOpts = {},
): Promise<RunOutcome> {
  const { baseBranch = "main", resume, signal: abortSignal } = opts;
  const model = process.env.MODEL;
  if (!model) {
    throw new Error("MODEL is unset — load .env first (node --env-file=.env …).");
  }
  // Orchestrator effort (the .env global fallback; per-phase effort is the injected
  // roster's job — M5.1b). Validate up front so a typo fails fast, not mid-run.
  const rawEffort = process.env.MODEL_EFFORT?.trim();
  let effort: Effort | undefined;
  if (rawEffort) {
    if (!isEffort(rawEffort)) {
      throw new Error(`MODEL_EFFORT="${rawEffort}" invalid — one of ${EFFORTS.join(", ")}.`);
    }
    effort = rawEffort;
  }

  const childDir = resolve(parentRoot, cfg.path);
  const branch = `feat/${issue}`;

  // Title is needed for the PR (fresh) and for a resume→ready PR (gate never
  // opened one). gh auto-detects the child repo from its origin.
  const { title, body } = JSON.parse(
    sh("gh", ["issue", "view", issue, "--json", "title,body"], childDir),
  ) as { title: string; body: string };

  // Prompt: fresh → baseline (§4 carries the tag literal) + issue; resume → the
  // reply + a reminder that carries the tag literal.
  const promptFile = resolve(
    parentRoot,
    ".scratch",
    `prompt-${fullName.replaceAll("/", "-")}-${issue}.md`,
  );
  if (resume) {
    writeFileSync(promptFile, resume.reply + RESUME_REMINDER, "utf8");
  } else {
    const baseline = readFileSync(resolve(parentRoot, cfg.promptFile), "utf8")
      .replaceAll("{{REPO}}", fullName)
      .replaceAll("{{ISSUE}}", issue);
    writeFileSync(
      promptFile,
      `${baseline}\n\n---\n\n# Issue #${issue}: ${title}\n\n${body}\n`,
      "utf8",
    );
  }

  // Per-run discipline floor: the tracked sub-agents (with this run's roster
  // model/effort) + the floor skills, mounted read-only at the sandbox user level
  // (M5.1b). Regenerated each run (idempotent from config/roster.*); the `finally`
  // removes it. A child's own project-level `.claude/` overrides by presence.
  const floorRoot = resolve(parentRoot, ".scratch", fullName, issue, "claude");

  // Everything from here shares the composed prompt file, the floor dir, AND the
  // local branch; a `finally` removes them — except a gated branch, which is then
  // the only copy of its commits (never pushed) and is kept for resume.
  let gated = false;
  // Base every run on the fresh REMOTE ref, never a stale local: Sandcastle prefers
  // an existing local branch, which may lag origin (or be absent once we delete it
  // post-run) — origin/<base> is current after the fetch below (branch-lifecycle
  // findings). The PR base stays the logical name (gh resolves it on the remote);
  // only the worktree start-point + ahead-count use the ref.
  let effectiveBase = baseBranch;
  try {
    // Latest main + every feat/* remote ref, and prune dangling ones (get the
    // newest base before Sandcastle branches feat/<issue> off it).
    sh("git", ["fetch", "-p", "origin"], childDir);
    // A stacked base whose origin ref is gone means the blocker merged+was deleted
    // while this ticket was gated → it has landed; base on main instead.
    if (effectiveBase !== "main" && !refExists(childDir, `origin/${effectiveBase}`)) {
      console.log(`  ↪ ${fullName}#${issue}: base ${effectiveBase} gone (blocker landed) — basing on main`);
      effectiveBase = "main";
    }
    const stackBase = `origin/${effectiveBase}`;

    // Per-flow log: this run's full agent output streams to its own file so
    // concurrent runs don't interleave on the shared stdout (M3.6). `tail -f` it.
    const logPath = runLogPath(fullName, issue);

    // Assemble + mount the discipline floor at the sandbox user level: the tracked
    // sub-agents carry this run's per-phase model/effort from config/roster.*, and
    // the floor skills ride along. Mounted as a SINGLE rw ~/.claude (not two ro
    // subdirs — see Floor: that breaks session capture). A child's project-level
    // `.claude/` still wins by presence (project>user precedence).
    const { dir: claudeDir } = assembleFloor(floorRoot);
    const agent = claudeCode(model, effort ? { effort } : undefined);
    const sandbox = docker({
      imageName: cfg.imageName,
      mounts: [{ hostPath: claudeDir, sandboxPath: "~/.claude", readonly: false }],
    });

    // M5.2 handoff-at-threshold. The gate reply is the ONLY session-resuming path,
    // and the orchestrator session only grows across repeated gate cycles. If the
    // prior context is ≥ threshold, don't resume the bloated session: do one bounded
    // turn that emits a handoff note, then start a FRESH session seeded with it.
    let sessionToResume = resume?.sessionId;
    let outHandoffSeq = resume?.handoffSeq;
    if (resume && (resume.ctxTokens ?? 0) >= HANDOFF_CTX_THRESHOLD) {
      const seq = (resume.handoffSeq ?? 0) + 1;
      console.log(
        `  ↪ ${fullName}#${issue}: ctx ${resume.ctxTokens} ≥ ${HANDOFF_CTX_THRESHOLD} — handoff #${seq} → fresh session`,
      );
      const handoff = await run({
        agent,
        sandbox,
        cwd: childDir,
        prompt: handoffInstructions(),
        branchStrategy: { type: "branch", branch, baseBranch: stackBase },
        logging: { type: "file", path: logPath },
        ...(abortSignal ? { signal: abortSignal } : {}),
        resumeSession: resume.sessionId,
        output: Output.string({ tag: HANDOFF_TAG, maxRetries: 1 }),
      });
      const note = handoff.output?.trim();
      if (!note) {
        // D4b: no usable note → the issue FAILS with a clear message (classify's
        // summarize-failed → agent-failed), and the bloated session is NEVER reused.
        throw new Error(
          `SUMMARIZE_FAILED: couldn't compact an oversized session (≥${HANDOFF_CTX_THRESHOLD} ctx) for ` +
            `${fullName}#${issue} into a handoff note — the old session was not reused; a retry starts fresh.`,
        );
      }
      writeFileSync(handoffDocPath(fullName, issue, seq), note, "utf8");
      // M5.3: the handoff turn is the one token-costing bit of M5.2 — report the
      // retired session's consumption too (keyed distinctly), so it isn't invisible.
      const ho = handoff.iterations.at(-1);
      if (ho?.sessionFilePath && ho.sessionId) emitReport(fullName, ho.sessionFilePath, `${ho.sessionId}-handoff${seq}`);
      // Fresh-run prompt: the note + a Sunday continue lead-in + the human's reply +
      // the finish-reminder (carries the §4 tag literal). No resumeSession below.
      writeFileSync(
        promptFile,
        `${note}\n\n---\n\n${CONTINUE_LEADIN}\n\n${resume.reply}${RESUME_REMINDER}`,
        "utf8",
      );
      sessionToResume = undefined;
      outHandoffSeq = seq;
    }

    // Delegate to the sandbox (it decides; it has no credentials). maxRetries:1 —
    // one automatic re-emit if the agent's tag is missing/malformed.
    console.log(
      `▶ ${fullName}#${issue} → ${branch}  (model ${model}, image ${cfg.imageName}` +
        `${sessionToResume ? ", resume" : ""})  → ${logPath}`,
    );
    const result = await run({
      agent,
      sandbox,
      cwd: childDir,
      promptFile,
      branchStrategy: { type: "branch", branch, baseBranch: stackBase },
      logging: { type: "file", path: logPath },
      ...(abortSignal ? { signal: abortSignal } : {}),
      ...(sessionToResume ? { resumeSession: sessionToResume } : {}),
      output: Output.object({ tag: SIGNAL_TAG, schema: resultSchema, maxRetries: 1 }),
    });

    const last = result.iterations.at(-1);
    const sessionId = last?.sessionId;
    // ctx = the last iteration's cumulative usage snapshot (M5.2 threshold input).
    const ctxTokens = last?.usage
      ? last.usage.inputTokens + last.usage.cacheReadInputTokens + last.usage.cacheCreationInputTokens
      : undefined;
    // M5.3: on completion, emit the cost-weighted per-phase token report (host-side,
    // free, never throws) from the captured session + its sub-agent files.
    if (last?.sessionFilePath && sessionId) emitReport(fullName, last.sessionFilePath, sessionId);
    const { signal, summary, question } = result.output;

    // Gate: no PR. Post the question (marked, so resume can skip our own comment)
    // and claim the issue for a human. The session + local branch live on for resume.
    if (signal === "gate") {
      gated = true;
      const ask = question ?? summary;
      sh("gh", ["issue", "comment", issue, "--body", sundayComment(ask)], childDir);
      sh("gh", ["issue", "edit", issue, "--add-label", "awaiting-human"], childDir);
      console.log(`⛔ ${fullName}#${issue}: gate — asked the human, awaiting-human.`);
      return { signal, branch, sessionId, question: ask, ctxTokens, handoffSeq: outHandoffSeq };
    }

    // ready/draft/fail all ship a PR — but only if the branch actually has commits
    // ahead of its base (robust across a resume, where prior commits sit on the
    // branch and result.commits may be empty for this iteration).
    const ahead = sh("git", ["rev-list", "--count", `${stackBase}..${branch}`], childDir);
    if (ahead === "0") {
      console.log(`✋ ${fullName}#${issue}: signal ${signal} but no commits — nothing to ship.`);
      return { signal, branch, sessionId, ctxTokens, handoffSeq: outHandoffSeq };
    }

    sh("git", ["push", "origin", branch], childDir);
    const draft = signal !== "ready";
    const prUrl = sh(
      "gh",
      [
        "pr", "create", "--base", effectiveBase, "--head", branch,
        ...(draft ? ["--draft"] : []),
        "--title", title,
        "--body",
        `${signal === "fail" ? summary : `${summary}\n\nCloses #${issue}.`}\n\n---\n${SUNDAY_SIGN} opened this PR.`,
      ],
      childDir,
    );
    if (signal === "fail") {
      sh("gh", ["issue", "edit", issue, "--add-label", "agent-failed"], childDir);
    }
    console.log(
      `${signal === "ready" ? "✅" : "📝"} ${fullName}#${issue}: ${signal} — ${draft ? "draft " : ""}PR ${prUrl}`,
    );
    // Sentry-like Telegram floor: a PR opening is an important milestone worth the
    // phone alert (failures already notify; routine chatter — token reports — do NOT).
    // Fire-and-forget, no-ops when Telegram is unconfigured; never breaks the run.
    void sendTelegram(
      `${signal === "ready" ? "✅" : "📝"} ${fullName}#${issue}: ${signal} — ${draft ? "draft " : ""}PR ${prUrl}`,
    ).catch(() => {});
    // Terminal push — the issue's handoff notes are spent (M5.2 D6).
    cleanupHandoffs(fullName, issue);
    return { signal, branch, prUrl, sessionId, ctxTokens, handoffSeq: outHandoffSeq };
  } finally {
    rmSync(promptFile, { force: true });
    rmSync(floorRoot, { recursive: true, force: true }); // per-run floor — regenerated each run
    // The local branch was pushed (a PR outcome) or is empty — origin holds any
    // history, so drop it. A gated branch is the only copy of its commits → kept.
    if (!gated) deleteLocalBranch(childDir, branch);
  }
}
