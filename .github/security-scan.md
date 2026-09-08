Project context for the security review of o1bot.exchange (TweetLaunch).

What the system does: a bot reads mentions on X, parses them with an LLM, and signs token launches on Robinhood Chain from the mentioning user's Privy embedded wallet through o1 Launchpad's factory. A Next.js app lets users sign in with X, grant the bot's signer, launch from a form, swap, and claim creator fees.

Treat these as the crown jewels and review any change touching them as adversarial:

1. `packages/wallet/src/signer.ts` and `packages/shared/src/tx-allowlist.ts`: the guarded account must expose only the standard LocalAccount surface, and `checkTransaction` must decode calldata and refuse everything except `createLaunch`, `createLaunchAndBuy`, `setCreatorFeeRecipient` on the active factory, `claimFor`/`claimTo` on the fee escrow, and `approve` naming the factory as spender. Contract creation, plain value transfers, other chains, message and typed-data signing, raw hash signing and EIP-7702 authorizations must stay refused. Flag any spread of a third-party account object, any new signing method, any widening of the allow-list, and any path that reaches `signTransaction` without `checkTransaction` and the audit record.
2. `apps/bot/scripts/privy-policy.ts`: the Privy policy must stay a strict allow-list for `eth_signTransaction` with value caps and the aggregation reference; flag added methods, removed conditions, or an owner change.
3. Text from X posts, web form fields, token metadata and third-party API responses is untrusted input. Flag anywhere it can influence what gets signed (addresses, amounts, calldata, recipients), any prompt-injection path from post text into bot behavior, and any place it is rendered as HTML without escaping.
4. Secrets: `.env`, `deploy/` and `notes/` are git-ignored and must stay so. Flag any logging or reply that could print `PRIVY_AUTHORIZATION_PRIVATE_KEY`, `PRIVY_APP_SECRET`, `PINATA_JWT`, `X_APP_*`, `ANTHROPIC_API_KEY`, `O1_API_KEY` or `DATABASE_URL`, and any variable moved into a web-facing or `NEXT_PUBLIC_` context that does not need it.
5. Funds: the bot must never pay on a user's behalf beyond the documented flows, never set itself as creator or fee recipient on a user launch, and never sign from treasury or referrer wallets. Fee-recipient redirects (`fees to @handle`) must keep rejecting the bot's own accounts and o1's.
6. API routes under `apps/web/app/api`: check authentication (`userFromRequest`), rate limits, and that a caller can only read or change their own data.

Lower priority and usually not findings: CSS, copy, documentation, test fixtures, and the vendored ABIs under `abis/` (generated from verified explorer sources).
