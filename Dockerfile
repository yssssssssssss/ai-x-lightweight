FROM node:22-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.12.1 --activate

COPY package.json pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/pnpm-lock.yaml ./apps/web/
RUN pnpm install --frozen-lockfile \
    && pnpm --dir apps/web install --frozen-lockfile

COPY . .
RUN pnpm build \
    && pnpm prune --prod

FROM node:22-bookworm-slim AS runtime

ARG APP_BUILD_ID=local
ENV APP_BUILD_ID=$APP_BUILD_ID
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV API_PORT=3001
ENV RUN_WORKSPACE_ROOT=/app/run-workspaces
WORKDIR /app

RUN groupadd --system app && useradd --system --gid app --home-dir /app app

COPY --from=build --chown=app:app /app/package.json ./package.json
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=app:app /app/database/migrations ./database/migrations
COPY --from=build --chown=app:app /app/orchestrator ./orchestrator
COPY --from=build --chown=app:app /app/schemas ./schemas
COPY --from=build --chown=app:app /app/skills ./skills
COPY --from=build --chown=app:app /app/knowledge-base ./knowledge-base
COPY --from=build --chown=app:app /app/tools ./tools

RUN mkdir -p /app/run-workspaces && chown app:app /app/run-workspaces

USER app
EXPOSE 3001
VOLUME ["/app/run-workspaces"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/api/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/apps/agent-api/src/server.js"]
