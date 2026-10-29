# syntax=docker/dockerfile:1
# Node 24 runs the .ts sources directly (type stripping, node:sqlite): there is no build step.
ARG NODE_IMAGE=node:24.11.1-bookworm-slim

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
# the lockfile is required: without it the COPY fails and the build stops. Runtime deps only, no install scripts.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

FROM ${NODE_IMAGE}
# npm, npx and corepack are not needed at runtime
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
 && groupadd --system --gid 10001 sayso-demo \
 && useradd --system --uid 10001 --gid 10001 --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin sayso-demo \
 && mkdir -p /app/data && chown 10001:10001 /app/data
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public

# DEMO_HOST, DEMO_PORT and DEMO_DATA_DIR are set in compose.yaml, where .env cannot override them; secrets come from
# the env file at run time, never from the image
ENV NODE_ENV=production
USER 10001:10001
EXPOSE 8787
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.DEMO_PORT||8787)+'/api/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "src/main.ts"]
