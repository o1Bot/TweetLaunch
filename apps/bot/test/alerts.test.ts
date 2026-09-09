import { describe, expect, it, vi } from "vitest";
import { formatAlert, telegramAlerter } from "../src/alerts";

describe("formatAlert", () => {
  it("renders a bold title and label/value lines, escaping HTML and clipping long values", () => {
    const text = formatAlert({ kind: "launch_failed", title: "Launch failed <x>", fields: [["User", "@alice"], ["Empty", null], ["Error", "a".repeat(500)]] });
    expect(text.startsWith("🟠 <b>Launch failed &lt;x&gt;</b>")).toBe(true);
    expect(text).toContain("<b>User:</b> @alice");
    expect(text).not.toContain("Empty");
    expect(text).toContain("…");
    expect(text.length).toBeLessThan(600);
  });
});

describe("telegramAlerter", () => {
  it("posts to Telegram once per key inside the dedupe window, then again after it", async () => {
    let t = 1_000_000;
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const alerter = telegramAlerter({ token: "tok", chatId: "42", fetchImpl: fetchImpl as unknown as typeof fetch, now: () => t });
    const alert = { kind: "trade_failed" as const, title: "Trade failed", fields: [["Trade", "t1"] as [string, string]], key: "trade:alice" };
    alerter.send(alert);
    alerter.send(alert);
    alerter.send({ ...alert, key: "trade:bob" });
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.telegram.org/bottok/sendMessage");
    const body = JSON.parse(init.body as string) as { chat_id: string; parse_mode: string; text: string };
    expect(body.chat_id).toBe("42");
    expect(body.parse_mode).toBe("HTML");
    expect(body.text).toContain("Trade failed");
    t += 11 * 60_000;
    alerter.send(alert);
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("never throws when Telegram is down", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network");
    });
    const alerter = telegramAlerter({ token: "tok", chatId: "42", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(() => alerter.send({ kind: "boot", title: "up", fields: [] })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});
