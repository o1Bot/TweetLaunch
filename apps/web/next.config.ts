import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import type { NextConfig } from "next";

// One .env at the repository root feeds every app. Next only looks inside
// apps/web on its own, so load the root file here (existing variables win;
// on Vercel the file does not exist and the dashboard values are used).
let dir = resolve(process.cwd());
for (;;) {
  if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
    loadEnv({ path: join(dir, ".env"), override: false, quiet: true });
    break;
  }
  const parent = dirname(dir);
  if (parent === dir) break;
  dir = parent;
}

const config: NextConfig = {
  // Workspace packages export TypeScript source; let Next compile them.
  transpilePackages: ["@o1bot/shared", "@o1bot/wallet", "@o1bot/db", "@o1bot/executor", "@o1bot/market", "@o1bot/parser"],
  // Keep native/worker-thread packages out of the bundle.
  serverExternalPackages: ["pino", "pino-pretty", "@prisma/client", "@prisma/adapter-pg", "pg"],
};

export default config;
