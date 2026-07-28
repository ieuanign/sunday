// test/smoke-logger.mts — hermetic smoke for the Logger and its destinations.
//   devbox run node test/smoke-logger.mts
// The primary seam: the REAL Logger driven with substituted destinations, so what is
// asserted is the routing decision (which destinations a level reaches), never how a
// destination is wired. $0, offline, no GitHub, no tokens, no writes to var/.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { sh } from "#lib/sh.mts";
import { Logger, type Destinations, type LogLine } from "#services/logger.mts";
import { commentBody, consoleDestination, eventLogDestination, phoneDestination, runLogDestination } from "#services/destinations.mts";

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : `\n    ${detail}`}`);
};

/** A substituted destination that just records what it was handed. */
function recorder(): { lines: LogLine[]; dest: (line: LogLine) => void } {
  const lines: LogLine[] = [];
  return { lines, dest: (line) => void lines.push(line) };
}

type Rec = Record<keyof Destinations, ReturnType<typeof recorder>>;

/** A real Logger over five recording destinations; `broken` replaces some of them
 *  with sinks that fail, to drive the degrade path. */
function harness(broken: Partial<Destinations> = {}): { rec: Rec; log: Logger } {
  const rec: Rec = {
    console: recorder(),
    runLog: recorder(),
    eventLog: recorder(),
    github: recorder(),
    phone: recorder(),
  };
  const dests: Destinations = {
    console: rec.console.dest,
    runLog: rec.runLog.dest,
    eventLog: rec.eventLog.dest,
    github: rec.github.dest,
    phone: rec.phone.dest,
    ...broken,
  };
  return { rec, log: new Logger(dests) };
}

/** Which destinations received a line, as a stable string — asserting the WHOLE set
 *  so a level that over-routes (e.g. info reaching the phone) fails too. */
const hit = (rec: Rec): string =>
  Object.entries(rec)
    .filter(([, r]) => r.lines.length > 0)
    .map(([name]) => name)
    .sort()
    .join(",");

// ── info: the quiet level — durable + visible, nothing external ──
{
  const h = harness();
  h.log.child("assignor").info("queued acme/finance#57", { repo: "acme/finance", target: 57 });
  ok("info → console + run log only", hit(h.rec) === "console,runLog", hit(h.rec));
  ok("line carries the module tag of the child logger", h.rec.console.lines[0]?.module === "assignor", JSON.stringify(h.rec.console.lines[0]));
  ok("line carries the message", h.rec.runLog.lines[0]?.message === "queued acme/finance#57", JSON.stringify(h.rec.runLog.lines[0]));
}

// ── milestone: the humans-watching-the-issue channel — durable, on the issue, off the phone ──
{
  const h = harness();
  h.log.child("issue").milestone("agent finished, opening a PR", { repo: "acme/finance", target: 57 });
  ok(
    "milestone → event log + run log + console + GitHub, never the phone",
    hit(h.rec) === "console,eventLog,github,runLog",
    hit(h.rec),
  );
  ok(
    "milestone: the GitHub line carries the target it addresses",
    h.rec.github.lines[0]?.context.repo === "acme/finance" && h.rec.github.lines[0]?.context.target === 57,
    JSON.stringify(h.rec.github.lines[0]),
  );
}

// ── the phone opt-in: the one thing that ADDS to what a level's row says. The three
//    lines worth a push (work started, a PR opened, a summon answered) are info and
//    milestone, and promoting either LEVEL would drag every other line along with it ──
{
  const h = harness();
  h.log.child("assignor").milestone("▶ work started", { repo: "acme/finance", target: 57 }, true);
  ok(
    "milestone + phone → the milestone row plus the phone, sent once",
    hit(h.rec) === "console,eventLog,github,phone,runLog" && h.rec.phone.lines.length === 1,
    `${hit(h.rec)} / phone×${h.rec.phone.lines.length}`,
  );

  const quiet = harness();
  quiet.log.child("issue").info("ready — PR https://github.com/acme/finance/pull/12", { repo: "acme/finance", target: 57 }, true);
  ok("info + phone → console + run log + the phone, and still no GitHub comment", hit(quiet.rec) === "console,phone,runLog", hit(quiet.rec));
  ok(
    "the opt-in adds a destination, never the severity on the record",
    quiet.rec.phone.lines[0]?.level === "info",
    quiet.rec.phone.lines[0]?.level,
  );

  const off = harness();
  off.log.child("assignor").milestone("▶ work started", { repo: "acme/finance", target: 57 });
  ok("omitted, the opt-in is off — the row is unchanged", hit(off.rec) === "console,eventLog,github,runLog", hit(off.rec));
}

// ── alert + error: the phone levels — same destinations, different severity on the record ──
{
  const alert = harness();
  alert.log.child("pr").alert("opened PR #12", { repo: "acme/finance", target: 12 });
  ok(
    "alert → every destination, phone included",
    hit(alert.rec) === "console,eventLog,github,phone,runLog",
    hit(alert.rec),
  );

  const error = harness();
  error.log.child("issue").error("agent run failed", { repo: "acme/finance", target: 57 });
  ok(
    "error → every destination, phone included",
    hit(error.rec) === "console,eventLog,github,phone,runLog",
    hit(error.rec),
  );
  ok(
    "the level travels on the line, so alert and error stay distinguishable",
    alert.rec.eventLog.lines[0]?.level === "alert" && error.rec.eventLog.lines[0]?.level === "error",
    `${alert.rec.eventLog.lines[0]?.level} / ${error.rec.eventLog.lines[0]?.level}`,
  );
}

// ── pipeline scope: no target → nothing to address, so no comment lands anywhere ──
{
  const h = harness();
  h.log.child("boot").error("halted — gh auth expired");
  ok(
    "no target → every other destination, but no GitHub comment",
    hit(h.rec) === "console,eventLog,phone,runLog",
    hit(h.rec),
  );

  const repoOnly = harness();
  repoOnly.log.child("forwarder").alert("forwarder restarted", { repo: "acme/finance" });
  ok(
    "a repo without an issue or PR is still not addressable → no GitHub comment",
    hit(repoOnly.rec) === "console,eventLog,phone,runLog",
    hit(repoOnly.rec),
  );
}

// ── a broken destination degrades; it never becomes the caller's problem. The Logger
//    sits on every failure path, so a throw here turns a handled failure into a crash ──
{
  const h = harness({
    github: () => {
      throw new Error("gh: HTTP 502");
    },
  });
  let threw = false;
  try {
    h.log.child("issue").error("agent run failed", { repo: "acme/finance", target: 57 });
  } catch {
    threw = true;
  }
  ok("a throwing destination never propagates to the caller", !threw);
  ok(
    "the failure is recorded on the event log, naming the sink and the cause",
    h.rec.eventLog.lines.length === 2 &&
      h.rec.eventLog.lines[1]!.message.includes("github") &&
      h.rec.eventLog.lines[1]!.message.includes("HTTP 502"),
    JSON.stringify(h.rec.eventLog.lines),
  );
  ok(
    "the original line still reached every healthy destination",
    hit(h.rec) === "console,eventLog,phone,runLog",
    hit(h.rec),
  );
}

// ── the same for an async destination: the phone posts over HTTP, so its failure
//    arrives as a rejection on a later tick, not as a throw ──
{
  const h = harness({ phone: () => Promise.reject(new Error("telegram send failed: 429")) });
  h.log.child("pr").alert("opened PR #12", { repo: "acme/finance", target: 12 });
  await new Promise((r) => setImmediate(r));
  ok(
    "a rejected async destination degrades too (no unhandled rejection)",
    h.rec.eventLog.lines.length === 2 && h.rec.eventLog.lines[1]!.message.includes("phone"),
    JSON.stringify(h.rec.eventLog.lines),
  );
}

// ── last resort: when the event log itself is what broke, there is nowhere left to
//    record — but the Logger still must not throw ──
{
  const h = harness({
    eventLog: () => {
      throw new Error("ENOSPC");
    },
  });
  let threw = false;
  try {
    h.log.child("boot").error("halted — gh auth expired");
  } catch {
    threw = true;
  }
  ok("a broken event log does not throw either", !threw);
  ok("the line still reached the other destinations", hit(h.rec) === "console,phone,runLog", hit(h.rec));
}

// ── the module tag: bound at child creation, on every line, and unforgeable. The two
//    `@ts-expect-error`s are the real assertions — `npm run typecheck` fails if either
//    call ever compiles ──
{
  const h = harness();
  const tagged = h.log.child("scheduler");
  tagged.error("branch lock stuck", { repo: "acme/finance", target: 57 });
  const everyLine = Object.values(h.rec).flatMap((r) => r.lines);
  ok(
    "every destination gets the tag, on every line",
    everyLine.length === 5 && everyLine.every((l) => l.module === "scheduler"),
    JSON.stringify(everyLine.map((l) => l.module)),
  );

  // @ts-expect-error the root logger emits nothing — an untagged line is unwritable.
  h.log.info?.("untagged");
  ok("the root logger exposes no emit method", (h.log as unknown as { info?: unknown }).info === undefined);

  const other = harness();
  const otherTagged = other.log.child("scheduler");
  // @ts-expect-error the second argument is the context — there is no tag parameter.
  otherTagged.info("stalled", "assignor");
  ok(
    "an emit call cannot supply a tag of its own",
    other.rec.console.lines[0]?.module === "scheduler",
    JSON.stringify(other.rec.console.lines[0]),
  );
}

// ── the phone: an OPTIONAL layer. Unconfigured it must stay completely silent, and it
//    must never render the token it was configured with ──
{
  const sent: { text: string; token: string; chatId: string }[] = [];
  const send = (text: string, token: string, chatId: string): Promise<void> => {
    sent.push({ text, token, chatId });
    return Promise.resolve();
  };
  const line: LogLine = {
    ts: "2026-07-25T00:00:00.000Z",
    level: "error",
    module: "issue",
    message: "agent run failed",
    context: { repo: "acme/finance", target: 57 },
  };

  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  await phoneDestination(send)(line);
  ok("phone: unconfigured → nothing is sent at all", sent.length === 0, JSON.stringify(sent));

  process.env.TELEGRAM_BOT_TOKEN = "smoke-token";
  await phoneDestination(send)(line);
  ok("phone: a token without a chat id is still unconfigured", sent.length === 0, JSON.stringify(sent));

  process.env.TELEGRAM_CHAT_ID = "424242";
  await phoneDestination(send)(line);
  ok("phone: configured → sent to the configured chat", sent.length === 1 && sent[0]?.chatId === "424242", JSON.stringify(sent));
  ok(
    "phone: the notice carries the module tag, the message and a tappable link",
    sent[0]!.text.includes("[issue]") &&
      sent[0]!.text.includes("agent run failed") &&
      // `/issues/<n>` on purpose — GitHub redirects it to `/pull/<n>`, so the one form
      // addresses an issue and a pull request alike.
      sent[0]!.text.includes("https://github.com/acme/finance/issues/57"),
    sent[0]?.text,
  );
  ok("phone: the token never reaches the text", !sent[0]!.text.includes("smoke-token"), sent[0]?.text);

  await phoneDestination(send)({ ...line, message: "x".repeat(9000) });
  ok(
    "phone: an oversized body is truncated below the Bot API's 4096 limit",
    sent[1]!.text.length <= 4096,
    String(sent[1]?.text.length),
  );

  await phoneDestination(send)({ ...line, context: { repo: "acme/finance" } });
  ok("phone: no issue or PR number → the repo, and no link to nowhere", sent[2]!.text.endsWith("(acme/finance)"), sent[2]?.text);

  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
}

// ── what lands on the issue: Sunday and the human post under the SAME account, so an
//    unmarked comment reads back as a summon and Sunday answers itself. The literals
//    are v1's — live threads already carry them and comment routing matches them ──
{
  const line: LogLine = {
    ts: "2026-07-25T00:00:00.000Z",
    level: "milestone",
    module: "pr",
    message: "opened PR #12",
    context: { repo: "acme/finance", target: 57 },
  };
  const body = commentBody(line);
  ok("github: the comment opens with the hidden marker", body.startsWith("<!-- sunday:gate -->"), body);
  ok("github: the comment carries the visible sign", body.includes("🤖 **Sunday**"), body);
  ok("github: the comment carries the message", body.includes("opened PR #12"), body);

  const big = commentBody({ ...line, message: "y".repeat(9000) });
  ok("github: an oversized body is truncated", big.length <= 2100, String(big.length));
  ok("github: a truncated comment is still marked", big.startsWith("<!-- sunday:gate -->"), big.slice(0, 40));
}

// ── the durable pair. Both write under a throwaway dir here, never the real var/ —
//    which is exactly what "each destination takes its path at construction" buys ──
{
  const dir = resolve(import.meta.dirname, "..", ".scratch", `smoke-logger-${process.pid}`);
  const runLog = resolve(dir, "acme", "finance", "57", "run.log");
  const eventLog = resolve(dir, "log", "events.jsonl");
  const line: LogLine = {
    ts: "2026-07-25T00:00:00.000Z",
    level: "milestone",
    module: "issue",
    message: "agent finished",
    context: { repo: "acme/finance", target: 57 },
  };

  try {
    // lib/paths.mts names paths and creates nothing, so the writer makes its own dir.
    ok("run log: its directory does not exist yet", !existsSync(dir));
    runLogDestination(runLog)(line);
    runLogDestination(runLog)({ ...line, level: "info", message: "second line" });
    const text = readFileSync(runLog, "utf8");
    ok("run log: creates its own directory and appends both lines", text.split("\n").filter(Boolean).length === 2, text);
    ok(
      "run log: a line carries its timestamp, level, module and message",
      text.includes("2026-07-25T00:00:00.000Z") && text.includes("milestone") && text.includes("[issue]") && text.includes("agent finished"),
      text,
    );

    eventLogDestination(eventLog)(line);
    eventLogDestination(eventLog)({ ...line, level: "error", message: "agent run failed", context: {} });
    const records = readFileSync(eventLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    ok("event log: append-only JSONL, one record per line", records.length === 2, JSON.stringify(records));
    ok(
      "event log: a record carries level, module, message and what it was about",
      records[0]!.level === "milestone" &&
        records[0]!.module === "issue" &&
        records[0]!.message === "agent finished" &&
        records[0]!.repo === "acme/finance" &&
        records[0]!.target === 57,
      JSON.stringify(records[0]),
    );
    ok(
      "event log: a pipeline-scope record simply omits repo and target",
      records[1]!.repo === undefined && records[1]!.target === undefined && records[1]!.level === "error",
      JSON.stringify(records[1]),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── the shell-out leaf the GitHub destination posts through. Ported from v1, and the
//    port must keep v1's error shape: the classifier regex-matches these messages, and
//    our argv carries agent-authored prose ("credential-free sandbox" in a PR body once
//    got a failed create classified as a P1 auth halt) ──
{
  const messageOf = (fn: () => unknown): string => {
    try {
      fn();
    } catch (err) {
      return (err as Error).message;
    }
    return "<did not throw>";
  };

  ok("sh: returns trimmed stdout", sh("printf", ["  hi  "]) === "hi", JSON.stringify(sh("printf", ["  hi  "])));

  const msg = messageOf(() =>
    sh("sh", [
      "-c",
      'echo "GraphQL: Something went wrong while executing your query" >&2; exit 1',
      "--body",
      "this credential-free sandbox has no docker",
    ]),
  );
  ok("sh: a failure carries the command's own stderr", msg.includes("GraphQL: Something went wrong"), msg);
  ok("sh: a failure never carries a flag value from the argv", !msg.includes("credential"), msg);
  ok("sh: a silent failure still throws something classifiable", messageOf(() => sh("sh", ["-c", "exit 3"])).includes("failed"), msg);
}

// ── the console: the ONE sanctioned writer to stdout (everything else goes through the
//    Logger, enforced by lint) — a terse tagged one-liner ──
{
  const printed: string[] = [];
  const real = console.log;
  console.log = (...args: unknown[]) => void printed.push(args.join(" "));
  try {
    consoleDestination()({
      ts: "2026-07-25T00:00:00.000Z",
      level: "alert",
      module: "forwarder",
      message: "forwarder restarted",
      context: { repo: "acme/finance", target: 57 },
    });
  } finally {
    console.log = real;
  }
  ok(
    "console: one tagged line naming the module, the message and where",
    printed.length === 1 &&
      printed[0]!.includes("[forwarder]") &&
      printed[0]!.includes("forwarder restarted") &&
      printed[0]!.includes("acme/finance#57"),
    JSON.stringify(printed),
  );
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
