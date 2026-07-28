// test/smoke-telegram.mts — hermetic smoke for the phone's INBOUND half: the real
// control channel, driven through an injected Bot API call. $0, no network, no token.
//   devbox run node test/smoke-telegram.mts
// This is an authz boundary — `TELEGRAM_CHAT_ID` is the only thing between a stranger's
// message and a command that spends agent quota — so the drop cases are the point.

import { createTelegramControl, type BotApi, type TelegramControl, type TelegramDeps } from "#services/telegram.mts";
import { Logger, type Destinations, type LogLine } from "#services/logger.mts";

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : `\n    ${detail}`}`);
};

const TOKEN = "smoke-token";
const CHAT = "424242";

interface Update {
  update_id: number;
  message?: { text?: string; chat?: { id: number | string } };
}

/** One `getUpdates` answer: what it returns, or what it throws. */
type Poll = Update[] | Error;

let nextId = 1;
const from = (text: string, chat: number | string = CHAT): Update => ({
  update_id: nextId++,
  message: { text, chat: { id: chat } },
});

/** The real control channel with the Bot API substituted: `backlog` answers the confirming
 *  first poll, `script` is answered one entry per `getUpdates` after it, and running out
 *  ENDS the loop — so `done` resolves only once every reply for every update has been
 *  sent. */
function harness(over: Partial<TelegramDeps> = {}, script: Poll[] = [], backlog: Poll = []) {
  const calls: { method: string; token: string; body: Record<string, unknown> }[] = [];
  const lines: LogLine[] = [];
  const dests: Destinations = {
    console: () => {},
    runLog: (line) => void lines.push(line),
    eventLog: () => {},
    github: () => {},
    phone: () => {},
  };

  let control: TelegramControl | undefined;
  let ended: () => void = () => {};
  const done = new Promise<void>((settle) => (ended = settle));
  const answers = [backlog, ...script];
  const api: BotApi = (method, token, body) => {
    calls.push({ method, token, body });
    if (method !== "getUpdates") return Promise.resolve(true);
    const next = answers.shift();
    if (next === undefined) {
      control?.stop();
      ended();
      return Promise.resolve([]);
    }
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };

  control = createTelegramControl({
    token: TOKEN,
    chatId: CHAT,
    log: new Logger(dests).child("telegram"),
    snapshot: () => ({ paused: false, regularInFlight: [], restackInFlight: [], regularQueued: [], restackQueued: [] }),
    pause: () => undefined,
    state: () => ({}),
    fix: () => Promise.resolve("▶ released"),
    resume: () => "▶ resumed",
    api,
    backoffMs: 1,
    ...over,
  });

  return {
    control,
    calls,
    lines,
    done,
    said: (text: string) => lines.some((l) => l.message.includes(text)),
    polls: () => calls.filter((c) => c.method === "getUpdates"),
    replies: () => calls.filter((c) => c.method === "sendMessage"),
    texts: () => calls.filter((c) => c.method === "sendMessage").map((c) => String(c.body.text)),
  };
}

// ── fail closed. The chat id is the whole authz, so a token without one is a poller that
//    would take commands from anybody — and with neither key set the pipeline must be
//    byte-for-byte what it is with no phone at all ──
{
  const h = harness({ token: undefined, chatId: undefined });
  h.control.start();
  ok("unconfigured: nothing is polled at all", h.calls.length === 0, JSON.stringify(h.calls));
  ok("unconfigured: and it is not an error — the phone is an optional layer", h.lines.length === 0, JSON.stringify(h.lines.map((l) => l.message)));

  const half = harness({ chatId: undefined });
  half.control.start();
  ok("half-configured: a token with no chat id polls nothing", half.calls.length === 0, JSON.stringify(half.calls));
  ok(
    "half-configured: and says why, naming the key that is missing",
    half.said("TELEGRAM_CHAT_ID") && half.lines.some((l) => l.level === "error"),
    JSON.stringify(half.lines.map((l) => `${l.level}: ${l.message}`)),
  );
}

// ── the authz. The configured chat is the only one answered, and the reply is addressed
//    to it and never to the sender: a bot that answers whoever wrote is an oracle for the
//    stranger's chat. A dropped update is still CONFIRMED, or it is redelivered forever ──
{
  const mine = harness({}, [[from("/status")]]);
  mine.control.start();
  await mine.done;
  ok("authz: the configured chat is answered", mine.replies().length === 1, JSON.stringify(mine.calls));
  ok("authz: and the reply is addressed to the configured chat", mine.replies()[0]?.body.chat_id === CHAT, JSON.stringify(mine.replies()[0]?.body));

  const theirs = [from("/status", 99), from("/fix acme/finance#57", 99)];
  const stranger = harness({}, [theirs]);
  stranger.control.start();
  await stranger.done;
  ok("authz: a message from any other chat is answered with nothing at all", stranger.replies().length === 0, JSON.stringify(stranger.calls));
  ok("authz: the drop is recorded, naming the chat it came from", stranger.said("99"), JSON.stringify(stranger.lines.map((l) => l.message)));
  ok(
    "authz: it pages a human ONCE — a stranger typing in a loop must not be phone spam",
    stranger.lines.filter((l) => l.level === "error").length === 1,
    JSON.stringify(stranger.lines.map((l) => `${l.level}: ${l.message}`)),
  );
  // Poll 1 dropped the backlog; poll 2 delivered both; poll 3 is the one that proves what
  // was confirmed — an unconfirmed update comes back on every poll, forever.
  ok(
    "authz: a dropped update is still confirmed, so it is not redelivered forever",
    stranger.polls()[2]?.body.offset === theirs[1]!.update_id + 1,
    JSON.stringify(stranger.polls().map((p) => p.body)),
  );
}

// ── `/status`: the whole point of the inbound half — the pipeline's live state on a
//    phone, off the three readers and nothing else. A pause with no resume time is the one
//    a human has to lift, so it must say so ──
{
  const h = harness(
    {
      snapshot: () => ({
        paused: true,
        pauseReason: "in-memory shadow",
        regularInFlight: ["acme/finance#57"],
        restackInFlight: ["restack:acme/finance:feat/9"],
        regularQueued: ["acme/finance#58"],
        restackQueued: [],
      }),
      pause: () => ({ reason: "403 from the agent", since: 0 }),
      state: () => ({
        "acme/finance#12": { status: "quarantined" },
        "acme/finance#13": { status: "failed" },
        "acme/finance#14": { status: "in-flight" },
      }),
    },
    [[from("/status")]],
  );
  h.control.start();
  await h.done;
  const status = h.texts()[0] ?? "";

  ok("status: a halt is reported with the reason the PAUSE FILE recorded, not the scheduler's shadow", status.includes("403 from the agent"), status);
  ok("status: a pause with no resume time says a human has to lift it", status.includes("/resume"), status);
  ok("status: what is running and what is waiting are both there", status.includes("acme/finance#57") && status.includes("acme/finance#58"), status);
  ok("status: a restack in flight is reported too — it holds a branch an issue run wants", status.includes("restack:acme/finance:feat/9"), status);
  ok(
    "status: quarantined items are listed, and only those — nothing else is parked in the state file",
    status.includes("acme/finance#12") && !status.includes("acme/finance#13") && !status.includes("acme/finance#14"),
    status,
  );
}

// ── every reply is bounded: Telegram REJECTS a message over 4096 chars, so an unbounded
//    one is a channel that looks dead exactly when there is most to say ──
{
  const h = harness(
    {
      snapshot: () => ({
        paused: false,
        regularInFlight: [],
        restackInFlight: [],
        regularQueued: Array.from({ length: 400 }, (_, i) => `acme/finance#${i}`),
        restackQueued: [],
      }),
    },
    [[from("/status")]],
  );
  h.control.start();
  await h.done;

  ok("bound: a status longer than the Bot API accepts is truncated below its limit", (h.texts()[0] ?? "").length < 4096, String(h.texts()[0]?.length));
  ok("bound: and says it was truncated, rather than ending mid-word", (h.texts()[0] ?? "").includes("truncated"), h.texts()[0]?.slice(-40));
}

// ── `/fix`: the one command that changes state. The module parses the key out and hands
//    it on AS TYPED — every refusal is the Assignor's, so this file has no second reading
//    of what a parked item is ──
{
  const released: { key: string; hint?: string }[] = [];
  const h = harness(
    { fix: (key, hint) => (released.push({ key, hint }), Promise.resolve(`▶ released ${key}`)) },
    [[from("/fix acme/finance#57 use the v2 client, the v1 one is deprecated")], [from("/fix acme/finance#58")], [from("/fix")]],
  );
  h.control.start();
  await h.done;

  ok(
    "fix: the key goes on as typed and everything after it is the human's steer",
    released[0]?.key === "acme/finance#57" && released[0].hint === "use the v2 client, the v1 one is deprecated",
    JSON.stringify(released),
  );
  ok("fix: the answer is the Assignor's own line, not one composed here", h.texts()[0] === "▶ released acme/finance#57", h.texts()[0]);
  ok("fix: a key with no steer releases with no hint at all", released[1]?.key === "acme/finance#58" && released[1].hint === undefined, JSON.stringify(released));
  ok("fix: with no key nothing is released", released.length === 2, JSON.stringify(released));
  ok("fix: and the human is told what the command wanted", (h.texts()[2] ?? "").includes("/fix"), h.texts()[2]);
}

// ── `/resume` and the two answers a mistyped message gets. A command that answers nothing
//    is indistinguishable from a channel that is down ──
{
  let resumed = 0;
  const h = harness({ resume: () => (resumed++, "▶ pipeline resumed by hand") }, [[from("/resume")], [from("/nope")], [from("/help")]]);
  h.control.start();
  await h.done;

  ok("resume: the pause is lifted by the policy that owns it, and its line is the reply", resumed === 1 && h.texts()[0] === "▶ pipeline resumed by hand", h.texts()[0]);
  ok("unknown: an unrecognised command says so and lists what there is", (h.texts()[1] ?? "").includes("/nope") && (h.texts()[1] ?? "").includes("/status"), h.texts()[1]);
  ok("help: /help lists every command", ["/status", "/fix", "/resume"].every((c) => (h.texts()[2] ?? "").includes(c)), h.texts()[2]);
}

// ── a command whose action throws. The human on the other end is WAITING for an answer,
//    and the loop must still be polling for their next one ──
{
  const h = harness({ fix: () => Promise.reject(new Error("gh: HTTP 401")) }, [[from("/fix acme/finance#57")], [from("/status")]]);
  h.control.start();
  await h.done;

  ok("failure: the human is answered with what broke", (h.texts()[0] ?? "").includes("gh: HTTP 401"), h.texts()[0]);
  ok("failure: and the next command is still answered — one bad command is not the channel", h.texts().length === 2, JSON.stringify(h.texts()));
}

// ── a poll that fails. The loop IS the channel: one throw that escapes it is a bot that
//    looks alive on the phone and answers nothing, forever ──
{
  const h = harness({}, [new Error("fetch failed: ECONNRESET"), new Error("fetch failed: ECONNRESET"), [from("/status")]]);
  h.control.start();
  await h.done;

  ok("poll: the loop survives a failed poll and answers the command after it", h.texts().length === 1, JSON.stringify(h.texts()));
  ok(
    "poll: a repeating failure pages a human ONCE — an error reaches the phone with no debounce",
    h.lines.filter((l) => l.level === "error").length === 1,
    JSON.stringify(h.lines.map((l) => `${l.level}: ${l.message}`)),
  );
  ok("poll: and it says how long it is backing off for", h.said("retrying in"), JSON.stringify(h.lines.map((l) => l.message)));
}

// ── the backlog. `getUpdates` redelivers every unconfirmed update, so a phone that typed
//    `/fix` during a three-hour outage would have it acted on against a pipeline that
//    moved on hours ago ──
{
  const stale = [from("/fix acme/finance#57"), from("/status")];
  const released: string[] = [];
  const h = harness({ fix: (key) => (released.push(key), Promise.resolve("▶ released")) }, [], stale);
  h.control.start();
  await h.done;

  ok("backlog: whatever accumulated while Sunday was down is acted on by nothing", released.length === 0 && h.replies().length === 0, JSON.stringify(h.calls));
  ok("backlog: and it is confirmed, so the first live poll starts after it", h.polls()[1]?.body.offset === stale[1]!.update_id + 1, JSON.stringify(h.polls().map((p) => p.body)));
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
