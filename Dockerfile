# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

FROM base AS deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --prod

FROM deps AS build
COPY . .
# Placeholders so modules that read env at import time load during `next build`; nothing connects.
RUN DATABASE_URL=postgres://build:build@localhost:5432/build BETTER_AUTH_SECRET=build-only-placeholder-not-used-at-runtime-000000 pnpm build

FROM base AS runner
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000 PATH=/app/node_modules/.bin:$PATH
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY next.config.ts tsconfig.json server.ts ./
COPY src ./src
# Service worker and app icons (installable app, offline copies).
COPY public ./public
COPY drizzle ./drizzle
COPY scripts/migrate.ts scripts/send-test-email.ts scripts/verify-email.ts scripts/reset-two-factor.ts scripts/generate-vapid-keys.ts ./scripts/
# Uploaded files (local storage). Mount a volume here; see docker-compose.yml.
RUN mkdir -p /app/data/uploads && chown -R node:node /app/data
USER node
EXPOSE 3000
# Apply pending migrations, then start Next + the collaboration server in one process.
CMD ["sh", "-c", "tsx scripts/migrate.ts && exec tsx server.ts"]
