# Etapa 1: instalar dependencias completas (incluye dev)

FROM node:20-alpine AS deps

# Instalamos dumb-init para que el contenedor maneje correctamente señales como SIGTERM

RUN apk add --no-cache dumb-init

WORKDIR /app

# Copiamos primero los package*.json para aprovechar cache

COPY package.json package-lock.json ./

# Instalamos todas las dependencias (incluye devDependencies)

RUN npm ci --ignore-scripts \
    && npm cache clean --force

# Etapa 2: correr tests en tiempo de build. Si algo falla aquí, la imagen no se construye

FROM deps AS test

COPY src/ ./src/

RUN npm test

# Etapa 3: solo dependencias de producción

FROM node:20-alpine AS production-deps

WORKDIR /app

COPY package.json package-lock.json ./

# Instalamos únicamente dependencias necesarias para prod

RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

# Etapa final: imagen mínima lista para producción

FROM node:20-alpine AS final

# Instalamos dumb-init y creamos usuario no root

RUN apk add --no-cache dumb-init \
    && addgroup -S appgroup -g 1001 \
    && adduser -S appuser -u 1001 -G appgroup

WORKDIR /app

# Copiamos solo lo necesario desde etapas anteriores

COPY --from=production-deps --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --chown=appuser:appgroup package.json ./
COPY --chown=appuser:appgroup src/ ./src/

# Cambiamos a usuario sin privilegios (mejor práctica)

USER appuser

# Metadata básica de la imagen

LABEL org.opencontainers.image.title="api-gateway" \
      org.opencontainers.image.description="Servicio API Gateway que enruta peticiones a otros microservicios" \
      org.opencontainers.image.version="1.0.0" \
      org.opencontainers.image.source="https://github.com/vipmed-technology/devops-challenge"

# Puerto expuesto (solo informativo)

EXPOSE 3000

# Healthcheck sencillo usando el endpoint de liveness

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health/live || exit 1

# Usamos dumb-init como PID 1 para que el shutdown sea limpio

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/index.js"]
