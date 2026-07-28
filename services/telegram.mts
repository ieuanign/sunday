// services/telegram.mts — the phone's INBOUND half: `getUpdates` long-polling for
// commands, in the one supervised parent (constraint 1 — no port, no tunnel, nothing in
// `process-compose.yaml`). The outbound half is `phoneDestination` in `destinations.mts`,
// and the Bot API call itself lives there: the dependency runs sender → poller and never
// the reverse, because `destinations.mts` is in every forked child's import graph and the
// control channel has no business in a work item's.
//
// It DECIDES NOTHING, like `github/receiver.mts`: the readers and the two actions come in
// through the constructor, every refusal is decided by the module that owns the state and
// comes back as the line to reply with. `TELEGRAM_CHAT_ID` is the whole authz — this file
// is the boundary between a stranger's message and an agent run on real quota.

import type { PauseState } from "#assignor/pause.mts";
import type { SchedulerSnapshot } from "#assignor/scheduler.mts";
import type { WorkItemState } from "#assignor/state.mts";
import { PHONE_MAX, botApi, truncate } from "./destinations.mts";
import type { ModuleLogger } from "./logger.mts";

/** One Bot API call. Injected so the whole channel drives with no network and no token. */
export type BotApi = (method: string, token: string, body: Record<string, unknown>) => Promise<unknown>;

export interface TelegramDeps {
  /** `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`, read by `main.mts`. Optional because the
   *  channel is optional, and the refusal to start without BOTH is this module's. */
  token?: string;
  chatId?: string;
  log: ModuleLogger;
  /** The three readers `/status` renders. Narrow on purpose — this module holds no state
   *  and keeps nothing in step with the modules that do. */
  snapshot: () => SchedulerSnapshot;
  pause: () => PauseState | undefined;
  state: () => Record<string, WorkItemState>;
  /** `/fix` — `Assignor.release`, which takes the key AS TYPED and answers with the line
   *  to reply with. */
  fix: (key: string, hint?: string) => Promise<string>;
  /** `/resume` — `FailurePolicy.resume`, same contract. */
  resume: () => string;
  api?: BotApi;
  /** How long a failed poll waits before the next, doubling to `BACKOFF_CAP` — an
   *  argument so a smoke drives the retry with no wall-clock wait (`forwarder.mts`'s
   *  idiom). */
  backoffMs?: number;
}

export interface TelegramControl {
  /** Fire the poll loop. Returns IMMEDIATELY and is never awaited: `getUpdates` long-polls,
   *  so awaiting it in `main.mts` would hold the boot forever. */
  start(): void;
  stop(): void;
}

/** How long the Bot API holds a poll open with nothing to say. */
const POLL_SECONDS = 30;

const BACKOFF_MS = 5_000;

/** The retry doubles to ~5 minutes and stops there: a bot token that was revoked would
 *  otherwise fail every 5s forever. */
const BACKOFF_CAP = 6;

const HELP = [
  "/status — what the pipeline is doing",
  "/fix <owner>/<repo>#<n> [steer] — release a parked item, with an optional note for the agent",
  "/resume — lift a pause that is waiting on a human",
  "/help — this",
].join("\n");

interface Update {
  update_id: number;
  message?: { text?: string; chat?: { id: number | string } };
}

/** The two keys the channel is nothing without. Narrowed once by `start()` and carried
 *  from there, so nothing below re-decides whether the channel is configured. */
interface Channel {
  token: string;
  chatId: string;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const sleep = (ms: number): Promise<void> => new Promise((settle) => setTimeout(settle, ms));

/** What the pipeline is doing, for a phone. Pure over the three readers, so what a human
 *  sees is asserted without a scheduler, a pause file or a state store. */
export function renderStatus(
  scheduler: SchedulerSnapshot,
  pause: PauseState | undefined,
  state: Record<string, WorkItemState>,
): string {
  const list = (keys: string[]): string => (keys.length === 0 ? "none" : keys.join(", "));
  const quarantined = Object.keys(state).filter((key) => state[key]?.status === "quarantined");
  // The pause FILE is preferred over the scheduler's flag: it is the one that carries the
  // reason and the resume time, and the flag is only ever its shadow.
  const halt = pause
    ? `⏸ paused — ${pause.reason}${pause.resumeAt === undefined ? " (waiting on a human: /resume)" : ` until ${new Date(pause.resumeAt).toISOString()}`}`
    : scheduler.paused
      ? `⏸ paused — ${scheduler.pauseReason ?? "reason unrecorded"}`
      : "▶ running";
  return [
    halt,
    `in flight: ${list(scheduler.regularInFlight)}`,
    `queued: ${list(scheduler.regularQueued)}`,
    `restack: ${list([...scheduler.restackInFlight, ...scheduler.restackQueued])}`,
    `quarantined: ${list(quarantined)}`,
  ].join("\n");
}

export function createTelegramControl(deps: TelegramDeps): TelegramControl {
  const log = deps.log;
  const api = deps.api ?? botApi;
  const backoffMs = deps.backoffMs ?? BACKOFF_MS;
  let running = false;
  /** Confirmed up to here. Advanced for EVERY update, authorized or not: an unconfirmed
   *  update is redelivered forever, so a stranger's message would be re-dropped on every
   *  poll. */
  let offset = 0;
  /** Chats already dropped once — the "said it out loud already" flag (constraint 16). */
  const strangers = new Set<string>();

  /** Always to the CONFIGURED chat, never to `message.chat.id`: replying to the sender
   *  would make the bot an oracle for a chat that just failed authz. */
  async function reply(channel: Channel, text: string): Promise<void> {
    await api("sendMessage", channel.token, {
      chat_id: channel.chatId,
      text: truncate(text, PHONE_MAX),
      disable_web_page_preview: true,
    });
  }

  async function poll(channel: Channel, body: Record<string, unknown>): Promise<Update[]> {
    return (await api("getUpdates", channel.token, body)) as Update[];
  }

  /** One update, from the wire to the reply. Nothing may escape: this runs inside the poll
   *  loop, where a throw is a poll error that backs the whole channel off. */
  async function handle(channel: Channel, update: Update): Promise<void> {
    const text = update.message?.text?.trim();
    if (!text) return;
    const from = String(update.message?.chat?.id);
    if (from !== channel.chatId) {
      // Once per chat, then quiet: `error` reaches the phone with no debounce, and a
      // stranger typing in a loop must not be able to spam it.
      const line = `· dropped a command from unauthorized chat ${from}`;
      if (strangers.has(from)) log.info(line);
      else {
        strangers.add(from);
        log.error(`✗ ${line} — TELEGRAM_CHAT_ID is the only authz there is`);
      }
      return;
    }
    if (!text.startsWith("/")) return;
    const space = text.search(/\s/);
    // Split on `@`, which is the suffix Telegram appends to a command in a group chat.
    const command = (space === -1 ? text : text.slice(0, space)).split("@")[0]?.toLowerCase() ?? "";
    const arg = space === -1 ? "" : text.slice(space + 1).trim();
    let answer: string;
    try {
      answer = await dispatch(command, arg);
    } catch (err) {
      // Answered rather than only logged: there is a human waiting on this one, and a
      // command that says nothing back is indistinguishable from a dead channel.
      answer = `✗ ${command} failed — ${describe(err)}`;
      log.error(answer);
    }
    try {
      await reply(channel, answer);
    } catch (err) {
      log.error(`✗ the reply to ${command} could not be sent — ${describe(err)}`);
    }
  }

  async function dispatch(command: string, arg: string): Promise<string> {
    switch (command) {
      case "/status":
        return renderStatus(deps.snapshot(), deps.pause(), deps.state());
      case "/fix": {
        // Only the key is parsed here; resolving it is `Assignor.release`'s, which owns
        // the spelling and every refusal (constraint 9).
        const space = arg.search(/\s/);
        const key = space === -1 ? arg : arg.slice(0, space);
        if (!key) return "✗ /fix needs a work item key, e.g. /fix acme/finance#57 the failing test is the fixture, not the code";
        return await deps.fix(key, space === -1 ? undefined : arg.slice(space + 1).trim() || undefined);
      }
      case "/resume":
        return deps.resume();
      case "/help":
        return HELP;
      default:
        return `unknown command ${command}\n${HELP}`;
    }
  }

  async function loop(channel: Channel): Promise<void> {
    // The backlog is dropped: `getUpdates` redelivers everything unconfirmed, and a `/fix`
    // from a three-hour outage acts on a pipeline that has moved on. `-1` confirms the lot
    // and returns only the last, which nothing acts on.
    let failures = 0;
    try {
      const stale = await poll(channel, { offset: -1, timeout: 0 });
      offset = (stale.at(-1)?.update_id ?? -1) + 1;
    } catch (err) {
      log.info(`· the backlog could not be confirmed — ${describe(err)}; polling from the start`);
    }
    while (running) {
      try {
        for (const update of await poll(channel, { offset, timeout: POLL_SECONDS })) {
          offset = update.update_id + 1;
          await handle(channel, update);
        }
        failures = 0;
      } catch (err) {
        const delay = backoffMs * 2 ** Math.min(failures++, BACKOFF_CAP);
        // Once-then-quiet: `error` reaches the phone with no debounce, and a bot token
        // that was revoked fails on every poll until a human fixes it.
        const line = `✗ telegram poll failed — ${describe(err)}; retrying in ${delay}ms`;
        if (failures === 1) log.error(line);
        else log.info(line);
        await sleep(delay);
      }
    }
  }

  return {
    start() {
      // Fails closed. No token is the common case and not a failure — the phone is an
      // optional layer, exactly as `phoneDestination` has it.
      const { token, chatId } = deps;
      if (!token) return;
      if (!chatId) {
        log.error("✗ TELEGRAM_BOT_TOKEN is set but TELEGRAM_CHAT_ID is not — refusing to poll: the chat id is the only authz there is");
        return;
      }
      running = true;
      log.info("📱 telegram control: polling for commands");
      // Fired, never awaited (constraint 5), and it never rejects: `loop` catches every
      // iteration, so nothing here can become an unhandled rejection in the parent.
      void loop({ token, chatId });
    },
    stop() {
      running = false;
    },
  };
}
