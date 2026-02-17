# ─────────────────────────────────────────────────────────────────────────────
# Stage 1: deps — install ALL dependencies (including devDeps for building)
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS deps

# Install dumb-init for proper PID 1 signal handling
RUN apk add --no-cache dumb-init

WORKDIR /app

# Copy only package files first → better layer caching
COPY package.json package-lock.json ./

# Install all deps (including dev) with clean cache
RUN npm ci --ignore-scripts && npm cache clean --force

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2: test — run linting and tests (build-time quality gate)
# ─────────────────────────────────────────────────────────────────────────────
FROM deps AS test

COPY src/ ./src/

RUN npm test

# ─────────────────────────────────────────────────────────────────────────────
# Stage 3: production-deps — install ONLY production dependencies
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS production-deps

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ─────────────────────────────────────────────────────────────────────────────
# Stage 4: final — minimal production image
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS final

# Security hardening
RUN apk add --no-cache dumb-init \
    && addgroup -g 1001 -S appgroup \
    && adduser -u 1001 -S appuser -G appgroup

WORKDIR /app

# Copy dumb-init and production deps from previous stages
COPY --from=production-deps --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --chown=appuser:appgroup package.json ./
COPY --chown=appuser:appgroup src/ ./src/

# Switch to non-root user
USER appuser

# Metadata labels (OCI standard)
LABEL org.opencontainers.image.title="api-gateway" \
      org.opencontainers.image.description="API Gateway service - routes requests to upstream microservices" \
      org.opencontainers.image.version="1.0.0" \
      org.opencontainers.image.source="https://github.com/vipmed-technology/devops-challenge"

# Expose port (documentation only — actual binding via config)
EXPOSE 3000

# Health check using the /health/live endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:3000/health/live || exit 1

# Use dumb-init as PID 1 to properly handle SIGTERM → graceful shutdown
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/index.js"]
