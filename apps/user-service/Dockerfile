# ─────────────────────────────────────────────────────────────────────────────
# Stage 1: deps — install ALL dependencies (including devDeps for testing)
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS deps

RUN apk add --no-cache dumb-init

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --ignore-scripts && npm cache clean --force

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2: test — run tests at build time (fail fast)
# ─────────────────────────────────────────────────────────────────────────────
FROM deps AS test

COPY src/ ./src/

RUN npm test

# ─────────────────────────────────────────────────────────────────────────────
# Stage 3: production-deps — prune to production-only dependencies
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS production-deps

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ─────────────────────────────────────────────────────────────────────────────
# Stage 4: final — lean, secure production image
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS final

# Create non-root user before copying files
RUN apk add --no-cache dumb-init \
    && addgroup -g 1001 -S appgroup \
    && adduser -u 1001 -S appuser -G appgroup

WORKDIR /app

# Copy production-only node_modules and app source
COPY --from=production-deps --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --chown=appuser:appgroup package.json ./
COPY --chown=appuser:appgroup src/ ./src/

USER appuser

LABEL org.opencontainers.image.title="user-service" \
      org.opencontainers.image.description="User management microservice - CRUD backed by Redis" \
      org.opencontainers.image.version="1.0.0" \
      org.opencontainers.image.source="https://github.com/vipmed-technology/devops-challenge"

EXPOSE 3001

# Health check via liveness endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:3001/health/live || exit 1

# dumb-init ensures SIGTERM is properly forwarded to Node process
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/index.js"]
