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
| 5 | Front end: board, token page (chart, trades, holders, creator post, buy/sell), launch form, profile with fee claims | done |
| 6 | Indexer (swaps, prices, candles) | done; needs a paid RPC and Postgres to run |

### Chains

Launches run on Robinhood Chain by default and on Base when the command ends with `on base` (added 2026-09-11). Both use o1's own factory for that chain, read fresh from o1's registry by `pnpm o1:sync`; `pnpm abi:vendor` vendors both chains' ABIs. The two differ in one thing: Robinhood mints an ERC-20 through a CREATE2 deployer, so the `01` salt is mined locally from `launchTokenBytecodeHash`, while Base mints through the B20 precompile, so candidates are checked with `getB20Address` in one Multicall3 round trip (`packages/executor/src/salt.ts`, validated against live Base launches). Base tokens live at `0xB20000...01` addresses. Base replies link to o1's token page until the indexer and token pages cover Base; trades from a post and the swap panel are Robinhood only for now.

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
pnpm parse '@o1bot_exchange launch $RUGRAT "Rugrat" pair ETH on robinhood desc "Rats, but on chain." site rugrat.xyz tg @rugrat_chat'
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
| web | Vercel, root directory `apps/web` | `DATABASE_URL`, `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_AUTHORIZATION_PRIVATE_KEY`, `PRIVY_SIGNER_ID`, `NEXT_PUBLIC_PRIVY_APP_ID`, `NEXT_PUBLIC_PRIVY_SIGNER_ID`, `NEXT_PUBLIC_DOCS_URL`, `NEXT_PUBLIC_X_URL`, `NEXT_PUBLIC_GITHUB_URL`, `NEXT_PUBLIC_CONTACT_EMAIL`, `RPC_ROBINHOOD`, `O1_API_URL`, `O1_API_KEY`, `IPFS_GATEWAY`, `LOG_LEVEL`, `LOG_PRETTY` |
| bot | Railway | `DRY_RUN`, `SITE_URL`, `DOCS_URL`, `DATABASE_URL`, `QUEUE_DRIVER`, `REDIS_URL`, `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_AUTHORIZATION_PRIVATE_KEY`, `PRIVY_SIGNER_ID`, `PRIVY_POLICY_ID`, `REFERRER_ADDRESS`, `MAX_TRADE_ETH`, `DEFAULT_USER_TRADE_CAP_ETH`, `TRADE_COOLDOWN_SECONDS`, `MAX_TRADES_PER_USER_PER_DAY`, `TRADE_SLIPPAGE_BPS`, `MAX_BRIDGE_ETH`, `RELAY_API_URL`, `RPC_BASE`, `RPC_ETHEREUM`, `RPC_ARBITRUM`, `RPC_OPTIMISM`, `ALERT_TELEGRAM_BOT_TOKEN`, `ALERT_TELEGRAM_CHAT_ID`, `X_BEARER_TOKEN`, `X_APP_KEY`, `X_APP_SECRET`, `X_APP_ACCESS_TOKEN`, `X_APP_ACCESS_TOKEN_SECRET`, `X_BOT_USER_ID`, `X_BOT_HANDLE`, `X_POLL_MS`, `ANTHROPIC_API_KEY`, `PARSER_MODEL`, `PINATA_JWT`, `O1_API_URL`, `O1_API_KEY`, `RPC_ROBINHOOD`, `MAX_LAUNCHES_PER_USER_PER_DAY`, `LAUNCH_COOLDOWN_SECONDS`, `MAX_DEV_BUY_ETH`, `DEV_BUY_SLIPPAGE_BPS`, `MAX_REPLIES_PER_USER_PER_DAY`, `LOG_LEVEL`, `LOG_PRETTY` |
| indexer | Railway | `DATABASE_URL`, `INDEXER_RPC`, `RPC_ROBINHOOD`, `INDEXER_POLL_MS`, `INDEXER_START_BLOCK`, `IPFS_GATEWAY`, `LOG_LEVEL`, `LOG_PRETTY` |
| db | your machine | `DATABASE_URL` for `pnpm db:push` / `pnpm db:migrate` against the production database |

`INDEXER_DEV_TOKENS`, `INDEXER_END_BLOCK` and `SHOW_DEV_TOKENS` are local-preview switches and never leave your machine. With `DRY_RUN=true` every missing service falls back to an in-memory or dry-run stand-in and says so in the log.

## Deploying

One Postgres database (Railway Postgres or Neon) is shared by all three services. Create it first, put its URL in `DATABASE_URL`, and run `pnpm db:push` from your machine to create the tables.

**Vercel (web).** Import the GitHub repository and set Root Directory to `apps/web`; Vercel installs the pnpm workspace from the repository root on its own, and the web `build` script generates the Prisma client before `next build`, so the default build command (`pnpm run build`) is enough. Paste `deploy/web.env` into Environment Variables. `NEXT_PUBLIC_*` values are baked in at build time, so a change to them needs a redeploy.

**Railway (bot and indexer).** Create two services from the same repository and keep Root Directory at the repository root (empty or `/`): a subfolder such as `apps/bot` hides the pnpm workspace and lockfile, so Railway falls back to npm and fails on `workspace:*`. `railway.toml` selects the root `Dockerfile` (Node 22 on Debian slim, pnpm 11, Prisma client generated at build). For each service: set Start Command `pnpm --filter @o1bot/bot start` or `pnpm --filter @o1bot/indexer start` (both generate the Prisma client before starting), and paste the matching `deploy/*.env` into Variables → Raw Editor. Add a Railway Redis service and set `QUEUE_DRIVER=redis` with its `REDIS_URL` when the bot should survive restarts with jobs intact. Keep `DRY_RUN=true` on the first deploy, watch a few mentions go through the log, do one real launch with the minimum fee from a fresh wallet, then set `DRY_RUN=false`.

## Parser

A launch post carries the ticker, name and pair, plus optional extras: `devbuy <eth>`, `fees to @handle`, `desc "…"`, `site <url>`, `tg <link or @name>` and `x @handle`. The extras land in the token's ERC-7572 metadata under the same keys o1's own documents use (`description`, `website`, `x`, `telegram`), so o1's token page and the o1bot token page both show them. The bot never invents a description or a link; `x` defaults to the poster's own profile.

`packages/parser` turns one post into a `ParseResult`: `launch`, `clarify` (launch intent with a missing or ambiguous value, plus one question in the user's language), `unsupported_chain`, `help` (a short reply in the user's language), or `ignore`. The model returns a flat structured object (`client.messages.parse` with a zod `output_config.format`); `normalizeParseOutput` then enforces the rules deterministically: ticker 1-11 uppercase letters or digits, name at most 50 characters, pair required, dev-buy amounts only as plain ETH decimals, handles normalised. A launch that fails those checks becomes a `clarify`, never a guess. The system prompt carries the full pair menu from `config/o1.json` so company names map to stock symbols, and it is cached as a stable prefix. The model is `claude-sonnet-4-6` by default (`PARSER_MODEL` overrides it; sampling parameters are only sent to models that accept them). A chain that is not stated is treated as Robinhood; a stated other chain is refused.


## How a launch is built

1. `config/o1.json` is checked against o1's live registry; any factory rotation aborts the run.
2. `configVersion`, `launchSupply`, `tickSpacing`, `nativeLaunchFee`, `launchCreationEnabled`, `TOKEN_ADDRESS_SUFFIX`, the token deployer, the hook and the pair's `quoteConfig` are read at one block.
3. `launchTokenBytecodeHash` is read once (it does not depend on the salt), then a `creatorSalt` is mined locally so that `CREATE2(deployer, keccak256(abi.encode(creator, creatorSalt)), hash)` ends in `01`.
4. The call is simulated as the creator. The factory's returned token must equal the local prediction.
5. Gas is estimated with 20% headroom and the fee cap is fixed at 1.5× the node's estimate; the funding check uses both against the real balance, and the broadcast reuses the same gas limit and fee cap, so the node can never ask for more than what was checked. Robinhood charges only the block base fee, so the unused cap costs nothing.
6. With a dev buy, `createLaunchAndBuy` is used with native funding and `minAmountOut` set from the simulated output minus slippage. The adapter rejects long deadlines, so dev-buy launches use a 5-minute deadline instead of 30.

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

### Launching from the web app

`/launch` is a form for people who would rather not post: ticker, name, pair, dev buy, logo upload, description, links and an optional fee recipient. Submitting only records the request (`Launch` row with `source = WEB`, status `QUEUED`, the logo bytes on the row); the bot worker on Railway claims it within a few seconds and runs it through the same checks and the same signing path as a post on X (`apps/bot/src/launch-core.ts` is shared by both), then writes the outcome back. The page polls `GET /api/launch/:id` and shows the steps, the message and the token link. Nothing is posted on X for web launches, and the token page shows "launched on o1bot.exchange" instead of a genesis post. Rate limits, the dev-buy cap and the reserved fees-to handles apply exactly as on X.

### Trading from a post

`@o1bot_exchange buy 0.05 ETH of $CAT`, `buy $CAT 0.1`, `buy 5 NVDA of $NVDOG`, `sell half of $CAT`, `sell all $CAT`, `sell 25% of $CAT`, optionally `slippage 5%`; the token can also be a 0x address. Off for every account until the user turns it on at `/me` and sets a per-trade cap (default `DEFAULT_USER_TRADE_CAP_ETH`, ceiling `MAX_TRADE_ETH`; a stock or USDG amount is compared to the cap through USD). Any o1 Launchpad token: the bot's own launches come from the database, everything else from o1's Public API (`apps/bot/src/o1-tokens.ts`, needs `O1_API_KEY`), and every pool is verified on chain before it is traded: the hook must be one o1 deployed (`knownHooks`), the pool id must recompute from the key, and the hook must report the pool initialised. ETH pools are paid in ETH; stock and USDG pools in that asset, which the user must hold (the bot says so when the amount is in the wrong asset). A ticker shared by several tokens is not guessed: the bot lists up to three with their addresses and liquidity and asks for the address. Buys inside the 20-second anti-snipe window are refused with the seconds left. One trade per `TRADE_COOLDOWN_SECONDS` per account, `MAX_TRADES_PER_USER_PER_DAY` per day.

The model only fills a schema (side, token, amount with its asset or portion, slippage); there is no field for a recipient. `apps/bot/src/trade-core.ts` reads the hook config and balances, quotes through the v4 Quoter, applies slippage and encodes one exact-input swap for the Universal Router with o1bot's referral in the hook data (`packages/swap`). Whatever ERC-20 the router pulls (the token on a sell, the quote asset on a stock or USDG buy) is first approved to Permit2 and Permit2 to the router when needed. Privy's policy caps the native value of a router call; ERC-20 inputs are bounded by the allow-list and the USD cap in code. Before signing, the allow-list decodes the router calldata and accepts only one V4_SWAP with SWAP_EXACT_IN_SINGLE, SETTLE_ALL and TAKE_ALL (which pays msg.sender, so the output can only reach the signing wallet) on an o1 launch pool the bot knows, carrying o1bot's referrer, with the native value equal to the swap input and under the cap; approvals may only name Permit2 and the router. Privy's policy bounds the router value again in the enclave. Encoded or indirect instructions in a post ("decode this", base64, "the quoted post says") are never commands; the fixtures under `packages/parser/test/fixtures` include those attacks.

### Bridging from a post

`@o1bot_exchange bridge 0.1 ETH from base` (also `move`, `top up from`; origins base, ethereum, arbitrum, optimism) moves ETH from the user's Privy wallet on that chain to the same address on Robinhood through Relay, usually within seconds, for about 0.2% plus gas. `buy 0.05 ETH of $CAT from base` bridges a little more than the buy and then buys. The bot asks Relay for a quote whose recipient is the signing wallet, then re-encodes the deposit as `depositNative(0x0, depositId)`: the depository credits `msg.sender` when the depositor is the zero address, so the party credited (and refunded) is structurally the signing wallet and no calldata field can point elsewhere. The deposit is signed only if it targets Relay's pinned depository (`RELAY_DEPOSITORY` in `packages/shared/src/bridge-chains.ts`), carries the zero depositor and the quoted deposit id, and carries exactly the quoted value; the Privy policy allows that call on those chains under `MAX_BRIDGE_ETH` and pins the depositor argument to zero in the enclave as well, so a leaked key could only deposit on the wallet's own behalf. The bot then polls Relay until the transfer is filled or refunded; a fill that takes longer than two minutes gets a "still on its way" reply. Same opt-in and rate limits as trading. `RPC_BASE` and friends override the public origin RPCs.

### Buy and sell on the token page

The swap panel trades through o1's launch pool on Uniswap v4. `GET /api/token/:address/quote` prepares one exact-input swap: the pool key (token, quote asset, LP fee 0, o1's hook), the referral hook data (`REFERRER_ADDRESS` followed by a 32-byte comment, dropped when it would equal the creator or fee recipient because the hook rejects that), the V4 quoter's output with the chosen slippage, the live anti-snipe fee from the hook's `poolConfig`, and, for a signed-in wallet, its balances and the Permit2 approvals still needed. The browser then encodes a Universal Router `execute` with one `V4_SWAP` command (`SWAP_EXACT_IN_SINGLE`, `SETTLE_ALL`, `TAKE_ALL`; `apps/web/lib/v4-swap.ts`) and the user's embedded wallet signs it; ERC-20 inputs first approve Permit2 and the router. Exact input only, which is what the hook allows during the anti-snipe window. The router deployed on Robinhood Chain is a modified build whose single-swap params carry a `minHopPriceX36` field before `hookData`; `packages/swap` encodes that layout, because the stock Uniswap layout still swaps but reaches the hook with empty hook data, so the referral share is lost (found by tracing the first bot trades, 2026-09-10). Encoding is covered by unit tests; the quoter path was checked live against the first launched pools, and the hook data path with a traced simulation.

### Profile and fee claims

The profile follows the v3 demo (`o1bot-profile-v3.html`): identity, total balance, wallet address, Launch / Deposit / Withdraw / Swap, ETH per chain (Robinhood plus the chains a post can bridge from) and the bot-signing card on the left; the claim banner, assets, launches with fees earned, trades from posts and the "from posts" settings on the right. Deposit shows the address (the same on every chain); Withdraw sends ETH or a token to another address, signed by the user's own wallet. Settings: trading and bridging from posts, the per-trade cap, whether other people may direct creator fees to this account (a `fees to @you` launch is refused when off), and whether the bot answers in the post's language or always in English.

`/me` shows the signed-in account: wallet address (copy, explorer, key export), holdings in ETH, USDG and every o1bot token (balances read on chain, valued with the same prices as the board), the account's launches as creator or as fee recipient with their status, and the creator fees waiting in o1's escrow per paired asset (`FeeEscrow.owed`). Claiming is a transaction the user signs in the browser with their own embedded wallet (`claimFor(wallet, currency)`, which always pays the recorded recipient), so the bot's signer is never involved; it needs a little ETH for gas. Gas sponsorship for pregenerated `fees to` recipients is not built yet.

### Launching from the bot's own account

The poller never processes posts written by the bot itself, so that the "try it" examples on the bot's timeline cannot trigger launches. To launch a token from @o1bot_exchange anyway (the project's own token, for instance), process one post on demand from a machine that holds the root `.env`:

```bash
# 1. sign in with the bot's X account at the site and delegate signing, fund the wallet
# 2. post the launch command from the bot's account, copy the post id from its URL
DRY_RUN=true  pnpm --filter @o1bot/bot once --post 1234567890123456789   # simulate only
DRY_RUN=false pnpm --filter @o1bot/bot once --post 1234567890123456789   # sign, broadcast, reply under the post
```

`--post` works for any author. It forgets a previous dry run of the same post first, and refuses a post that already had a transaction signed. The reply lands under the post as usual, and the token appears on the board because it went through the normal pipeline.

Logos above o1's 2 MB limit are downscaled instead of refused: the launch form shrinks them in the browser before upload (canvas, at most 1024 px, WebP), and the bot worker does the same with `sharp` for X attachments and anything that still arrives too large. Animated GIFs cannot be shrunk without losing the animation, so those must be under 2 MB.

Metadata on o1's own pages: launch.o1.exchange and the o1 Public API only show a token's logo, description and links when the metadata document is pinned in o1's Pinata account (their gateway runs in restricted mode and answers 403 for any other CID). With `O1_API_KEY` set on the bot (scope `launches:prepare`), every launch first asks o1 to pin the image and the ERC-7572 document through `POST /launches/prepare` and uses the returned `metadata_uri` as `tokenContractURI`; the bot still builds and signs its own transaction, so the atomic dev buy is unaffected and the prepared steps in o1's response are ignored. The same CIDs are then pinned by CID into o1bot's account so its gateway serves them too. If o1 refuses (rate limit, key missing the scope, creator below the creation fee) the bot logs why and pins through `PINATA_JWT` as before; the token then works on o1bot.exchange but stays blank on o1. Tokens launched before this existed are in that state and only o1 can re-index them.

Moving to another Pinata account: a dedicated gateway only serves what its own account pinned, so run `pnpm repin` with the new `PINATA_JWT` in the root `.env`; it re-uploads every launched token's logo and metadata from a public gateway with identical CIDs. The web app resolves `ipfs://` through `IPFS_GATEWAY` first, then o1's gateway, then Pinata's public gateway (ipfs.io and dweb.link no longer serve plain HTTP requests), for both logos and metadata documents.

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

1. Create an app at dashboard.privy.io. Enable **Login with X** and **Embedded wallets → Ethereum**. New apps run wallets in Privy's TEE, which is what server-side signing needs.
2. Put the App ID in both `PRIVY_APP_ID` and `NEXT_PUBLIC_PRIVY_APP_ID`; the App Secret in `PRIVY_APP_SECRET`.
3. Create the bot's signer with `pnpm privy:signer`: it generates a P-256 key pair locally, registers the public key as a 1-of-1 key quorum through Privy's API, and writes `PRIVY_SIGNER_ID`, `NEXT_PUBLIC_PRIVY_SIGNER_ID` and `PRIVY_AUTHORIZATION_PRIVATE_KEY` into the root `.env` (the private key is never printed). The dashboard's Authorization keys page does the same by hand. Privy never stores the private key; keep a copy of `.env` somewhere safe, and re-run with `--force` only if you mean to rotate it, since every user then has to grant the new signer again.
4. Create the signer's policy with `pnpm privy:policy`: it registers a separate owner key quorum (private key written to `notes/privy-policy-owner.key`, to be moved offline), a rolling 24-hour value aggregation, and a policy that allows only `createLaunch`, `createLaunchAndBuy` and `setCreatorFeeRecipient` on the active factory (value at most creation fee + `MAX_DEV_BUY_ETH`, daily value under `--daily-cap`) plus `claimFor`/`claimTo` on the fee escrow; everything else is denied by Privy's enclave. It writes `PRIVY_POLICY_ID` and `NEXT_PUBLIC_PRIVY_POLICY_ID`. Onboarding calls `addSigners` with the key quorum and this policy, which grants o1bot's key signing rights on the user's wallet within those limits. The bot's own allow-list still decides which transactions it will ever sign; a Privy policy can be added on top later.
5. A user is "linked" for the bot only when they have logged in on o1bot.exchange at least once, hold a Privy embedded wallet, and have o1bot's key quorum as a signer on it (checked through the wallet API, not the user object). Wallets that exist only because someone wrote `fees to @them` are pregenerated and not linked.

## Review gate

Nothing reaches `main` without a pull request. Two workflows run on every PR: `ci` (typecheck and unit tests across the workspace) and `security-review` (Anthropic's Claude security reviewer, with project context from `.github/security-scan.md`: the guarded signer, the allow-list, the Privy policy, untrusted post text, secrets and fund flows). The reviewer needs the `ANTHROPIC_API_KEY` repository secret. In the repository settings, protect `main`: require a pull request, require the `ci` and `security-review` checks, and disallow force pushes.

## Operator alerts

With `ALERT_TELEGRAM_BOT_TOKEN` and `ALERT_TELEGRAM_CHAT_ID` set, the bot sends a Telegram message when a launch or trade fails (user, post, wallet, transaction, error, and what the user was told), when X refuses a reply, when the parser fails, when mention polling fails five times in a row, when the web-launch worker crashes, and one line at boot and on a crash. Identical alerts collapse to one message per ten minutes. `pnpm doctor` checks the chat is reachable. Every trade from a post is listed on the user's profile, and swaps that came from a post carry a "post" tag on the token page.

### Data freshness

`GET /api/health` reports whether the market data is fresh: 200 with `ok: true` while the indexer cursor moved in the last five minutes, 503 otherwise or when the database is unreachable. The indexer commits its cursor on every poll even when nothing traded, so a still cursor means it is down, crash-looping or stuck on a batch. Point an uptime monitor (UptimeRobot's free tier is enough) at that URL and it alerts on the status code. Every page also shows a "Market data is delayed since …" bar from the same endpoint, so visitors know that prices and trades may be behind while launches and trades still work.

## Signing rules

Two layers. First, Privy's enclave: the signer users grant carries the policy from `pnpm privy:policy`, so a request from o1bot's key that is not a launch, a fee-recipient update or a claim to the o1 contracts, or that exceeds the value caps, is refused before anything is signed, whatever the bot's code or a leaked key asks for. A signer granted without the policy is treated as stale: the user is not linked until they grant again (the profile and the automatic prompt handle this), and the profile has a Revoke button. Second, the code: `packages/wallet/src/signer.ts` builds a fresh `LocalAccount` around the Privy viem account instead of spreading it, so only `signTransaction` reaches Privy; raw hash, message, typed-data and EIP-7702 signing refuse whatever the inner account implements. `signTransaction` accepts only `createLaunch`, `createLaunchAndBuy`, an ERC-20 `approve` to a registered quote token, `setCreatorFeeRecipient`, or a fee-escrow claim, and only to the active o1 contracts for that chain. The calldata must decode as that function (a matching selector with garbage after it is refused), an approval must name the factory as spender, and contract creation, plain value sends and other chains are rejected. Every signed transaction is recorded in `SignedTransaction` with tweet ID, X user ID, wallet, and calldata hash.

## RPC

`RPC_ROBINHOOD` unset means the public endpoints are rotated (publicnode, ordofi, then the chain's own). Public endpoints refuse archive log queries, and some ISPs intercept `rpc.mainnet.chain.robinhood.com`; use a paid RPC in production and for the indexer.
