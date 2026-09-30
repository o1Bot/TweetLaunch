// Moved into @o1bot/lighter (link.ts) so the bot can resolve an account for
// trading from a post the same way the terminal does; re-exported here so the
// app keeps one import path.
export { STANDARD_ACCOUNT_TYPE, lookupAccount, pickTradingAccount } from "@o1bot/lighter";
export type { LinkStatus, TradingAccount } from "@o1bot/lighter";
