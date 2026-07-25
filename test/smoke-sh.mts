// test/smoke-sh.mts — hermetic smoke for helper.mts's `sh` / `shA` error shape.
//   devbox run node test/smoke-sh.mts
// The contract these lock down: a failed command throws its own STDERR, and never
// its argv. classify.mts regex-matches that message, and our argv carries
// agent-authored prose (`gh pr create --title/--body …`) — PR 61's real body says
// "credential-free sandbox", which the auth rule matches, so leaking the argv would
// classify a failed create as a P1 auth halt on the agent's wording alone. Shells
// out to `sh`/`printf` only — no network, no GitHub.

import { classify } from "../listener/classify.mts";
import { sh, shA } from "../listener/helper.mts";

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : `\n    ${detail}`}`);
};

const messageOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  return "<did not throw>";
};

// ── success path is unchanged: trimmed stdout ──
{
  ok("sh: returns trimmed stdout", sh("printf", ["  hi  "]) === "hi", JSON.stringify(sh("printf", ["  hi  "])));
  ok("shA: returns trimmed stdout", (await shA("printf", ["  hi  "])) === "hi");
}

// ── failure carries stderr, not the argv ──
{
  const msg = messageOf(() =>
    sh("sh", ["-c", 'echo "GraphQL: Something went wrong while executing your query" >&2; exit 1']),
  );
  ok("sh: message carries stderr", msg.includes("GraphQL: Something went wrong"), msg);
  ok("sh: message omits the argv", !msg.includes("exit 1"), msg);

  let aMsg = "<did not throw>";
  try {
    await shA("sh", ["-c", 'echo "GraphQL: Something went wrong while executing your query" >&2; exit 1']);
  } catch (err) {
    aMsg = (err as Error).message;
  }
  ok("shA: message carries stderr", aMsg.includes("GraphQL: Something went wrong"), aMsg);
  ok("shA: message omits the argv", !aMsg.includes("exit 1"), aMsg);
}

// ── the regression that halted the pipeline: agent prose in a flag value must not
//    reach the classifier (a `--body` saying "credential" would read as an auth 403)
{
  const msg = messageOf(() =>
    sh("sh", [
      "-c",
      'echo "GraphQL: Something went wrong while executing your query" >&2; exit 1',
      "--title",
      "Shell 1 — walking skeleton",
      "--body",
      "this credential-free sandbox has no docker",
    ]),
  );
  ok("argv: flag values excluded from the message", !msg.includes("credential"), msg);
  ok("argv: classifies off stderr → transient, not auth", classify({ error: new Error(msg) }).class === "transient", msg);
}

// ── a command that fails silently still throws something classifiable ──
{
  const msg = messageOf(() => sh("sh", ["-c", "exit 3"]));
  ok("sh: silent failure still throws", msg.includes("failed"), msg);
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
