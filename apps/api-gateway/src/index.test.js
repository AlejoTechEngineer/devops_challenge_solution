'use strict';

const request = require('supertest');

// Mock axios before requiring app
jest.mock('axios');
const axios = require('axios');

const { app, server } = require('./index');

afterAll((done) => {
  server.close(done);
});

describe('API Gateway - Health Checks', () => {
  test('GET /health returns 200', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('api-gateway');
  });

  test('GET /health/live returns 200', async () => {
    const res = await request(app).get('/health/live');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('alive');
    expect(res.body.timestamp).toBeDefined();
  });

  test('GET /health/ready returns 200 when user-service is up', async () => {
    axios.get = jest.fn().mockResolvedValue({ status: 200, data: { status: 'alive' } });
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
    expect(res.body.dependencies.user_service).toBe('up');
  });

  test('GET /health/ready returns 503 when user-service is down', async () => {
    axios.get = jest.fn().mockRejectedValue(new Error('Connection refused'));
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not ready');
    expect(res.body.dependencies.user_service).toBe('down');
  });
});

describe('API Gateway - Metrics', () => {
  test('GET /metrics returns prometheus metrics', async () => {
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.text).toContain('http_requests_total');
  });
});

describe('API Gateway - User Proxy', () => {
  test('GET /api/users proxies to user-service', async () => {
    axios.mockResolvedValue({ status: 200, data: [{ id: '1', name: 'Test User' }] });
    const res = await request(app).get('/api/users');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('POST /api/users proxies to user-service', async () => {
    const newUser = { name: 'John Doe', email: 'john@example.com' };
    axios.mockResolvedValue({ status: 201, data: { id: '2', ...newUser } });
    const res = await request(app).post('/api/users').send(newUser);
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('John Doe');
  });

  test('returns 502 when user-service is unreachable', async () => {
    axios.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await request(app).get('/api/users');
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('upstream_error');
  });
});

describe('API Gateway - 404 Handler', () => {
  test('returns 404 for unknown routes', async () => {
    const res = await request(app).get('/unknown/route');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });
});
