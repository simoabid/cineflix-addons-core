# ─── Build stage ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ─── Production stage ───────────────────────────────────────────────────────────
FROM node:22-alpine

WORKDIR /app

LABEL org.opencontainers.image.title="addons-core" \
      org.opencontainers.image.description="Stremio addon aggregation backend exposing an OMSS-compliant API."

ARG NODE_ENV=production
ARG PORT=3006
ARG CACHE_TYPE=memory

ENV NODE_ENV=${NODE_ENV}
ENV HOST=0.0.0.0
ENV PORT=${PORT}
ENV CACHE_TYPE=${CACHE_TYPE}
ENV ADDONS_DATA_FILE=/data/addons.json

COPY package*.json ./
RUN npm install --omit=dev

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

CMD ["node", "dist/server.js"]
