import { db } from "@o1bot/db";

/**
 * What the perps branch of the pipeline reads and writes: the opted-in
 * account (with the bot's sealed key) and the orders placed from posts. A
 * narrow interface of its own so the flow runs in tests with the in-memory
 * version and no database.
 */

export type PerpsAccountRecord = {
  xUserId: string;
  accountIndex: number;
  apiKeyIndex: number;
  /** The bot's key for this account, sealed with the vault secret. Never logged. */
  sealedKey: string;
  maxNotionalUsd: number;
  maxLeverage: number;
};

export type PerpsAccountState = { state: "active"; account: PerpsAccountRecord } | { state: "none" | "pending" | "failed" | "disabled" };

export type PerpsOrderStatusValue = "DRY_RUN" | "SIGNING" | "SENT" | "FILLED" | "UNFILLED" | "FAILED";
/** Orders that count against a user's rate limits: everything that reached the venue or would have. */
export const COUNTED_PERPS_STATUSES: PerpsOrderStatusValue[] = ["DRY_RUN", "SIGNING", "SENT", "FILLED", "UNFILLED"];

export type NewPerpsOrder = {
  mentionId: string;
  xUserId: string;
  accountIndex: number;
  marketId: number;
  symbol: string;
  action: "open" | "close";
  /** The direction of the position: the one being opened, or the one being closed. */
  side: "long" | "short";
  leverage: number | null;
  marginUsd: string | null;
  notionalUsd: string | null;
  baseAmount: string;
  guardPrice: string;
  status: PerpsOrderStatusValue;
};

export type PerpsOrderPatch = Partial<{
  status: PerpsOrderStatusValue;
  leverageTxHash: string | null;
  txHash: string | null;
  filledBase: string | null;
  entryPrice: string | null;
  error: string | null;
  userMessage: string | null;
}>;

export interface PerpsStore {
  account(xUserId: string): Promise<PerpsAccountState>;
  lastOrderAt(xUserId: string): Promise<Date | null>;
  ordersSince(xUserId: string, since: Date): Promise<number>;
  createOrder(input: NewPerpsOrder): Promise<{ id: string }>;
  updateOrder(id: string, patch: PerpsOrderPatch): Promise<void>;
}

export class PrismaPerpsStore implements PerpsStore {
  async account(xUserId: string): Promise<PerpsAccountState> {
    const row = await db().perpsAccount.findUnique({ where: { xUserId } });
    if (!row) return { state: "none" };
    if (row.status === "DISABLED") return { state: "disabled" };
    if (row.status === "FAILED") return { state: "failed" };
    if (row.status !== "ACTIVE" || row.accountIndex === null || !row.sealedKey) return { state: "pending" };
    // A Lighter account index above 2^53 cannot be carried in the signer's number arguments.
    if (row.accountIndex > BigInt(Number.MAX_SAFE_INTEGER)) return { state: "failed" };
    return {
      state: "active",
      account: {
        xUserId,
        accountIndex: Number(row.accountIndex),
        apiKeyIndex: row.apiKeyIndex,
        sealedKey: row.sealedKey,
        maxNotionalUsd: Number(row.maxNotionalUsd),
        maxLeverage: row.maxLeverage,
      },
    };
  }

  async lastOrderAt(xUserId: string): Promise<Date | null> {
    const row = await db().perpsOrder.findFirst({ where: { xUserId, status: { in: COUNTED_PERPS_STATUSES } }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
    return row?.createdAt ?? null;
  }

  ordersSince(xUserId: string, since: Date): Promise<number> {
    return db().perpsOrder.count({ where: { xUserId, status: { in: COUNTED_PERPS_STATUSES }, createdAt: { gte: since } } });
  }

  async createOrder(input: NewPerpsOrder): Promise<{ id: string }> {
    const row = await db().perpsOrder.create({ data: { ...input, accountIndex: BigInt(input.accountIndex) }, select: { id: true } });
    return { id: row.id };
  }

  async updateOrder(id: string, patch: PerpsOrderPatch): Promise<void> {
    await db().perpsOrder.update({ where: { id }, data: patch });
  }
}

export type MemoryPerpsOrder = NewPerpsOrder & PerpsOrderPatch & { id: string; createdAt: Date };

export class MemoryPerpsStore implements PerpsStore {
  readonly accounts = new Map<string, PerpsAccountState>();
  readonly orders: MemoryPerpsOrder[] = [];
  private seq = 0;
  constructor(private readonly now: () => Date = () => new Date()) {}

  async account(xUserId: string): Promise<PerpsAccountState> {
    return this.accounts.get(xUserId) ?? { state: "none" };
  }

  private counted(xUserId: string): MemoryPerpsOrder[] {
    return this.orders.filter((o) => o.xUserId === xUserId && COUNTED_PERPS_STATUSES.includes(o.status));
  }

  async lastOrderAt(xUserId: string): Promise<Date | null> {
    const mine = this.counted(xUserId);
    return mine.length ? mine[mine.length - 1]!.createdAt : null;
  }

  async ordersSince(xUserId: string, since: Date): Promise<number> {
    return this.counted(xUserId).filter((o) => o.createdAt >= since).length;
  }

  async createOrder(input: NewPerpsOrder): Promise<{ id: string }> {
    const id = `po${++this.seq}`;
    this.orders.push({ ...input, id, createdAt: this.now() });
    return { id };
  }

  async updateOrder(id: string, patch: PerpsOrderPatch): Promise<void> {
    const order = this.orders.find((o) => o.id === id);
    if (order) Object.assign(order, patch);
  }
}
