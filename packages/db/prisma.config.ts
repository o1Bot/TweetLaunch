import { config as loadEnv } from "dotenv";
import { defineConfig } from "prisma/config";

// The repo keeps one .env at the root; packages/db is two levels down.
loadEnv({ path: [".env", "../../.env"], quiet: true });

/**
 * `prisma generate` needs no database, so a placeholder URL keeps it working
 * on a fresh checkout. `migrate` / `db push` require the real DATABASE_URL.
 */
const PLACEHOLDER = "postgresql://postgres:postgres@localhost:5432/o1bot?schema=public";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env.DATABASE_URL ?? PLACEHOLDER },
});
