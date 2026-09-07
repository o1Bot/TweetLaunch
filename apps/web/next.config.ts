import type { NextConfig } from "next";

const config: NextConfig = {
  // Workspace packages export TypeScript source; let Next compile them.
  transpilePackages: ["@o1bot/shared", "@o1bot/wallet", "@o1bot/db"],
  // Keep native/worker-thread packages out of the bundle.
  serverExternalPackages: ["pino", "pino-pretty", "@prisma/client", "@prisma/adapter-pg", "pg"],
};

export default config;
