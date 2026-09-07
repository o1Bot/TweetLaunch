# Image for the long-running workers (bot, indexer). One image, two Railway
# services: the bot uses the default command below, the indexer overrides the
# Start Command with `pnpm --filter @o1bot/indexer start`.
#
# Debian slim rather than Alpine so the native prebuilds (keccak, bufferutil,
# utf-8-validate) match and nothing has to compile at install time.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@11.5.0 --activate

WORKDIR /app
COPY . .
# The build context must be the repository root. On Railway that means the
# service's Root Directory setting is empty; a subfolder such as apps/bot
# arrives here without the workspace files and cannot be installed.
RUN test -f pnpm-lock.yaml && test -f pnpm-workspace.yaml || { echo "ERROR: pnpm-lock.yaml not found: the build context is not the repository root. On Railway, clear the service's Root Directory setting and redeploy."; exit 1; }
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @o1bot/db generate

ENV NODE_ENV=production
CMD ["pnpm", "--filter", "@o1bot/bot", "start"]
