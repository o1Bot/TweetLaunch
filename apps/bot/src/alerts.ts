import { env, logger, type ChainKey } from "@o1bot/shared";

/**
 * Operator alerts: a Telegram message whenever something the user paid for
 * or waited on went wrong (a launch or trade that failed, a reply X refused,
 * the poller failing repeatedly, the worker crashing), plus one line at
 * boot. Never on the request path: every send is fire-and-forget, errors
 * are logged and swallowed, and the same alert key is sent at most once per
 * window so a user retrying five times produces one message.
 *
 * Configure with ALERT_TELEGRAM_BOT_TOKEN (from @BotFather) and
 * ALERT_TELEGRAM_CHAT_ID (your own chat or a private group the bot is in).
 * Without them alerts are a no-op.
 */

export type AlertKind = "boot" | "crash" | "launch_failed" | "trade_failed" | "reply_failed" | "parser_failed" | "poll_failing" | "worker_crashed";

export type Alert = {
  kind: AlertKind;
  title: string;
  /** Label / value pairs rendered one per line; values are shown verbatim (escaped for the channel). */
  fields: Array<[label: string, value: string | null | undefined]>;
  /** Alerts sharing a key within the dedupe window collapse into one message. */
  key?: string;
};

export type Alerter = {
  send(alert: Alert): void;
};

export const noAlerts: Alerter = { send: () => undefined };

const DEDUPE_MS = 10 * 60_000;
const TELEGRAM = "https://api.telegram.org";

const EMOJI: Record<AlertKind, string> = {
  boot: "🟢",
  crash: "🔴",
  launch_failed: "🟠",
  trade_failed: "🟠",
  reply_failed: "🟡",
  parser_failed: "🟡",
  poll_failing: "🟡",
  worker_crashed: "🔴",
};

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Telegram HTML for one alert: bold title, then `label: value` lines, long values clipped. */
export function formatAlert(alert: Alert): string {
  const lines = [`${EMOJI[alert.kind]} <b>${escapeHtml(alert.title)}</b>`];
  for (const [label, value] of alert.fields) {
    if (value === null || value === undefined || value === "") continue;
    const v = value.length > 400 ? `${value.slice(0, 400)}…` : value;
    lines.push(`<b>${escapeHtml(label)}:</b> ${escapeHtml(v)}`);
  }
  return lines.join("\n");
}

export function telegramAlerter(opts: { token: string; chatId: string; fetchImpl?: typeof fetch; now?: () => number }): Alerter {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => Date.now());
  const lastSent = new Map<string, number>();

  return {
    send(alert) {
      const key = alert.key ?? `${alert.kind}:${alert.title}`;
      const t = now();
      const prev = lastSent.get(key);
      if (prev !== undefined && t - prev < DEDUPE_MS) return;
      lastSent.set(key, t);
      // Keep the map small: forget keys older than the window.
      if (lastSent.size > 500) for (const [k, at] of lastSent) if (t - at >= DEDUPE_MS) lastSent.delete(k);

      const body = JSON.stringify({ chat_id: opts.chatId, text: formatAlert(alert), parse_mode: "HTML", disable_web_page_preview: true });
      void fetchImpl(`${TELEGRAM}/bot${opts.token}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(10_000) })
        .then(async (res) => {
          if (!res.ok) logger.warn({ status: res.status, body: (await res.text().catch(() => "")).slice(0, 200) }, "telegram alert refused");
        })
        .catch((err) => logger.warn({ err: err instanceof Error ? err.message : String(err) }, "telegram alert failed"));
    },
  };
}

/** The alerter the environment configures, or a no-op. */
export function alerterFromEnv(): Alerter {
  const e = env();
  if (!e.ALERT_TELEGRAM_BOT_TOKEN || !e.ALERT_TELEGRAM_CHAT_ID) return noAlerts;
  return telegramAlerter({ token: e.ALERT_TELEGRAM_BOT_TOKEN, chatId: e.ALERT_TELEGRAM_CHAT_ID });
}

export const postUrl = (handle: string, tweetId: string) => `https://x.com/${handle}/status/${tweetId}`;
export const txUrl = (hash: string, chain: ChainKey = "robinhood") => (chain === "base" ? `https://basescan.org/tx/${hash}` : `https://rh-scan.com/tx/${hash}`);
