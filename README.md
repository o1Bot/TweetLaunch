# o1bot.exchange

Tweet-to-launch bot for o1 Launchpad. Mention `@o1bot_exchange` on X with a launch command; the bot parses it, deploys the token through o1's own factory on Robinhood Chain from the user's Privy wallet, and replies with the result. v1 is Robinhood Chain only (chain id 4663); Base is out of scope.

## Layout

```
config/            o1 contract snapshot (dated; regenerate with `pnpm o1:sync`)
abis/              verified ABIs (Sourcify + Blockscout must agree; `pnpm abi:vendor`)
packages/shared    env, logger, chain + RPC fallbacks, o1 registry access, tx allow-list
packages/db        Prisma schema + client (users, mentions, launches, signed-tx audit)
packages/wallet    Privy server SDK: X user → wallet, pregeneration, guarded signer
packages/executor  factory reads, salt mining, metadata pinning, dev-buy route, planLaunch (simulate only)
packages/parser    Claude mention parser: structured output, deterministic normalisation, fixtures
packages/market    price math (sqrtPriceX96), swap classification, candles, stats
apps/web           Next.js front end (Privy X login, wallet + delegation, onboarding)
apps/bot           worker: listener → parser → validator → queue → executor → replier
apps/indexer       follows o1bot launch pools: swaps, prices, fees, crash-safe cursor
docs/              product documentation site (single static page, deploy to docs.o1bot.exchange)
scripts/           maintenance scripts (o1 sync, ABI vendoring)
```

## Status

| Step | Scope | State |
| ---- | ----- | ----- |
| 1 | Wallet + login (Privy), DB schema, o1 snapshot, tx allow-list | done |
| 2 | Chain executor: verified ABIs, live factory reads, `01` salt mining, metadata pinning, dev-buy route, simulation (no broadcast) | done |
| 3 | Parser (Claude, structured output) with test fixtures | done (live fixture run pending an API key) |
| 4 | X listener, validator, queue (memory or BullMQ), signing + broadcast behind `DRY_RUN`, localized replies | done; 42 tests with fakes, live run pending keys |
| 5 | Front end: board and token page (chart, trades, holders, creator post) | done; swap execution next |
| 6 | Indexer (swaps, prices, candles) | done; needs a paid RPC and Postgres to run |

## Quickstart

```bash
pnpm install
cp .env.example .env            # one file at the repo root for every app; keep DRY_RUN=true
pnpm o1:sync                    # refresh config/o1.json from docs.o1.exchange
pnpm abi:vendor                 # re-vendor ABIs when o1:sync reports drift
pnpm db:generate                # Prisma client
pnpm db:push                    # create tables in DATABASE_URL (dev only; use migrate for prod)
pnpm typecheck && pnpm test
pnpm dev:web                    # http://localhost:3000 — sign in with X, fund wallet, delegate signing
pnpm dev:bot                    # verifies the o1 registry, then polls X every X_POLL_MS
```

Dry-run a launch against the live factory without sending anything:

```bash
pnpm simulate --name "Rugrat" --symbol RUGRAT --pair ETH
pnpm simulate --name "Rugrat" --symbol RUGRAT --pair ETH --devbuy 0.01
pnpm simulate --name "Nvidia Dog" --symbol NVDOG --pair NVDA
```

The plan reports the predicted token address (always ending in `01`), pool id, gas, the exact native value, and the creator's real balance versus what the launch needs. A random creator is funded virtually through an `eth_call` state override so the simulation runs on an empty wallet; pass `--creator 0x…` to simulate a real one.

Parse a mention, or run the 24 parser fixtures, against the live model (needs `ANTHROPIC_API_KEY`):

```bash
pnpm parse '@o1bot_exchange launch $RUGRAT "Rugrat" pair ETH on robinhood'
pnpm parse --fixtures
```

## Environment

Locally there is one `.env`, at the repository root, and every entry point loads it from there no matter which package directory pnpm started the process in (`packages/shared/src/load-env.ts`; Next.js gets the same file through `next.config.ts`, Prisma through `prisma.config.ts`). In production there is no file: each host holds only the variables its service reads, and shell variables always win over the file.

`.env.example` tags every section with the services that read it. Fill the root `.env` once, then:

```bash
pnpm env:split        # deploy/web.env, deploy/bot.env, deploy/indexer.env, deploy/db.env (gitignored)
```

Each file is paste-ready for the host's raw environment editor and ends with the list of variables that are still empty. Hosted services get `LOG_PRETTY=false`; when the database or Redis lives on Railway, the bot and indexer files reference them as `${{Postgres.DATABASE_URL}}` and `${{Redis.REDIS_URL}}` so Railway resolves the private-network address itself, while the web file keeps the public URL because Vercel sits outside that network. Locally, always use Railway's public URL (`DATABASE_PUBLIC_URL` on the Postgres service); the `*.railway.internal` host only resolves inside Railway.

| Service | Host | Reads |
| ------- | ---- | ----- |
| web | Vercel, root directory `apps/web` | `DATABASE_URL`, `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `NEXT_PUBLIC_PRIVY_APP_ID`, `NEXT_PUBLIC_DOCS_URL`, `NEXT_PUBLIC_X_URL`, `NEXT_PUBLIC_GITHUB_URL`, `NEXT_PUBLIC_CONTACT_EMAIL`, `RPC_ROBINHOOD`, `O1_API_URL`, `O1_API_KEY`, `IPFS_GATEWAY`, `LOG_LEVEL`, `LOG_PRETTY` |
| bot | Railway | `DRY_RUN`, `SITE_URL`, `DOCS_URL`, `DATABASE_URL`, `QUEUE_DRIVER`, `REDIS_URL`, `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `X_BEARER_TOKEN`, `X_APP_KEY`, `X_APP_SECRET`, `X_APP_ACCESS_TOKEN`, `X_APP_ACCESS_TOKEN_SECRET`, `X_BOT_USER_ID`, `X_BOT_HANDLE`, `X_POLL_MS`, `ANTHROPIC_API_KEY`, `PARSER_MODEL`, `PINATA_JWT`, `RPC_ROBINHOOD`, `MAX_LAUNCHES_PER_USER_PER_DAY`, `LAUNCH_COOLDOWN_SECONDS`, `MAX_DEV_BUY_ETH`, `DEV_BUY_SLIPPAGE_BPS`, `MAX_REPLIES_PER_USER_PER_DAY`, `LOG_LEVEL`, `LOG_PRETTY` |
| indexer | Railway | `DATABASE_URL`, `INDEXER_RPC`, `RPC_ROBINHOOD`, `INDEXER_POLL_MS`, `INDEXER_START_BLOCK`, `IPFS_GATEWAY`, `LOG_LEVEL`, `LOG_PRETTY` |
| db | your machine | `DATABASE_URL` for `pnpm db:push` / `pnpm db:migrate` against the production database |

`INDEXER_DEV_TOKENS`, `INDEXER_END_BLOCK` and `SHOW_DEV_TOKENS` are local-preview switches and never leave your machine. With `DRY_RUN=true` every missing service falls back to an in-memory or dry-run stand-in and says so in the log.

## Deploying

One Postgres database (Railway Postgres or Neon) is shared by all three services. Create it first, put its URL in `DATABASE_URL`, and run `pnpm db:push` from your machine to create the tables.

**Vercel (web).** Import the GitHub repository and set Root Directory to `apps/web`; Vercel installs the pnpm workspace from the repository root on its own, and the web `build` script generates the Prisma client before `next build`, so the default build command (`pnpm run build`) is enough. Paste `deploy/web.env` into Environment Variables. `NEXT_PUBLIC_*` values are baked in at build time, so a change to them needs a redeploy.

**Railway (bot and indexer).** Create two services from the same repository and keep Root Directory at the repository root (empty or `/`): a subfolder such as `apps/bot` hides the pnpm workspace and lockfile, so Railway falls back to npm and fails on `workspace:*`. `railway.toml` selects the root `Dockerfile` (Node 22 on Debian slim, pnpm 11, Prisma client generated at build). For each service: set Start Command `pnpm --filter @o1bot/bot start` or `pnpm --filter @o1bot/indexer start` (both generate the Prisma client before starting), and paste the matching `deploy/*.env` into Variables → Raw Editor. Add a Railway Redis service and set `QUEUE_DRIVER=redis` with its `REDIS_URL` when the bot should survive restarts with jobs intact. Keep `DRY_RUN=true` on the first deploy, watch a few mentions go through the log, do one real launch with the minimum fee from a fresh wallet, then set `DRY_RUN=false`.

## Parser

`packages/parser` turns one post into a `ParseResult`: `launch`, `clarify` (launch intent with a missing or ambiguous value, plus one question in the user's language), `unsupported_chain`, `help` (a short reply in the user's language), or `ignore`. The model returns a flat structured object (`client.messages.parse` with a zod `output_config.format`); `normalizeParseOutput` then enforces the rules deterministically: ticker 1-11 uppercase letters or digits, name at most 50 characters, pair required, dev-buy amounts only as plain ETH decimals, handles normalised. A launch that fails those checks becomes a `clarify`, never a guess. The system prompt carries the full pair menu from `config/o1.json` so company names map to stock symbols, and it is cached as a stable prefix. The model is `claude-sonnet-4-6` by default (`PARSER_MODEL` overrides it; sampling parameters are only sent to models that accept them). A chain that is not stated is treated as Robinhood; a stated other chain is refused.


## How a launch is built

1. `config/o1.json` is checked against o1's live registry; any factory rotation aborts the run.
2. `configVersion`, `launchSupply`, `tickSpacing`, `nativeLaunchFee`, `launchCreationEnabled`, `TOKEN_ADDRESS_SUFFIX`, the token deployer, the hook and the pair's `quoteConfig` are read at one block.
3. `launchTokenBytecodeHash` is read once (it does not depend on the salt), then a `creatorSalt` is mined locally so that `CREATE2(deployer, keccak256(abi.encode(creator, creatorSalt)), hash)` ends in `01`.
4. The call is simulated as the creator. The factory's returned token must equal the local prediction.
5. With a dev buy, `createLaunchAndBuy` is used with native funding and `minAmountOut` set from the simulated output minus slippage. The adapter rejects long deadlines, so dev-buy launches use a 5-minute deadline instead of 30.

Dev-buy routes are discovered on chain (`packages/executor/src/route-discovery.ts`). ETH pairs go straight into the new pool. USDG and stock pairs try every liquid candidate, SwapX V3 WETH/quote, V3 WETH/USDG then V3 USDG/quote, and V3 WETH/USDG then hook-free V4 USDG/quote, simulate each through the factory, and keep the route with the largest output. Hook-free V4 pools sit behind whatever (fee, tickSpacing) their LPs picked, so discovery probes a 25 × 18 grid of tiers per pair (one multicall) instead of a fixed list; on Robinhood the 5% tier 50000/500 alone carries 137 stocks. The adapter refuses native ETH fed directly into a non-launch V4 pool (`UnsupportedRoute()`) and V3 pools that are not SwapX's, so those are never candidates. Survey of 2026-09-07 (`pnpm survey:routes`): 185 of the 194 stock tokens have at least one liquid route; for the others the plan fails with `dev_buy_no_route` and the launch must go without a dev buy. `pnpm decode-launch 0x<hash>` decodes any live launch (params, route steps, events) to compare against the bot's encoding; the fixtures under `packages/executor/test/fixtures` come from it.

## Bot pipeline

```
X mentions → listener (poll, since_id cursor, filter) → queue (one job per post)
           → pipeline: dedupe (Mention.tweetId) → parse (Claude) → validate → pin metadata
             → plan (live reads, salt, route, simulation, funding) → sign + broadcast → fee recipient → reply
```

- `DRY_RUN=true` (default) means no signatures and no posts on X. Replies are logged in full, launches are stored with status `DRY_RUN` and the predicted token address, and everything before signing (including the funding check against the real balance) runs for real.
- Live launches move `SIGNING → CONFIRMED → FEE_RECIPIENT_PENDING → REPLIED`. Every signature is written to `SignedTransaction` (post id, X user id, wallet, calldata hash) before it happens, through the allow-list guard in `packages/wallet`.
- Nothing is retried automatically once a launch reaches signing. A failed job stays on its `Mention` row with the error; re-drive it by hand after reading the log.
- Replies are English templates (`apps/bot/src/replies.ts`) localized into the post's language by the model, with addresses, handles, tickers, URLs and amounts checked verbatim. Length is measured the way X measures it (every URL counts as 23 characters). When X refuses a crypto address in a reply, the address-free variant is sent instead.
- Validator limits: one launch per account per `LAUNCH_COOLDOWN_SECONDS`, `MAX_LAUNCHES_PER_USER_PER_DAY`, `MAX_DEV_BUY_ETH`, `MAX_REPLIES_PER_USER_PER_DAY`. `fees to` rejects bot and o1 handles, unknown or suspended X users, and resolves handles to X user ids before creating a Privy pregenerated wallet.
- Queue: `QUEUE_DRIVER=memory` (default, single process) or `redis` with `REDIS_URL` (BullMQ, job id = post id, concurrency 1).

```bash
pnpm --filter @o1bot/bot once        # one poll, drain the queue, exit
pnpm --filter @o1bot/bot test        # pipeline, validator and reply tests with fakes (no keys needed)
pnpm --filter @o1bot/bot once --mention 'launch $CAT "Cash Cat" pair ETH devbuy 0.01' --author alice --wallet 0x…
```

The last command feeds one synthetic post through the whole pipeline with `DRY_RUN=true`: an in-memory store when `DATABASE_URL` is unset, a scripted X client, `--wallet` as the poster's linked wallet when Privy is not configured, `ipfs://dry-run/…` metadata when `PINATA_JWT` is unset, and the live factory for the plan. It needs `ANTHROPIC_API_KEY` for the parser and an RPC.

## Indexer and token pages

`apps/indexer` polls Robinhood Chain with topic-filtered `eth_getLogs`: the v4 PoolManager `Swap` event for the poolIds of tracked launches and the o1 hook `Trade` event for referrer, fee and comment. Only tokens with a confirmed row in `Launch` are tracked (plus `INDEXER_DEV_TOKENS` for local testing), so the board and token pages never show other o1 tokens. Ranges adapt to RPC errors, the cursor is committed with each batch, and swap ids (`txHash-logIndex`) keep re-scans idempotent. Prices come from `sqrtPriceX96` (`packages/market`), candles are built on demand, and USD values use on-chain WETH/USDG and USDG/stock pools. Holder snapshots come from o1's Public API when `O1_API_KEY` is set.

```bash
pnpm --filter @o1bot/indexer start        # long-running, needs DATABASE_URL and a log-capable RPC
pnpm --filter @o1bot/indexer dry          # no database: scan, print decoded swaps, exit
```

Bounded dry run against live tokens (validates decoding without a database):

```bash
INDEXER_DEV_TOKENS=0xTOKEN@0xLAUNCH_TX INDEXER_START_BLOCK=56174900 INDEXER_END_BLOCK=56195000 pnpm --filter @o1bot/indexer dry
```

Web routes: `/` board, `/token/[address]`, `/api/tokens`, `/api/token/[address]` (+ `/trades`, `/candles?tf=15m`, `/holders`).

## Privy setup

1. Create an app at dashboard.privy.io. Enable **Login with X**, **Embedded wallets → Ethereum**, and **Delegated actions**.
2. Put the App ID in both `PRIVY_APP_ID` and `NEXT_PUBLIC_PRIVY_APP_ID`; the App Secret in `PRIVY_APP_SECRET`.
3. A user is "linked" for the bot only when they have logged in on o1bot.exchange at least once, hold a Privy embedded wallet, and have delegated signing to o1bot (step 2 of the onboarding page). Wallets that exist only because someone wrote `fees to @them` are pregenerated and not linked.

## Signing rules

The bot never signs arbitrary calldata. `packages/wallet/src/signer.ts` wraps the Privy viem account so it refuses anything that is not one of: `createLaunch`, `createLaunchAndBuy`, an ERC-20 `approve` to a registered quote token, `setCreatorFeeRecipient`, or a fee-escrow claim, and only to the active o1 contracts for that chain. Every signed transaction is recorded in `SignedTransaction` with tweet ID, X user ID, wallet, and calldata hash.

## RPC

`RPC_ROBINHOOD` unset means the public endpoints are rotated (publicnode, ordofi, then the chain's own). Public endpoints refuse archive log queries, and some ISPs intercept `rpc.mainnet.chain.robinhood.com`; use a paid RPC in production and for the indexer.
