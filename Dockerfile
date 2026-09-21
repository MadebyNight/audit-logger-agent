FROM node:20-bookworm-slim AS dependencies

# better-sqlite3 is a native dependency. Build it against the same Debian
# userspace that the final image uses.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production \
    AUDIT_AGENT_CONFIG_PATH=/app/config.container.json \
    AUDIT_AGENT_BIND_HOST=0.0.0.0

COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json config.container.json agent-audit-log-integration-guide.md ./
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node src ./src

# A newly-created named volume inherits this directory's node ownership.
RUN mkdir -p /app/data && chown node:node /app/data

USER node

EXPOSE 9320

CMD ["node", "scripts/server.js", "--bind", "0.0.0.0", "--port", "9320"]
