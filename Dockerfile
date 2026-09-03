# ─── Build stage ──────────────────────────────────────────────────────────────
# Base image pinned by digest (Phase 10 §13.1). The digest pins the amd64
# manifest; update deliberately (supply-chain review) — see docs/supply-chain.md.
FROM node:22-alpine@sha256:76789712cd1ae89a1225eac9077010d68987a423588042dac30446f502f1858c AS builder

WORKDIR /app

# Reproducible installs from the committed lockfile (Phase 10 §13.1).
COPY package*.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ─── Production stage ───────────────────────────────────────────────────────────
FROM node:22-alpine@sha256:76789712cd1ae89a1225eac9077010d68987a423588042dac30446f502f1858c

WORKDIR /app

LABEL org.opencontainers.image.title="addons-core" \
      org.opencontainers.image.description="Stremio addon aggregation backend exposing an OMSS-compliant API." \
      org.opencontainers.image.source="https://github.com/simoabid/cineflix-addons-core" \
      org.opencontainers.image.licenses="SEE LICENSE"

ARG NODE_ENV=production
ARG PORT=3006
ARG CACHE_TYPE=memory

ENV NODE_ENV=${NODE_ENV}
ENV HOST=0.0.0.0
ENV PORT=${PORT}
ENV CACHE_TYPE=${CACHE_TYPE}
ENV ADDONS_DATA_FILE=/data/addons.json

# Runtime dependencies only — dev tooling never ships in the image.
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY public ./public

# Persist installed addons across restarts.
RUN mkdir -p /data && \
    addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /data /app
VOLUME ["/data"]

USER nodejs

EXPOSE ${PORT}

# Liveness: the dedicated liveness endpoint reports event-loop health only
# (readiness is a separate probe — see docs/runbooks/INDEX.md).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3006)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Node as PID 1: the server registers SIGTERM/SIGINT shutdown handlers
# (src/lifecycle/shutdown.ts), so no init wrapper is required.
CMD ["node", "dist/server.js"]

