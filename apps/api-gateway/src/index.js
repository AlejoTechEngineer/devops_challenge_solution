'use strict';

const express = require('express');
const http = require('http');
const axios = require('axios');
const client = require('prom-client');
const { createLogger, format, transports } = require('winston');

/**
 * Logger básico con winston.
 * Lo dejo en formato JSON porque es más fácil de parsear cuando corre en contenedores o en la nube.
 */

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.json()
  ),
  defaultMeta: { service: 'api-gateway', version: process.env.APP_VERSION || '1.0.0' },
  transports: [new transports.Console()],
});

/**
 * Configuración de métricas con Prometheus
 */

const register = new client.Registry();
client.collectDefaultMetrics({ register });

// Tiempo que tardan las peticiones HTTP que recibe este servicio

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

// Total de requests que llegan al gateway

const httpRequestTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

// Tiempo de llamadas hacia otros servicios (upstream)

const upstreamRequestDuration = new client.Histogram({
  name: 'upstream_request_duration_seconds',
  help: 'Duration of upstream service requests',
  labelNames: ['service', 'method', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

/**
 * Configuración principal
 */

const PORT = parseInt(process.env.PORT || '3000', 10);
const USER_SERVICE_URL = process.env.USER_SERVICE_URL || 'http://localhost:3001';
const NODE_ENV = process.env.NODE_ENV || 'development';

const app = express();
app.use(express.json());

// Quito este header por seguridad básica

app.disable('x-powered-by');

/**
 * Middleware para medir cuánto tarda cada request
 */

app.use((req, res, next) => {
  const end = httpRequestDuration.startTimer();
  res.on('finish', () => {
    const route = req.route ? req.route.path : req.path;
    end({ method: req.method, route, status_code: res.statusCode });
    httpRequestTotal.inc({ method: req.method, route, status_code: res.statusCode });
  });
  next();
});

/**
 * Middleware simple de logging de requests
 */

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info('request completed', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: Date.now() - start,
      user_agent: req.get('user-agent'),
      remote_addr: req.ip,
    });
  });
  next();
});

/**
 * Health checks
 */

// Liveness: solo verifica que el proceso está vivo

app.get('/health/live', (req, res) => {
  res.status(200).json({ status: 'alive', timestamp: new Date().toISOString() });
});

// Readiness: verifica si el gateway puede responder correctamente. Aquí comprobamos que el user-service esté accesible

app.get('/health/ready', async (req, res) => {
  try {
    const timer = upstreamRequestDuration.startTimer({ service: 'user-service', method: 'GET' });
    await axios.get(`${USER_SERVICE_URL}/health/live`, { timeout: 2000 });
    timer({ status_code: 200 });
    res.status(200).json({ status: 'ready', dependencies: { user_service: 'up' }, timestamp: new Date().toISOString() });
  } catch (err) {
    logger.warn('falló el readiness check', { error: err.message });
    res.status(503).json({ status: 'not ready', dependencies: { user_service: 'down' }, timestamp: new Date().toISOString() });
  }
});

// Endpoint legacy para compatibilidad

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'api-gateway', env: NODE_ENV });
});

/**
 * Endpoint para que Prometheus recoja métricas
 */

app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (err) {
    res.status(500).end(err.message);
  }
});

/**
 * Proxy hacia user-service
 */

app.use('/api/users', async (req, res) => {
  const timer = upstreamRequestDuration.startTimer({ service: 'user-service', method: req.method });
  try {
    const response = await axios({
      method: req.method,
      url: `${USER_SERVICE_URL}/users${req.url === '/' ? '' : req.url}`,
      data: req.body,
      headers: {
        'Content-Type': 'application/json',
        'X-Request-ID': req.headers['x-request-id'] || generateRequestId(),
        'X-Forwarded-For': req.ip,
      },
      timeout: 10000,
    });
    timer({ status_code: response.status });
    res.status(response.status).json(response.data);
  } catch (err) {
    const statusCode = err.response?.status || 502;
    timer({ status_code: statusCode });
    logger.error('error llamando a user-service', {
      service: 'user-service',
      method: req.method,
      path: req.path,
      status: statusCode,
      error: err.message,
    });
    res.status(statusCode).json({
      error: 'upstream_error',
      message: statusCode === 502 ? 'User service no disponible' : err.response?.data?.message || 'Error procesando la petición',
    });
  }
});

/**
 * Manejo básico de 404
 */

app.use((req, res) => {
  res.status(404).json({ error: 'not_found', path: req.path });
});

/**
 * Manejador global de errores
 */

app.use((err, req, res, next) => {
  logger.error('error no controlado', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'internal_server_error' });
});

/**
 * Arranque del servidor + apagado controlado
 */

const server = http.createServer(app);

server.listen(PORT, () => {
  logger.info('servidor iniciado', { port: PORT, env: NODE_ENV, user_service_url: USER_SERVICE_URL });
});

function shutdown(signal) {
  logger.info('apagando servidor', { signal });
  server.close(() => {
    logger.info('servidor cerrado correctamente');
    process.exit(0);
  });

  // Si algo se queda colgado, forzamos salida después de 10s

  setTimeout(() => {
    logger.error('apagado forzado por timeout');
    process.exit(1);
  }, 10000);
}

// Señales del sistema

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  logger.error('uncaught exception', { error: err.message, stack: err.stack });
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.error('unhandled rejection', { reason: String(reason) });
});

/**
 * Genera un ID simple para trazabilidad
 */

function generateRequestId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).substr(2, 9)}`;
}

module.exports = { app, server };
