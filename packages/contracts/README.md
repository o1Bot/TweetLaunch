# @o1bot/contracts

o1bot's own on-chain pieces. Everything else o1bot signs goes to o1's contracts; this package holds what
o1 does not offer.

## FeeSplitter

o1 pays the creator half of every swap fee into its `FeeEscrow`, keyed by **recipient address and
currency**, with no notion of which token the fee came from: `owed(recipient, currency)`, and `claimFor` /
`claimTo` pay the whole balance of a currency at once. o1bot wants two things on top of that: a launch whose
creator fees are shared between several people (`fees to`, splits from a post), and a platform share of the
creator fees for the o1bot treasury. Both need a recipient that is a contract, and because the escrow's
ledger is per address, that contract must be **one clone per launch**.

- `FeeSplitterFactory` (one per chain) deploys a minimal EIP-1167 clone of `FeeSplitter` per launch at a
  deterministic address (`predict` / `register`). The address depends on the token, the recipients, their
  shares and the platform share, so the bot can pass it to o1's `setCreatorFeeRecipient` in the launch
  transaction before the clone exists: fees accrue to the address in o1's escrow either way, and `register`
  later lands on that exact address.
- `FeeSplitter.claim(currency)` (anyone may call it) pulls the clone's balance from o1's escrow and pays it
  out in the same transaction: `platformBps` to the factory's treasury, the rest to the recipients in their
  proportions, the rounding remainder to the last one. Nothing stays in the clone.
- A payout that cannot be pushed (a recipient contract that reverts, or one whose `receive` needs more
  than `PUSH_GAS`) is recorded in `pending` and withdrawn by that recipient with `withdraw`.
- `rescue` (factory owner) sweeps only `balance - totalPending`: assets sent by mistake, or a platform push
  that failed. It can never reach a recipient's deferred payout. That is the invariant the tests pin.
- Recipients, shares and the platform share are fixed at registration and part of the address. The factory
  owner can change the treasury address (read live by every clone) and the platform share for **future**
  registrations only, capped at `MAX_PLATFORM_BPS` (30%).

The user stays the on-chain creator on o1. They can point `creatorFeeRecipient` back at their own wallet
through o1's UI whenever they like, so the platform share is a default, not an enforcement.

## Commands

```bash
pnpm --filter @o1bot/contracts build      # forge build
pnpm --filter @o1bot/contracts test       # forge test -vv (19 tests, one fuzz)
pnpm --filter @o1bot/contracts fmt        # forge fmt
```

Dependencies come through pnpm, not git submodules: `@openzeppelin/contracts` from npm and `forge-std` as a
GitHub tarball, mapped in `foundry.toml` (`remappings`). Foundry itself (`forge`, solc 0.8.26, the same
compiler as o1's contracts) must be installed on the machine that builds or tests.

## Deployment

One factory per chain. Fill the "Fee splitter deployment" section of the root `.env`
(`FEE_SPLITTER_DEPLOYER_KEY`, the gas payer; `FEE_SPLITTER_TREASURY`; `FEE_SPLITTER_OWNER`, defaults to the
deployer; `FEE_SPLITTER_PLATFORM_BPS`, default 2000), then:

```bash
pnpm contracts:deploy robinhood              # simulation only: escrow, owner, treasury, the address it would land on
pnpm contracts:deploy robinhood --broadcast  # the real deployment
```

The wrapper (`scripts/deploy.ts`) takes the active o1 `FeeEscrow` from `config/o1.json` and the RPC from
`RPC_<CHAIN>`, runs `script/Deploy.s.sol`, and after a broadcast prints the `FEE_SPLITTER_FACTORY_<CHAIN>`
line to add to `.env`, Railway (bot) and Vercel (web). Until that variable is set, launches on the chain keep
the creator's wallet as o1's fee recipient. The owner should be a wallet kept apart from the bot's signer, a
hardware wallet or a multisig; `Ownable2Step` means a transfer of ownership must be accepted by the new owner.
