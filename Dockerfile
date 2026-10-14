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
# Placeholders so modules that read env at import time load during `next build`; nothing connects
# (Better Auth, which queries the database when it is set up, is created on first use: lib/auth.ts).
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
# Liveness, not readiness: the server only listens once the migrations below have been applied, so
# answering already means it started on a migrated database. Orchestrators that replace unhealthy
# containers (Docker Swarm) would otherwise replace this one while the database is down, which
# can't bring the database back. docker-compose.yml overrides this with /api/health/ready.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# Apply pending migrations, then start Next + the collaboration server in one process.
CMD ["sh", "-c", "tsx scripts/migrate.ts && exec tsx server.ts"]
