import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.ts";

export * from "../generated/prisma/client.ts";

let client: PrismaClient | null = null;

export function dbConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

/** Lazily-created singleton. Throws if DATABASE_URL is missing. */
export function db(): PrismaClient {
  if (client) return client;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  client = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  return client;
}

export async function disconnectDb(): Promise<void> {
  if (!client) return;
  await client.$disconnect();
  client = null;
}
