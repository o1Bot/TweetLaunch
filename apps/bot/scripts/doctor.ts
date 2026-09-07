/**
 * Check every configured credential with read-only calls and print one line
 * per service. Prints names and statuses only, never a secret value.
 *
 *   pnpm doctor
 *
 * Nothing here posts, signs, pins or writes to the database.
 */
import "@o1bot/shared/load-env";
import IORedis from "ioredis";
import { createPublicClient, http, parseAbiItem } from "viem";
import { robinhood } from "viem/chains";
import { db, dbConfigured } from "@o1bot/db";
import { DEFAULT_PARSER_MODEL } from "@o1bot/parser";
import { env, o1Chain } from "@o1bot/shared";
import { privy } from "@o1bot/wallet";
import { oauthAuthorizationHeader } from "@o1bot/x";

type Result = { service: string; status: "ok" | "fail" | "skip"; detail: string };
const results: Result[] = [];
const ok = (service: string, detail: string) => results.push({ service, status: "ok", detail });
const fail = (service: string, detail: string) => results.push({ service, status: "fail", detail });
const skip = (service: string, detail: string) => results.push({ service, status: "skip", detail });
/** First line of an error, with URLs removed: RPC errors echo the request URL, which can carry an API key. */
const errMsg = (e: unknown) =>
  (e instanceof Error ? e.message : String(e))
    .replace(/https?:\/\/\S+/g, "<url>")
    .split("\n")[0]!.slice(0, 160);

async function checkDatabase() {
  if (!dbConfigured()) return skip("database", "DATABASE_URL not set");
  try {
    const tables = await db().$queryRaw<Array<{ table_name: string }>>`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`;
    const names = new Set(tables.map((t) => t.table_name));
    const expected = ["User", "Mention", "Launch", "SignedTransaction", "BotCursor", "Pool", "Swap", "IndexerCursor"];
    const missing = expected.filter((t) => !names.has(t));
    if (missing.length) fail("database", `connected, but tables missing: ${missing.join(", ")}. Run pnpm db:push`);
    else ok("database", `connected, ${expected.length} tables present`);
  } catch (e) {
    fail("database", errMsg(e));
  }
}

async function checkRedis() {
  const e = env();
  if (e.QUEUE_DRIVER !== "redis") return skip("redis", `QUEUE_DRIVER=${e.QUEUE_DRIVER}`);
  if (!e.REDIS_URL) return fail("redis", "QUEUE_DRIVER=redis but REDIS_URL is empty");
  const client = new IORedis(e.REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 10_000, lazyConnect: true });
  try {
    await client.connect();
    ok("redis", `PING ${await client.ping()}`);
  } catch (err) {
    fail("redis", errMsg(err));
  } finally {
    client.disconnect();
  }
}

async function checkRpc(label: string, url: string | undefined, wantLogs: boolean) {
  if (!url) return skip(label, "not set (public RPCs will be used)");
  const client = createPublicClient({ chain: robinhood, transport: http(url, { timeout: 20_000, retryCount: 0 }) });
  try {
    const [chainId, block] = await Promise.all([client.getChainId(), client.getBlockNumber()]);
    if (chainId !== 4663) return fail(label, `chain id ${chainId}, expected 4663 (Robinhood Chain)`);
    let detail = `chain 4663, block ${block}`;
    if (wantLogs) {
      const swap = parseAbiItem("event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)");
      // The indexer always filters by pool id (topic 1), so test that shape, not a raw firehose query.
      const cgmPool = "0xab56d44e3c684921443403b75e8144ec379a3ffbb5f5d64f18c76f2d79e8ad1d";
      try {
        const logs = await client.getLogs({ address: o1Chain("robinhood").uniswapV4.poolManager, event: swap, args: { id: cgmPool }, fromBlock: block - 50_000n, toBlock: block });
        detail += `, pool-filtered getLogs over 50k blocks ok (${logs.length} swaps)`;
      } catch (err) {
        return fail(label, `${detail}, but pool-filtered getLogs over 50k blocks failed: ${errMsg(err)}`);
      }
    }
    ok(label, detail);
  } catch (err) {
    fail(label, errMsg(err));
  }
}

async function checkX() {
  const e = env();
  if (!e.X_BEARER_TOKEN) return skip("x bearer", "X_BEARER_TOKEN not set");
  try {
    const res = await fetch(`https://api.x.com/2/users/by/username/${encodeURIComponent(e.X_BOT_HANDLE)}`, { headers: { Authorization: `Bearer ${e.X_BEARER_TOKEN}` }, signal: AbortSignal.timeout(15_000) });
    const json = (await res.json()) as { data?: { id: string; username: string }; title?: string; detail?: string };
    if (!res.ok || !json.data) return fail("x bearer", `HTTP ${res.status} ${json.title ?? ""} ${json.detail ?? ""}`.trim());
    const idNote = e.X_BOT_USER_ID ? (e.X_BOT_USER_ID === json.data.id ? "matches X_BOT_USER_ID" : `X_BOT_USER_ID is ${e.X_BOT_USER_ID} but @${json.data.username} is ${json.data.id}`) : `set X_BOT_USER_ID=${json.data.id}`;
    (e.X_BOT_USER_ID && e.X_BOT_USER_ID !== json.data.id ? fail : ok)("x bearer", `@${json.data.username} → id ${json.data.id}; ${idNote}`);
  } catch (err) {
    fail("x bearer", errMsg(err));
  }

  if (!(e.X_APP_KEY && e.X_APP_SECRET && e.X_APP_ACCESS_TOKEN && e.X_APP_ACCESS_TOKEN_SECRET)) return skip("x oauth1", "X_APP_* tokens not all set (replies disabled)");
  try {
    const url = "https://api.x.com/2/users/me";
    const header = oauthAuthorizationHeader("GET", url, { consumerKey: e.X_APP_KEY, consumerSecret: e.X_APP_SECRET, token: e.X_APP_ACCESS_TOKEN, tokenSecret: e.X_APP_ACCESS_TOKEN_SECRET });
    const res = await fetch(url, { headers: { Authorization: header }, signal: AbortSignal.timeout(15_000) });
    const json = (await res.json()) as { data?: { id: string; username: string }; title?: string; detail?: string };
    if (!res.ok || !json.data) return fail("x oauth1", `HTTP ${res.status} ${json.title ?? ""} ${json.detail ?? ""}`.trim());
    const same = json.data.username.toLowerCase() === e.X_BOT_HANDLE.toLowerCase();
    (same ? ok : fail)("x oauth1", same ? `tokens belong to @${json.data.username}; write permission is only proven by the first reply` : `tokens belong to @${json.data.username}, not @${e.X_BOT_HANDLE}: replies would come from the wrong account`);
  } catch (err) {
    fail("x oauth1", errMsg(err));
  }
}

async function checkAnthropic() {
  const e = env();
  if (!e.ANTHROPIC_API_KEY) return skip("anthropic", "ANTHROPIC_API_KEY not set");
  const model = e.PARSER_MODEL || DEFAULT_PARSER_MODEL;
  try {
    const res = await fetch(`https://api.anthropic.com/v1/models/${encodeURIComponent(model)}`, { headers: { "x-api-key": e.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return fail("anthropic", `HTTP ${res.status} for model ${model}`);
    ok("anthropic", `key valid, model ${model} available`);
  } catch (err) {
    fail("anthropic", errMsg(err));
  }
}

async function checkPinata() {
  const e = env();
  if (!e.PINATA_JWT) return skip("pinata", "PINATA_JWT not set");
  try {
    const res = await fetch("https://api.pinata.cloud/data/testAuthentication", { headers: { Authorization: `Bearer ${e.PINATA_JWT}` }, signal: AbortSignal.timeout(15_000) });
    (res.ok ? ok : fail)("pinata", res.ok ? "JWT valid" : `HTTP ${res.status}`);
  } catch (err) {
    fail("pinata", errMsg(err));
  }
}

async function checkPrivy() {
  const e = env();
  if (!(e.PRIVY_APP_ID && e.PRIVY_APP_SECRET)) return skip("privy", "PRIVY_APP_ID / PRIVY_APP_SECRET not set");
  try {
    const user = await privy().getUserByTwitterUsername(e.X_BOT_HANDLE);
    ok("privy", `credentials valid (lookup of @${e.X_BOT_HANDLE}: ${user ? "has a Privy user" : "no Privy user yet, which is fine"})`);
  } catch (err) {
    fail("privy", errMsg(err));
  }
}

async function checkO1Api() {
  const e = env();
  if (!e.O1_API_KEY) return skip("o1 api", "O1_API_KEY not set (holders tab will be empty)");
  try {
    const res = await fetch(`${e.O1_API_URL.replace(/\/$/, "")}/health`, { headers: { "x-api-key": e.O1_API_KEY }, signal: AbortSignal.timeout(15_000) });
    (res.ok ? ok : fail)("o1 api", res.ok ? "reachable" : `HTTP ${res.status}`);
  } catch (err) {
    fail("o1 api", errMsg(err));
  }
}

async function main() {
  const e = env();
  const present = Object.entries(process.env)
    .filter(([k, v]) => /^(X_|PRIVY_|ANTHROPIC_|PINATA_|RPC_|INDEXER_|O1_|DATABASE_|REDIS_|QUEUE_|DRY_RUN|SITE_URL|NEXT_PUBLIC_|MAX_|LAUNCH_|DEV_BUY|PARSER_)/.test(k) && v)
    .map(([k]) => k)
    .sort();
  console.log(`DRY_RUN=${e.DRY_RUN}  SITE_URL=${e.SITE_URL}`);
  console.log(`set: ${present.join(" ")}\n`);
  await checkDatabase();
  await checkRedis();
  await checkRpc("rpc", e.RPC_ROBINHOOD, false);
  await checkRpc("indexer rpc", e.INDEXER_RPC ?? e.RPC_ROBINHOOD, true);
  await checkX();
  await checkAnthropic();
  await checkPinata();
  await checkPrivy();
  await checkO1Api();
  for (const r of results) console.log(`${r.status.toUpperCase().padEnd(5)} ${r.service.padEnd(12)} ${r.detail}`);
  const failed = results.filter((r) => r.status === "fail").length;
  console.log(`\n${failed ? `${failed} check(s) failed` : "all configured services answered"}`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(errMsg(err));
  process.exit(1);
});
