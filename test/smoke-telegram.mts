// test/smoke-telegram.mts — no-quota smoke for the M3.4 Telegram command layer.
//   devbox run node test/smoke-telegram.mts
// Drives the PURE pieces — parseCommand, isAllowedChat, dispatchCommand (with stub
// handlers). The getUpdates loop + fetch are I/O (need a real bot) and are
// user-driven, like the other live paths.

import {
  parseCommand,
  isAllowedChat,
  dispatchCommand,
  type TelegramHandlers,
} from "../listener/telegram.mts";

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : `\n    ${detail}`}`);
};

// ── parseCommand ──
{
  ok("parse: /pause → cmd, no arg", JSON.stringify(parseCommand("/pause")) === JSON.stringify({ cmd: "/pause", arg: "" }));
  ok("parse: /pause reason → arg captured", JSON.stringify(parseCommand("/pause quota")) === JSON.stringify({ cmd: "/pause", arg: "quota" }));
  ok("parse: strips @botname suffix", parseCommand("/status@SundayBot")?.cmd === "/status");
  ok("parse: lowercased", parseCommand("/STATUS")?.cmd === "/status");
  ok("parse: non-command → null", parseCommand("hello there") === null);
  ok("parse: multi-word arg preserved", parseCommand("/resume-at 2026-07-19T21:00:00Z")?.arg === "2026-07-19T21:00:00Z");
}

// ── isAllowedChat (the sole authz — fail closed) ──
{
  ok("authz: matching id allowed", isAllowedChat(12345, "12345"));
  ok("authz: numeric vs string id coerced", isAllowedChat(12345, "12345") && isAllowedChat("12345", "12345"));
  ok("authz: other id denied", !isAllowedChat(999, "12345"));
  ok("authz: no allowlist → deny", !isAllowedChat(12345, undefined) && !isAllowedChat(12345, ""));
  ok("authz: undefined chat → deny", !isAllowedChat(undefined, "12345"));
}

// ── dispatchCommand (stub handlers record calls) ──
{
  const calls: string[] = [];
  const h: TelegramHandlers = {
    pause: (r) => calls.push(`pause:${r}`),
    resume: () => calls.push("resume"),
    resumeAt: (t) => calls.push(`resumeAt:${t}`),
    status: () => "STATUS-BODY",
  };

  const r1 = dispatchCommand("/pause", "", h);
  ok("dispatch: /pause calls handler w/ default reason", calls.includes("pause:manual (telegram)") && r1.includes("paused"));

  const r2 = dispatchCommand("/pause", "quota wall", h);
  ok("dispatch: /pause passes the reason", calls.includes("pause:quota wall") && r2.includes("quota wall"));

  const r3 = dispatchCommand("/resume", "", h);
  ok("dispatch: /resume", calls.includes("resume") && r3.includes("resumed"));

  calls.length = 0;
  const r4 = dispatchCommand("/resume-at", "2026-07-19T21:00:00Z", h);
  ok("dispatch: /resume-at parses ISO → epoch", calls[0] === `resumeAt:${Date.parse("2026-07-19T21:00:00Z")}` && r4.includes("will resume"));

  calls.length = 0;
  const r5 = dispatchCommand("/resume-at", "not-a-time", h);
  ok("dispatch: /resume-at bad input → no handler, help reply", calls.length === 0 && r5.includes("needs an ISO time"));

  ok("dispatch: /status returns the status body", dispatchCommand("/status", "", h) === "STATUS-BODY");
  ok("dispatch: /help lists commands", dispatchCommand("/help", "", h).includes("/pause"));
  ok("dispatch: unknown → help reply", dispatchCommand("/wat", "", h).includes("unknown command /wat"));
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
