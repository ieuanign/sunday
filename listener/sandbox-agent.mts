// listener/sandbox-agent.mts — run a headless `claude -p` INSIDE the child's
// sandbox image, on a git worktree bind-mounted at its host path.
//
// This is the same CLI Sandcastle drives (dist/index.js buildPrintCommand), $0 on
// the Max token — NOT the paid API. Credential-free of GitHub: only the Claude
// OAuth token is passed (through from the parent env, never on disk or in argv),
// so the sandbox cannot push — the host does. Used by the 6c restack conflict fix:
// the agent rebases + resolves in the worktree; Sunday reads the rewritten ref off
// the shared bind-mount and force-pushes it (Sandcastle's add-only sync-out can't
// represent a rewrite, so it is bypassed entirely).
//
// The container init lives here so the restack driver stays declarative. It runs
// ASYNC (spawn, not execFileSync): a `/implement` fix takes minutes, and blocking
// the single Node thread would freeze webhook handling and every other in-flight
// run. Facts baked in (onboarding recipe / probes): image user 501:20, entrypoint
// `sleep infinity` (overridden), git identity empty in-container (injected),
// HOME=/home/agent.

import { spawn } from "node:child_process";

export interface AgentResult {
  /** Parsed `<sunday-result>` signal, if the agent emitted one. */
  signal?: string;
  summary?: string;
  /** The agent's final text (stream `result`, or the raw stdout). */
  raw: string;
  /** claude reported `is_error`, or the process exited non-zero / timed out. */
  errored: boolean;
}

const SIGNAL_TAG = "sunday-result";
const RESULT_RE = new RegExp(`<${SIGNAL_TAG}>\\s*(\\{[\\s\\S]*?\\})\\s*</${SIGNAL_TAG}>`);

function parse(out: string, errored: boolean): AgentResult {
  let text = out;
  try {
    const j = JSON.parse(out) as { result?: string; is_error?: boolean };
    text = j.result ?? out;
    if (j.is_error) errored = true;
  } catch {
    /* not json (crashed before emitting) — fall back to raw */
  }
  const m = text.match(RESULT_RE);
  if (m) {
    try {
      const p = JSON.parse(m[1]) as { signal?: string; summary?: string };
      return { signal: p.signal, summary: p.summary, raw: text, errored };
    } catch {
      /* malformed tag — treat as no signal */
    }
  }
  return { raw: text, errored };
}

/**
 * Run `claude -p` headless in `imageName`, cwd = `worktree` (which MUST live under
 * `childDir` so the single bind-mount covers both it and its `.git`). The prompt
 * is fed on stdin. Resolves with the parsed signal + raw text; never rejects on a
 * non-zero agent exit (surfaced via `errored`) — only rejects if the token is
 * missing. Runs async so it never blocks the listener's event loop.
 */
export function runAgentInSandbox(opts: {
  childDir: string;
  imageName: string;
  worktree: string;
  prompt: string;
  model: string;
  /** Hard wall-clock cap for the container (ms). Default 15 min. */
  timeoutMs?: number;
}): Promise<AgentResult> {
  const { childDir, imageName, worktree, prompt, model, timeoutMs = 900_000 } = opts;
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return Promise.reject(
      new Error("CLAUDE_CODE_OAUTH_TOKEN unset — load the parent .env (node --env-file=.env …)."),
    );
  }

  const args = [
    "run", "--rm", "-i",
    "--user", "501:20",
    "-v", `${childDir}:${childDir}`,
    "-w", worktree,
    "-e", "CLAUDE_CODE_OAUTH_TOKEN", // pass-through: not on disk/argv, and NO gh creds
    "-e", "HOME=/home/agent",
    "-e", "GIT_AUTHOR_NAME=Sunday", "-e", "GIT_AUTHOR_EMAIL=sunday@localhost",
    "-e", "GIT_COMMITTER_NAME=Sunday", "-e", "GIT_COMMITTER_EMAIL=sunday@localhost",
    "--entrypoint", "claude", imageName,
    "--print", "--dangerously-skip-permissions", "--output-format", "json", "--model", model, "-p", "-",
  ];

  return new Promise<AgentResult>((resolveResult) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    let errored = false;
    const timer = setTimeout(() => {
      errored = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", () => (errored = true)); // e.g. docker not found
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveResult(parse(out, errored || code !== 0));
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}
