import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@o1bot/shared";
import { O1PinError, o1PinBody, o1PinConfigured, pinViaO1, toIpfsUri, type O1PinInput } from "../src/o1-pin";

const input: O1PinInput = {
  chainId: 4663,
  creator: "0x830C9027454b5B8e6896240a0aae1b98C2c07dCa",
  market: "standard",
  quoteAddress: "0x0000000000000000000000000000000000000000",
  name: "o1Bot",
  symbol: "O1BOT",
  description: "Launch a token from a post.",
  image: { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mime: "image/png" },
  website: "https://o1bot.exchange",
  x: "https://x.com/o1bot_exchange",
  telegram: "https://t.me/o1bot",
};

const okJson = { data: { metadata_uri: "ipfs://bafkreimeta", image_url: "https://sapphire-negative-junglefowl-959.mypinata.cloud/ipfs/bafkreiimage" } };
const respond = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("o1PinBody", () => {
  it("maps the launch into o1's request shape with a base64 image", () => {
    const body = o1PinBody(input) as { token: Record<string, unknown> };
    expect(body).toMatchObject({ chain_id: 4663, market: "standard", quote_address: input.quoteAddress, creator: input.creator });
    expect(body.token).toMatchObject({ name: "o1Bot", symbol: "O1BOT", image_type: "image/png", editable_metadata: false, extra_metadata: [] });
    expect(body.token.image_base64).toBe(Buffer.from(input.image.bytes).toString("base64"));
    expect(body.token).toMatchObject({ website: input.website, x: input.x, telegram: input.telegram });
  });

  it("drops links the API would reject instead of failing the request", () => {
    const body = o1PinBody({ ...input, website: "not a url", x: "https://twitter.com/o1bot_exchange", telegram: "@o1bot" }) as { token: Record<string, unknown> };
    expect(body.token).toMatchObject({ website: "", x: "", telegram: "" });
  });

  it("keeps the description inside o1's 2000-byte limit", () => {
    const body = o1PinBody({ ...input, description: "é".repeat(1500) }) as { token: { description: string } };
    expect(Buffer.byteLength(body.token.description, "utf8")).toBeLessThanOrEqual(2000);
  });
});

describe("toIpfsUri", () => {
  it("turns a gateway URL into an ipfs URI and leaves other URLs alone", () => {
    expect(toIpfsUri("https://x.mypinata.cloud/ipfs/bafkreiabc?img-width=64")).toBe("ipfs://bafkreiabc");
    expect(toIpfsUri("https://example.com/logo.png")).toBe("https://example.com/logo.png");
  });
});

describe("pinViaO1", () => {
  beforeEach(() => {
    process.env.O1_API_KEY = "test-key";
    process.env.O1_API_URL = "https://api.example.test/v1/";
    resetEnvCache();
  });
  afterEach(() => {
    delete process.env.O1_API_KEY;
    delete process.env.O1_API_URL;
    resetEnvCache();
  });

  it("is configured only when a key is present", () => {
    expect(o1PinConfigured()).toBe(true);
    process.env.O1_API_KEY = "";
    resetEnvCache();
    expect(o1PinConfigured()).toBe(false);
  });

  it("posts to /launches/prepare with the key and an idempotency key, and returns the pinned URIs", async () => {
    const fetchImpl = vi.fn(respond(200, okJson));
    const out = await pinViaO1(input, fetchImpl as unknown as typeof fetch);
    expect(out).toEqual({ metadataUri: "ipfs://bafkreimeta", imageUri: "ipfs://bafkreiimage", imageUrl: okJson.data.image_url });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.test/v1/launches/prepare");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("test-key");
    expect(headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(init.body as string).token.symbol).toBe("O1BOT");
  });

  it("surfaces o1's problem code so the caller can log why it fell back", async () => {
    const fetchImpl = respond(422, { code: "insufficient_balance", detail: "creator holds 0 ETH" });
    const err = await pinViaO1(input, fetchImpl as unknown as typeof fetch).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(O1PinError);
    expect((err as O1PinError).status).toBe(422);
    expect((err as O1PinError).code).toBe("insufficient_balance");
    expect((err as O1PinError).message).toContain("creator holds 0 ETH");
  });

  it("refuses a response without both URIs", async () => {
    const fetchImpl = respond(200, { data: { metadata_uri: "https://not-ipfs", image_url: null } });
    await expect(pinViaO1(input, fetchImpl as unknown as typeof fetch)).rejects.toBeInstanceOf(O1PinError);
  });
});
