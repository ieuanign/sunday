// services/destinations.mts — the concrete sinks the Logger routes to. Each one is
// constructed with the handle it writes through (a path, a sender), never with a path
// it reads from the environment: that is what lets a test substitute the lot and what
// keeps a smoke out of the real `var/`.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { sundayComment } from "#lib/markers.mts";
import { sh } from "#lib/sh.mts";
import { Logger, type Destination, type Level, type LogLine } from "./logger.mts";

const ICON: Record<Level, string> = { info: "·", milestone: "🔵", alert: "🟠", error: "🔴" };

/** Telegram caps a message at 4096 chars; leave room for the tag and the icon. Exported
 *  because the inbound half bounds its replies against the same one (#66) — a second cap
 *  is how one of them goes stale. */
export const PHONE_MAX = 3800;

/** A log line can carry a raw agent-output excerpt; v1 capped those at 2000 chars and
 *  a comment is for humans, not for archiving output — the run log has the whole thing. */
const COMMENT_MAX = 2000;

const API = "https://api.telegram.org";

const GITHUB = "https://github.com";

/** Where the line happened, for a human reading one line out of context. */
function where(line: LogLine): string {
  const { repo, target } = line.context;
  if (!repo) return "";
  return target === undefined ? ` (${repo})` : ` (${repo}#${target})`;
}

/** The same, for a phone: a tappable link rather than `owner/repo#n`, because a push
 *  notification is read away from the machine the run is on. `/issues/<n>` redirects to
 *  `/pull/<n>`, so one form addresses an issue and a pull request alike and nothing here
 *  has to know which it got. */
function link(line: LogLine): string {
  const { repo, target } = line.context;
  if (!repo) return "";
  return target === undefined ? ` (${repo})` : `\n${GITHUB}/${repo}/issues/${target}`;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [truncated]`;
}

/** The screen. THE one sanctioned writer to stdout in the whole tree — the pragma below
 *  is the only exemption `npm run lint` grants, and it sits on the line rather than on
 *  the file so a stray write cannot hide beside it. */
export function consoleDestination(): Destination {
  return (line) => {
    console.log(`${ICON[line.level]} [${line.module}] ${line.message}${where(line)}`); // sunday:allow-console
  };
}

/** The run log: every line, verbatim and durable. Constructed with the work item's own
 *  `runLogPath(...)` inside a forked run, or `fallbackLogPath` where there is no work
 *  item to attribute lines to — so nothing is durable-nowhere. Makes its own directory:
 *  `lib/paths.mts` only NAMES paths. */
export function runLogDestination(path: string): Destination {
  return (line) => {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${line.ts} ${line.level.padEnd(9)} [${line.module}] ${line.message}${where(line)}\n`);
  };
}

/** The event log: append-only JSONL, the durable record of what Sunday decided. Written
 *  first of all the destinations, so an event survives whatever fails after it. */
export function eventLogDestination(path: string): Destination {
  return (line) => {
    const { repo, target } = line.context;
    const record = {
      ts: line.ts,
      level: line.level,
      module: line.module,
      message: line.message,
      ...(repo ? { repo } : {}),
      ...(target === undefined ? {} : { target }),
    };
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`);
  };
}

/** The comment Sunday posts for one line: marked and signed, always, so it can never
 *  read back as a summon from the human who shares the account. */
export function commentBody(line: LogLine): string {
  return sundayComment(`${ICON[line.level]} ${truncate(line.message, COMMENT_MAX)}`);
}

/** GitHub: a comment on the issue or PR the line names. `--repo` addresses it directly
 *  — v1 passed a child checkout as cwd instead, a field every call site had to carry —
 *  and `gh issue comment` addresses a PR just as well as an issue. Left out of the smoke
 *  on purpose: it needs the `gh` CLI and the network. What IS covered is the part that
 *  can be wrong — what it posts (`commentBody`) and when it is reached (the Logger's
 *  routing table). A `gh` failure throws and the Logger degrades it. */
export function githubDestination(): Destination {
  return (line) => {
    const { repo, target } = line.context;
    if (!repo || target === undefined) return; // nothing to address
    sh("gh", ["issue", "comment", String(target), "--repo", repo, "--body", commentBody(line)]);
  };
}

/** Posts one line to Telegram. Injectable so a smoke can drive the destination's
 *  configured/unconfigured decision without a network call. */
export type PhoneSender = (text: string, token: string, chatId: string) => Promise<void>;

/** The phone. An OPTIONAL layer: with `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` unset it
 *  sends nothing at all, which is the common case and not a failure. */
export function phoneDestination(send: PhoneSender = telegramSend): Destination {
  return (line) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return; // not configured — stay silent
    return send(`${ICON[line.level]} [${line.module}] ${truncate(line.message, PHONE_MAX)}${link(line)}`, token, chatId);
  };
}

/** THE one place a Logger is assembled from the five destinations, so the parent and a
 *  forked child cannot drift in what a level reaches — a child that composed its own
 *  set would be a second routing table nobody maintains.
 *
 *  Both durable paths are arguments, never read here: a child's run log is its own work
 *  item's and the parent's is `fallbackLogPath`, and a smoke forks the real entry point
 *  into a temp dir rather than the real `var/`. */
export function createLogger(paths: { runLog: string; eventLog: string }): Logger {
  return new Logger({
    console: consoleDestination(),
    runLog: runLogDestination(paths.runLog),
    eventLog: eventLogDestination(paths.eventLog),
    github: githubDestination(),
    phone: phoneDestination(),
  });
}

/** THE one Bot API call, outbound and inbound alike (#66): `sendMessage` from here,
 *  `getUpdates` from `services/telegram.mts`. Rejects on a transport error or an
 *  `ok:false` reply — the Logger turns that into a degraded event. */
export async function botApi(method: string, token: string, body: Record<string, unknown>): Promise<unknown> {
  try {
    const res = await fetch(`${API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
    if (!json.ok) throw new Error(json.description ?? `HTTP ${res.status}`);
    return json.result;
  } catch (err) {
    // The token sits in the request URL, so a transport error can quote it. It must
    // never reach a log line — every failure leaves here scrubbed, and there is exactly
    // one copy of this scrub because two is how one of them loses it.
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`telegram ${method} failed: ${detail.replaceAll(token, "***")}`);
  }
}

async function telegramSend(text: string, token: string, chatId: string): Promise<void> {
  await botApi("sendMessage", token, { chat_id: chatId, text, disable_web_page_preview: true });
}
