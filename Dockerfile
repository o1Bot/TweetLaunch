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
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @o1bot/db generate

ENV NODE_ENV=production
CMD ["pnpm", "--filter", "@o1bot/bot", "start"]
