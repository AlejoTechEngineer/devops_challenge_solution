# Etapa 1: instalar dependencias completas (incluye dev)

FROM node:20-alpine AS deps

# dumb-init ayuda a manejar correctamente señales en Docker

RUN apk add --no-cache dumb-init

WORKDIR /app

# Copiamos package files primero para aprovechar cache

COPY package.json package-lock.json ./

# Instalamos todo (incluyendo dependencias de desarrollo)

RUN npm ci --ignore-scripts \
    && npm cache clean --force


# Etapa 2: correr tests durante el build. Si falla aquí, no se genera la imagen

FROM deps AS test
COPY src/ ./src/
RUN npm test


# Etapa 3: dependencias solo de producción

FROM node:20-alpine AS production-deps

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force


# Imagen final: versión ligera lista para producción

FROM node:20-alpine AS final

# Creamos usuario sin permisos root por seguridad

RUN apk add --no-cache dumb-init \
    && addgroup -S appgroup -g 1001 \
    && adduser -S appuser -u 1001 -G appgroup

WORKDIR /app

# Copiamos únicamente lo necesario para ejecutar el servicio

COPY --from=production-deps --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --chown=appuser:appgroup package.json ./
COPY --chown=appuser:appgroup src/ ./src/

# Ejecutamos como usuario no root

USER appuser

# Metadata básica de la imagen

LABEL org.opencontainers.image.title="user-service" \
      org.opencontainers.image.description="Microservicio de usuarios (CRUD) usando Redis como backend" \
      org.opencontainers.image.version="1.0.0" \
      org.opencontainers.image.source="https://github.com/vipmed-technology/devops-challenge"

# Puerto del servicio

EXPOSE 3001

# Healthcheck usando el endpoint de liveness

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3001/health/live || exit 1

# dumb-init permite un shutdown más limpio en Kubernetes/Docker

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/index.js"]
