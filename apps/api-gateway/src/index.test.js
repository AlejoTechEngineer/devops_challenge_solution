'use strict';

const request = require('supertest');

/**
 * Mockeamos axios antes de cargar la app, así evitamos llamadas reales al user-service.
 */

jest.mock('axios');
const axios = require('axios');

const { app, server } = require('./index');

/**
 * Cerramos el servidor al terminar todos los tests, para que Jest no se quede colgado.
 */

afterAll((done) => {
  server.close(done);
});

// Health checks

describe('API Gateway - Health Checks', () => {
  test('GET /health debería responder OK', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('api-gateway');
  });

  test('GET /health/live confirma que el proceso está vivo', async () => {
    const res = await request(app).get('/health/live');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('alive');
    expect(res.body.timestamp).toBeDefined();
  });

  test('GET /health/ready responde ready si user-service está arriba', async () => {
    axios.get = jest.fn().mockResolvedValue({ status: 200, data: { status: 'alive' } });
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
    expect(res.body.dependencies.user_service).toBe('up');
  });

  test('GET /health/ready responde 503 si user-service no está disponible', async () => {
    axios.get = jest.fn().mockRejectedValue(new Error('Connection refused'));
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not ready');
    expect(res.body.dependencies.user_service).toBe('down');
  });
});

// Metricas

describe('API Gateway - Metricas', () => {
  test('GET /metrics debería devolver métricas en formato Prometheus', async () => {
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.text).toContain('http_requests_total');
  });
});

// Proxy hacia user-service

describe('API Gateway - Proxy de usuarios', () => {
  test('GET /api/users debería reenviar la petición al user-service', async () => {
    axios.mockResolvedValue({ status: 200, data: [{ id: '1', name: 'Test User' }] });
    const res = await request(app).get('/api/users');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('POST /api/users debería crear un usuario vía user-service', async () => {
    const newUser = { name: 'John Doe', email: 'john@example.com' };
    axios.mockResolvedValue({ status: 201, data: { id: '2', ...newUser } });
    const res = await request(app).post('/api/users').send(newUser);
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('John Doe');
  });

  test('Devuelve 502 si el user-service no responde', async () => {
    axios.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await request(app).get('/api/users');
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('upstream_error');
  });
});

// Rutas inexistentes

describe('API Gateway - Rutas no válidas', () => {
  test('Devuelve 404 si la ruta no existe', async () => {
    const res = await request(app).get('/unknown/route');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });
});
