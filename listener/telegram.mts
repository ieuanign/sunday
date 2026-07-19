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
