'use strict';

const express = require('express');
const http = require('http');
const { createClient } = require('redis');
const { v4: uuidv4 } = require('uuid');
const client = require('prom-client');
const { createLogger, format, transports } = require('winston');

// ─── Structured Logger ────────────────────────────────────────────────────────
const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.json()
  ),
  defaultMeta: { service: 'user-service', version: process.env.APP_VERSION || '1.0.0' },
  transports: [new transports.Console()],
});

// ─── Prometheus Metrics ───────────────────────────────────────────────────────
const register = new client.Registry();
client.collectDefaultMetrics({ register });

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

const httpRequestTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

const redisOperationDuration = new client.Histogram({
  name: 'redis_operation_duration_seconds',
  help: 'Duration of Redis operations',
  labelNames: ['operation', 'status'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25],
  registers: [register],
});

const usersTotal = new client.Gauge({
  name: 'users_total',
  help: 'Total number of users in the system',
  registers: [register],
});

// ─── App Config ───────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3001', 10);
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const NODE_ENV = process.env.NODE_ENV || 'development';
const REDIS_KEY_PREFIX = 'user:';
const USERS_INDEX_KEY = 'users:index';

// ─── Redis Client ─────────────────────────────────────────────────────────────
let redisClient = null;
let redisReady = false;

async function connectRedis() {
  redisClient = createClient({
    url: REDIS_URL,
    socket: {
      reconnectStrategy: (retries) => {
        if (retries > 10) {
          logger.error('redis max reconnect attempts reached');
          return new Error('Max reconnect attempts reached');
        }
        const delay = Math.min(retries * 100, 3000);
        logger.warn('redis reconnecting', { attempt: retries, delay_ms: delay });
        return delay;
      },
    },
  });

  redisClient.on('connect', () => { logger.info('redis connected'); redisReady = true; });
  redisClient.on('ready', () => { logger.info('redis ready'); redisReady = true; });
  redisClient.on('error', (err) => { logger.error('redis error', { error: err.message }); redisReady = false; });
  redisClient.on('end', () => { logger.warn('redis connection closed'); redisReady = false; });

  await redisClient.connect();
}

// ─── Express App ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.disable('x-powered-by');

// ─── Request Metrics Middleware ───────────────────────────────────────────────
app.use((req, res, next) => {
  const end = httpRequestDuration.startTimer();
  res.on('finish', () => {
    const route = req.route ? req.route.path : req.path;
    end({ method: req.method, route, status_code: res.statusCode });
    httpRequestTotal.inc({ method: req.method, route, status_code: res.statusCode });
  });
  next();
});

// ─── Request Logger ───────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info('request completed', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: Date.now() - start,
      request_id: req.headers['x-request-id'],
    });
  });
  next();
});

// ─── Health Checks ────────────────────────────────────────────────────────────
app.get('/health/live', (req, res) => {
  res.status(200).json({ status: 'alive', timestamp: new Date().toISOString() });
});

app.get('/health/ready', async (req, res) => {
  if (!redisReady || !redisClient) {
    return res.status(503).json({ status: 'not ready', dependencies: { redis: 'down' }, timestamp: new Date().toISOString() });
  }
  try {
    const timer = redisOperationDuration.startTimer({ operation: 'ping' });
    await redisClient.ping();
    timer({ status: 'success' });
    res.status(200).json({ status: 'ready', dependencies: { redis: 'up' }, timestamp: new Date().toISOString() });
  } catch (err) {
    logger.warn('readiness check failed', { error: err.message });
    res.status(503).json({ status: 'not ready', dependencies: { redis: 'down' }, timestamp: new Date().toISOString() });
  }
});

// ─── Prometheus Metrics ───────────────────────────────────────────────────────
app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (err) {
    res.status(500).end(err.message);
  }
});

// ─── CRUD Routes ──────────────────────────────────────────────────────────────

// GET /users - list all users
app.get('/users', async (req, res) => {
  try {
    const timer = redisOperationDuration.startTimer({ operation: 'smembers' });
    const userIds = await redisClient.sMembers(USERS_INDEX_KEY);
    timer({ status: 'success' });

    if (!userIds.length) return res.json([]);

    const pipeline = redisClient.multi();
    userIds.forEach((id) => pipeline.get(`${REDIS_KEY_PREFIX}${id}`));
    const results = await pipeline.exec();

    const users = results
      .filter(Boolean)
      .map((raw) => { try { return JSON.parse(raw); } catch { return null; } })
      .filter(Boolean);

    usersTotal.set(users.length);
    res.json(users);
  } catch (err) {
    logger.error('failed to list users', { error: err.message });
    res.status(500).json({ error: 'failed_to_fetch_users' });
  }
});

// GET /users/:id
app.get('/users/:id', async (req, res) => {
  try {
    const timer = redisOperationDuration.startTimer({ operation: 'get' });
    const raw = await redisClient.get(`${REDIS_KEY_PREFIX}${req.params.id}`);
    timer({ status: raw ? 'success' : 'miss' });

    if (!raw) return res.status(404).json({ error: 'user_not_found', id: req.params.id });
    res.json(JSON.parse(raw));
  } catch (err) {
    logger.error('failed to get user', { id: req.params.id, error: err.message });
    res.status(500).json({ error: 'failed_to_fetch_user' });
  }
});

// POST /users
app.post('/users', async (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) {
    return res.status(400).json({ error: 'validation_error', message: 'name and email are required' });
  }

  const user = { id: uuidv4(), name, email, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };

  try {
    const timer = redisOperationDuration.startTimer({ operation: 'set' });
    await redisClient.set(`${REDIS_KEY_PREFIX}${user.id}`, JSON.stringify(user));
    await redisClient.sAdd(USERS_INDEX_KEY, user.id);
    timer({ status: 'success' });

    logger.info('user created', { user_id: user.id });
    usersTotal.inc();
    res.status(201).json(user);
  } catch (err) {
    logger.error('failed to create user', { error: err.message });
    res.status(500).json({ error: 'failed_to_create_user' });
  }
});

// PUT /users/:id
app.put('/users/:id', async (req, res) => {
  const { name, email } = req.body;
  if (!name && !email) {
    return res.status(400).json({ error: 'validation_error', message: 'at least one field (name, email) is required' });
  }

  try {
    const raw = await redisClient.get(`${REDIS_KEY_PREFIX}${req.params.id}`);
    if (!raw) return res.status(404).json({ error: 'user_not_found', id: req.params.id });

    const existing = JSON.parse(raw);
    const updated = { ...existing, ...(name && { name }), ...(email && { email }), updated_at: new Date().toISOString() };

    const timer = redisOperationDuration.startTimer({ operation: 'set' });
    await redisClient.set(`${REDIS_KEY_PREFIX}${updated.id}`, JSON.stringify(updated));
    timer({ status: 'success' });

    logger.info('user updated', { user_id: updated.id });
    res.json(updated);
  } catch (err) {
    logger.error('failed to update user', { id: req.params.id, error: err.message });
    res.status(500).json({ error: 'failed_to_update_user' });
  }
});

// DELETE /users/:id
app.delete('/users/:id', async (req, res) => {
  try {
    const timer = redisOperationDuration.startTimer({ operation: 'del' });
    const deleted = await redisClient.del(`${REDIS_KEY_PREFIX}${req.params.id}`);
    timer({ status: deleted ? 'success' : 'miss' });

    if (!deleted) return res.status(404).json({ error: 'user_not_found', id: req.params.id });

    await redisClient.sRem(USERS_INDEX_KEY, req.params.id);
    logger.info('user deleted', { user_id: req.params.id });
    usersTotal.dec();
    res.status(204).send();
  } catch (err) {
    logger.error('failed to delete user', { id: req.params.id, error: err.message });
    res.status(500).json({ error: 'failed_to_delete_user' });
  }
});

// ─── 404 + Error Handlers ─────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'not_found', path: req.path });
});

app.use((err, req, res, next) => {
  logger.error('unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'internal_server_error' });
});

// ─── Server + Graceful Shutdown ───────────────────────────────────────────────
let server;

async function start() {
  try {
    await connectRedis();
    server = http.createServer(app);
    server.listen(PORT, () => {
      logger.info('server started', { port: PORT, env: NODE_ENV, redis_url: REDIS_URL });
    });
  } catch (err) {
    logger.error('failed to start server', { error: err.message });
    process.exit(1);
  }
}

function shutdown(signal) {
  logger.info('shutdown initiated', { signal });
  const closing = server ? server.close(() => {}) : Promise.resolve();
  const redisClose = redisClient ? redisClient.quit() : Promise.resolve();

  Promise.all([closing, redisClose]).then(() => {
    logger.info('graceful shutdown complete');
    process.exit(0);
  });

  setTimeout(() => {
    logger.error('forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  logger.error('uncaught exception', { error: err.message, stack: err.stack });
  process.exit(1);
});

// Start server only if not in test mode
if (require.main === module) {
  start();
}

module.exports = { app, connectRedis, getRedisClient: () => redisClient };
