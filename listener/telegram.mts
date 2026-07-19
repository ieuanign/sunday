// listener/telegram.mts — Telegram control channel (M3.4/M3.5).
//
// $0, POLLING-based (getUpdates) — no webhook, no cloudflared, no public endpoint.
// Two halves:
//   · outbound — sendTelegram() pushes operability notices to your phone (the
//     notify() Telegram sink, M3.3).
//   · inbound  — startTelegramPolling() long-polls for /pause /resume /status …
//     and drives injected handlers (M3.4).
//
// Entirely OPTIONAL: with TELEGRAM_BOT_TOKEN unset, sendTelegram no-ops and the
// poller never starts — the pipeline runs unchanged. The `chat_id` allowlist is the
// ONLY authz, and it's sufficient because polling exposes no forgeable surface: we
// dial Telegram out, updates arrive only over our authenticated poll, and an update
// from any other chat is dropped.

const API = "https://api.telegram.org";

/** One Bot API call. Throws on a transport error or an `ok:false` response. */
async function tgApi(method: string, params: Record<string, unknown>): Promise<unknown> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN unset");
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  const json = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
  if (!json.ok) throw new Error(`telegram ${method} failed: ${json.description ?? res.status}`);
  return json.result;
}

/** Push a one-line notice to the configured chat. Returns a promise so the caller
 *  (notify) can attach a `.catch` for degraded-tracking; the caller does not await
 *  it (fire-and-forget — the durable event log is the source of truth). Resolves to
 *  a no-op when unconfigured. */
export function sendTelegram(text: string): Promise<void> {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!process.env.TELEGRAM_BOT_TOKEN || !chatId) return Promise.resolve();
  return tgApi("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true }).then(() => undefined);
}

// ── Inbound: the command poller (M3.4) ───────────────────────────────────────

/** The pipeline-control seams a command drives. Injected by the listener (where
 *  the scheduler + pause-state live) so this module needs no import of listen.mts —
 *  keeps it a leaf, no cycle. */
export interface TelegramHandlers {
  pause: (reason: string) => void;
  resume: () => void;
  resumeAt: (epochMs: number) => void;
  status: () => string;
}

const HELP = [
  "commands:",
  "/status — pipeline, issues, recent events",
  "/pause [reason] — stall both lanes",
  "/resume — lift a pause",
  "/resume-at <ISO> — resume at a time (e.g. /resume-at 2026-07-19T21:00:00Z)",
  "/help — this",
].join("\n");

/** Parse a Telegram message into a command + argument, or null if it isn't a
 *  command. Strips the `@botname` suffix Telegram appends in groups. Pure. */
export function parseCommand(text: string): { cmd: string; arg: string } | null {
  const t = text.trim();
  if (!t.startsWith("/")) return null;
  const sp = t.indexOf(" ");
  let cmd = sp === -1 ? t : t.slice(0, sp);
  const arg = sp === -1 ? "" : t.slice(sp + 1).trim();
  const at = cmd.indexOf("@");
  if (at !== -1) cmd = cmd.slice(0, at);
  return { cmd: cmd.toLowerCase(), arg };
}

/** The sole authz: the update's chat id must equal the configured allowlist. No
 *  allowlist → deny everything (fail closed). Pure. */
export function isAllowedChat(chatId: number | string | undefined, allow: string | undefined): boolean {
  return allow !== undefined && allow !== "" && String(chatId) === allow;
}

/** Route a parsed command to a handler and return the reply text. Pure over the
 *  injected handlers (they carry the side effects). Unknown/invalid → a help reply. */
export function dispatchCommand(cmd: string, arg: string, h: TelegramHandlers): string {
  switch (cmd) {
    case "/pause": {
      const reason = arg || "manual (telegram)";
      h.pause(reason);
      return `⏸ paused — ${reason}`;
    }
    case "/resume":
      h.resume();
      return "▶ resumed";
    case "/resume-at": {
      const at = Date.parse(arg);
      if (Number.isNaN(at)) return "⚠️ /resume-at needs an ISO time, e.g. /resume-at 2026-07-19T21:00:00Z";
      h.resumeAt(at);
      return `⏰ will resume at ${new Date(at).toISOString()}`;
    }
    case "/status":
      return h.status();
    case "/help":
      return HELP;
    default:
      return `unknown command ${cmd}\n${HELP}`;
  }
}

interface TgUpdate {
  update_id: number;
  message?: { text?: string; chat?: { id: number } };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Start the long-poll loop if configured. No-op when the token is unset (optional
 *  layer); refuses to start without an allowlist (no authz = no polling). The loop
 *  survives transient network errors (backoff + retry) and never rejects. */
export function startTelegramPolling(handlers: TelegramHandlers): void {
  if (!process.env.TELEGRAM_BOT_TOKEN) return; // disabled
  const allow = process.env.TELEGRAM_CHAT_ID;
  if (!allow) {
    console.warn("⚠ TELEGRAM_BOT_TOKEN set but TELEGRAM_CHAT_ID unset — refusing to poll (no authz).");
    return;
  }
  console.log("📱 telegram control: polling for commands");
  void pollLoop(handlers, allow);
}

async function pollLoop(handlers: TelegramHandlers, allow: string): Promise<void> {
  // getUpdates and a set webhook are mutually exclusive — clear any stale webhook.
  try {
    await tgApi("deleteWebhook", {});
  } catch {
    /* none set / transient — the getUpdates below will surface a real problem */
  }
  let offset = 0;
  for (;;) {
    try {
      const updates = (await tgApi("getUpdates", { offset, timeout: 30 })) as TgUpdate[];
      for (const u of updates) {
        offset = u.update_id + 1;
        handleUpdate(u, handlers, allow);
      }
    } catch (err) {
      console.log(`  · telegram poll error — ${err instanceof Error ? err.message : String(err)}; retry in 5s`);
      await sleep(5_000);
    }
  }
}

function handleUpdate(u: TgUpdate, handlers: TelegramHandlers, allow: string): void {
  const text = u.message?.text;
  if (!text) return;
  const chatId = u.message?.chat?.id;
  if (!isAllowedChat(chatId, allow)) {
    console.log(`  · telegram: dropped a command from unauthorized chat ${chatId}`);
    return;
  }
  const parsed = parseCommand(text);
  if (!parsed) return;
  let reply: string;
  try {
    reply = dispatchCommand(parsed.cmd, parsed.arg, handlers);
  } catch (err) {
    reply = `⚠️ ${parsed.cmd} failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  void sendTelegram(reply).catch(() => {});
}
