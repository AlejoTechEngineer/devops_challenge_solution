'use strict';

const request = require('supertest');

/**
 * Mock sencillo de redis.
 * Usamos Maps en memoria para simular comportamiento real.
 */

jest.mock('redis', () => {

  const store = new Map();
  const sets = new Map();

  const mockClient = {
    connect: jest.fn().mockResolvedValue(undefined),
    quit: jest.fn().mockResolvedValue(undefined),
    ping: jest.fn().mockResolvedValue('PONG'),

    get: jest.fn(async (key) => store.get(key) || null),

    set: jest.fn(async (key, value) => {
      store.set(key, value);
      return 'OK';
    }),

    del: jest.fn(async (key) => {
      const existed = store.has(key);
      store.delete(key);
      return existed ? 1 : 0;
    }),

    sMembers: jest.fn(async (key) => [...(sets.get(key) || [])]),

    sAdd: jest.fn(async (key, value) => {
      if (!sets.has(key)) sets.set(key, new Set());
      sets.get(key).add(value);
      return 1;
    }),

    sRem: jest.fn(async (key, value) => {
      sets.get(key)?.delete(value);
      return 1;
    }),

    multi: jest.fn(() => ({
      get: jest.fn().mockReturnThis(),
      exec: jest.fn(async () => [...store.values()].map(v => v)),
    })),

    on: jest.fn(),

    // Helpers internos para tests

    _store: store,
    _sets: sets,
    _reset: () => {
      store.clear();
      sets.clear();
    },
  };

  return {
    createClient: jest.fn(() => mockClient),
  };
});

const { createClient } = require('redis');
const { app, connectRedis } = require('./index');

let mockRedis;

beforeAll(async () => {
  mockRedis = createClient();
  await connectRedis();
});

beforeEach(() => {
  mockRedis._reset();
});


// Health

describe('User Service - Health', () => {

  test('GET /health/live responde 200', async () => {
    const res = await request(app).get('/health/live');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('alive');
  });

  test('GET /health/ready responde OK si redis está disponible', async () => {
    mockRedis.ping.mockResolvedValueOnce('PONG');

    const res = await request(app).get('/health/ready');

    expect(res.status).toBe(200);
    expect(res.body.dependencies.redis).toBe('up');
  });

});


// Métricas

describe('User Service - Métricas', () => {

  test('GET /metrics devuelve métricas en formato Prometheus', async () => {
    const res = await request(app).get('/metrics');

    expect(res.status).toBe(200);
    expect(res.text).toContain('http_requests_total');
  });

});


// CRUD usuarios

describe('User Service - CRUD de usuarios', () => {

  test('POST /users crea un usuario correctamente', async () => {

    const res = await request(app)
      .post('/users')
      .send({
        name: 'John Doe',
        email: 'john@example.com',
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.name).toBe('John Doe');
    expect(res.body.email).toBe('john@example.com');
    expect(res.body.created_at).toBeDefined();
  });

  test('POST /users devuelve 400 si faltan campos obligatorios', async () => {

    const res = await request(app)
      .post('/users')
      .send({ name: 'Solo Nombre' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
  });

  test('GET /users devuelve array vacío si no hay usuarios', async () => {

    mockRedis.sMembers.mockResolvedValueOnce([]);

    const res = await request(app).get('/users');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('GET /users/:id devuelve 404 si el usuario no existe', async () => {

    mockRedis.get.mockResolvedValueOnce(null);

    const res = await request(app).get('/users/nonexistent-id');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('user_not_found');
  });

  test('GET /users/:id devuelve el usuario si existe', async () => {

    const user = {
      id: 'test-id',
      name: 'Jane',
      email: 'jane@test.com',
      created_at: new Date().toISOString(),
    };

    mockRedis.get.mockResolvedValueOnce(JSON.stringify(user));

    const res = await request(app).get('/users/test-id');

    expect(res.status).toBe(200);
    expect(res.body.id).toBe('test-id');
    expect(res.body.name).toBe('Jane');
  });

  test('PUT /users/:id actualiza un usuario existente', async () => {

    const user = {
      id: 'test-id',
      name: 'Old Name',
      email: 'old@test.com',
      created_at: new Date().toISOString(),
    };

    mockRedis.get.mockResolvedValueOnce(JSON.stringify(user));

    const res = await request(app)
      .put('/users/test-id')
      .send({ name: 'New Name' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('New Name');
    expect(res.body.updated_at).toBeDefined();
  });

  test('PUT /users/:id devuelve 404 si no existe', async () => {

    mockRedis.get.mockResolvedValueOnce(null);

    const res = await request(app)
      .put('/users/ghost')
      .send({ name: 'Ghost' });

    expect(res.status).toBe(404);
  });

  test('DELETE /users/:id elimina un usuario existente', async () => {

    mockRedis.del.mockResolvedValueOnce(1);

    const res = await request(app).delete('/users/test-id');

    expect(res.status).toBe(204);
  });

  test('DELETE /users/:id devuelve 404 si no existe', async () => {

    mockRedis.del.mockResolvedValueOnce(0);

    const res = await request(app).delete('/users/ghost');

    expect(res.status).toBe(404);
  });

});


// Rutas desconocidas

describe('User Service - Rutas inválidas', () => {

  test('Devuelve 404 si la ruta no existe', async () => {

    const res = await request(app).get('/unknown');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_found');
  });

});
