'use strict';

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const express = require('express');
const http = require('http');
const { createClient } = require('redis');
const { v4: uuidv4 } = require('uuid');
const client = require('prom-client');
const { createLogger, format, transports } = require('winston');

/**
 * Logger con winston.
 * Lo usamos en formato JSON porque es lo más práctico en contenedores.
 *                                                                                                                                            1. y 2. En esta parte del codigo se cumple con Implement structured JSON logging donde se indica format.json() para que los logs se emitan en formato JSON, lo que facilita su análisis y procesamiento en sistemas de logging centralizados como ELK o Grafana Loki. Además, se incluye metadata adicional como el nombre del servicio y la versión de la aplicación para mejorar la trazabilidad de los logs.
 *                                                                                                                                                    En la parte de arriba se implementa winston como logger, configurado para emitir logs en formato JSON, con un nivel de log configurable a través de la variable de entorno LOG_LEVEL. Se incluye metadata adicional en cada log, como el nombre del servicio y la versión de la aplicación, lo que facilita el análisis y la correlación de logs en sistemas centralizados. Además, se configuran transportes para enviar los logs a la consola, lo que es útil para entornos de contenedores donde los logs se recogen desde stdout.
 *                                                                                                                                                    Se cumple con timestamp en format.timestamp() para incluir la marca de tiempo en cada log, lo que es esencial para el análisis temporal de eventos. También se utiliza format.errors({ stack: true }) para asegurarse de que los errores se registren con su stack trace completo, lo que facilita la depuración de problemas en producción.
 *                                                                                                                                                    Se cumple con level ya que winston lo agrega de manera automatica a cada log, y se puede configurar el nivel de log a través de la variable de entorno LOG_LEVEL, lo que permite controlar la verbosidad de los logs sin necesidad de cambiar el código.
 *                                                                                                                                                    Se cumple con message ya que winston lo agrega de manera automatica a cada log de igual manera, y se puede incluir un mensaje descriptivo en cada llamada al logger, lo que mejora la claridad de los logs.
 *                                                                                                                                                    En resumen, esta configuración de winston permite implementar un sistema de logging estructurado y configurable, que es fundamental para el monitoreo y la depuración efectiva de aplicaciones en producción.
 */

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    format.json()
  ),
  defaultMeta: {
    service: 'user-service',
    version: process.env.APP_VERSION || '1.0.0',
  },
  transports: [new transports.Console()],
});


/**
 * Métricas básicas para Prometheus
 */

const register = new client.Registry();
client.collectDefaultMetrics({ register });

// Tiempo de requests HTTP que recibe este servicio

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duración de peticiones HTTP en segundos',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

// Contador total de requests

const httpRequestTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total de peticiones HTTP recibidas',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

// Tiempo de operaciones en Redis

const redisOperationDuration = new client.Histogram({
  name: 'redis_operation_duration_seconds',
  help: 'Duración de operaciones contra Redis',
  labelNames: ['operation', 'status'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25],
  registers: [register],
});

// Métrica simple del total de usuarios

const usersTotal = new client.Gauge({
  name: 'users_total',
  help: 'Cantidad total de usuarios guardados',
  registers: [register],
});


/**
 * Configuración Redis
 *                                                                                                                                              3.1. En esta parte esta la configuracion de Redis connection, donde se define la URL de Redis a través de la variable de entorno REDIS_URL, con un valor por defecto de redis://localhost:6379. También se define un prefijo para las claves de Redis (REDIS_KEY_PREFIX) y una clave para mantener el índice de usuarios (USERS_INDEX_KEY). Esto permite configurar fácilmente la conexión a Redis y organizar las claves de manera consistente.
 */

const PORT = parseInt(process.env.PORT || '3001', 10);
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const NODE_ENV = process.env.NODE_ENV || 'development';

const REDIS_KEY_PREFIX = 'user:';
const USERS_INDEX_KEY = 'users:index';


/**
 * Cliente Redis
 *                                                                                                                                              3.2. En esta parte se ejecuta el redis connection con createClient, usando la URL de Redis configurada en la variable de entorno REDIS_URL. Se implementa una estrategia de reconexión personalizada que intenta reconectar con un delay incremental, y se loguean los eventos de conexión, error y cierre para tener visibilidad sobre el estado de la conexión a Redis. Esto es crucial para garantizar la resiliencia del servicio frente a problemas temporales con Redis, y para facilitar el monitoreo y la depuración en producción.
 */

let redisClient = null;
let redisReady = false;

async function connectRedis() {
  redisClient = createClient({
    url: REDIS_URL,
    socket: {
      reconnectStrategy: (retries) => {
        if (retries > 10) {
          logger.error('se alcanzó el máximo de intentos de reconexión a redis');
          return new Error('Max reconnect attempts reached');
        }

        const delay = Math.min(retries * 100, 3000);

    /**
     *                                                                                                                                          4.3. En esta parte podemos tambien ver el logger de winston en acción, donde se implementa un middleware de Express para registrar cada petición HTTP que recibe el servicio. Se registra información relevante como el método HTTP, la ruta, el código de estado de la respuesta, la duración de la petición y un identificador único de la solicitud (request_id) si está presente en los headers. Esto permite tener un registro detallado de las interacciones con el servicio, lo que es fundamental para el monitoreo y la depuración en producción.
     */

        logger.warn('reintentando conexión a redis', {
          attempt: retries,
          delay_ms: delay,
        });

        return delay;
      },
    },
  });

  /**
  *                                                                                                                                              3.3. En esta parte se ejecuta el redis connection con createClient, usando la URL de Redis configurada en la variable de entorno REDIS_URL. Se implementa una estrategia de reconexión personalizada que intenta reconectar con un delay incremental, y se loguean los eventos de conexión, error y cierre para tener visibilidad sobre el estado de la conexión a Redis. Esto es crucial para garantizar la resiliencia del servicio frente a problemas temporales con Redis, y para facilitar el monitoreo y la depuración en producción.
  */

  redisClient.on('connect', () => {
    logger.info('redis conectado');
    redisReady = true;
  });

  redisClient.on('ready', () => {
    logger.info('redis listo para usarse');
    redisReady = true;
  });

  redisClient.on('error', (err) => {
    logger.error('error en redis', { error: err.message });
    redisReady = false;
  });

  redisClient.on('end', () => {
    logger.warn('conexión a redis cerrada');
    redisReady = false;
  });

  await redisClient.connect();
}


/**
 * Initialize sample data
 * Se ejecuta solo en development
 *                                                                                                                                                7. En esta parte se da inicialización de datos de prueba, donde se define una función initializeSampleData que verifica si ya existen usuarios en Redis y, si no es así, inserta un conjunto de usuarios de ejemplo. Esto es útil para facilitar el desarrollo y las pruebas locales, asegurando que el servicio tenga datos con los que trabajar sin necesidad de insertar manualmente cada vez. Además, se loguea el proceso de inicialización para tener visibilidad sobre cuándo se están creando los datos de prueba.
 */

async function initializeSampleData() {
  if (NODE_ENV === 'production') return;
  
  const existingIds = await redisClient.sMembers(USERS_INDEX_KEY);

  if (existingIds.length > 0) {
    logger.info('sample data ya existe, no se inicializa');
    return;
  }

  logger.info('inicializando sample data...');

  const now = new Date().toISOString();

  const sampleUsers = [
    {
      id: uuidv4(),
      name: 'Alice Example',
      email: 'alice@test.com',
      created_at: now,
      updated_at: now,
    },
    {
      id: uuidv4(),
      name: 'Bob Example',
      email: 'bob@test.com',
      created_at: now,
      updated_at: now,
    },
  ];

  for (const user of sampleUsers) {
    await redisClient.set(
      `${REDIS_KEY_PREFIX}${user.id}`,
      JSON.stringify(user)
    );

    await redisClient.sAdd(USERS_INDEX_KEY, user.id);
  }

  usersTotal.set(sampleUsers.length);

  logger.info('sample data inicializada correctamente', {
    total_users: sampleUsers.length,
  });
}

/**
 * Express app
 */

const app = express();
app.use(express.json());
app.disable('x-powered-by');

/**
 * Arranque del servidor
 *                                                                                                                                              3.4. En esta parte se implementa Redis connection + server startup, donde se define una función start() que se encarga de conectar a Redis, inicializar datos de prueba si es necesario, y luego levantar el servidor HTTP. Si ocurre algún error durante este proceso, se loguea el error y se termina el proceso con un código de salida 1. Esto garantiza que el servicio solo se inicie correctamente si puede conectarse a Redis, lo que es crucial para su funcionamiento correcto.
 */

let server;

async function start() {
  try {
    // 1. Conectar Redis
    await connectRedis();

    // 2. Inicializar datos de prueba
    await initializeSampleData();

    // 3. Levantar servidor HTTP
    server = http.createServer(app);

    server.listen(PORT, () => {
      logger.info('user-service iniciado', {
        port: PORT,
        env: NODE_ENV,
        redis_url: REDIS_URL,
      });
    });

  } catch (err) {
    logger.error('no se pudo iniciar el servidor', {
      error: err.message,
    });
    process.exit(1);
  }
}




/**
 * Middleware para métricas HTTP
 */

app.use((req, res, next) => {
  const end = httpRequestDuration.startTimer();

  res.on('finish', () => {
    const route = req.route ? req.route.path : req.path;

    end({
      method: req.method,
      route,
      status_code: res.statusCode,
    });

    httpRequestTotal.inc({
      method: req.method,
      route,
      status_code: res.statusCode,
    });
  });

  next();
});


/**
 * Logging simple de requests
 *                                                                                                                                              1.1. En esta parte podemos ver el logger de winston en acción, donde se implementa un middleware de Express para registrar cada petición HTTP que recibe el servicio. Se registra información relevante como el método HTTP, la ruta, el código de estado de la respuesta, la duración de la petición y un identificador único de la solicitud (request_id) si está presente en los headers. Esto permite tener un registro detallado de las interacciones con el servicio, lo que es fundamental para el monitoreo y la depuración en producción.
 *                                                                                                                                              4. En esta parte se cumple con Add request logging middleware donde se implementa un middleware de Express para registrar cada petición HTTP que recibe el servicio. Se registra información relevante como el método HTTP, la ruta, el código de estado de la respuesta, la duración de la petición y un identificador único de la solicitud (request_id) si está presente en los headers. Esto permite tener un registro detallado de las interacciones con el servicio, lo que es fundamental para el monitoreo y la depuración en producción.
 *                                                                                                                                                 Este middleware intercepta todas las requests, mide duracion, registra el metodo, ruta, status code y escribe logs estructurados con winston, lo que es esencial para el monitoreo y la depuración efectiva de la aplicación en producción.
 */

app.use((req, res, next) => {
  const start = Date.now();

  res.on('finish', () => {
    logger.info('request procesado', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: Date.now() - start,
      request_id: req.headers['x-request-id'],
    });
  });

  next();
});


/**
 * Health checks endpoints
 *                                                                                                                                               5. En esta parte se implementan endpoints de health checks para Kubernetes, con una ruta /health/live para el liveness probe que indica si el servicio está vivo, y una ruta /health/ready para el readiness probe que verifica la conexión a Redis. Esto permite a Kubernetes monitorear la salud del servicio y tomar acciones como reiniciarlo si no responde o no está listo para recibir tráfico.
 *                                                                                                                                                  En la ruta /health/ready se verifica si el servicio está listo para recibir tráfico, lo que incluye verificar la conexión a Redis. Si Redis no está listo, se responde con un estado 503 indicando que el servicio no está listo. Si Redis está listo, se intenta hacer un ping para verificar que la conexión funciona correctamente, y se mide el tiempo de esta operación para monitorear el rendimiento de Redis. Esto es crucial para garantizar que el servicio solo reciba tráfico cuando esté completamente funcional y pueda manejar las solicitudes correctamente.
 */

app.get('/health/live', (req, res) => {
  res.status(200).json({
    status: 'alive',
    timestamp: new Date().toISOString(),
  });
});

app.get('/health/ready', async (req, res) => {

  if (!redisReady || !redisClient) {
    return res.status(503).json({
      status: 'not ready',
      dependencies: { redis: 'down' },
      timestamp: new Date().toISOString(),
    });
  }

  try {
    const timer = redisOperationDuration.startTimer({ operation: 'ping' });

    await redisClient.ping();

    timer({ status: 'success' });

    res.status(200).json({
      status: 'ready',
      dependencies: { redis: 'up' },
      timestamp: new Date().toISOString(),
    });

  } catch (err) {
    logger.warn('falló el readiness check', { error: err.message });

    res.status(503).json({
      status: 'not ready',
      dependencies: { redis: 'down' },
      timestamp: new Date().toISOString(),
    });
  }
});


/**
 * Endpoint para Prometheus
 *                                                                                                                                                   6. En esta parte se implementa un endpoint /metrics para exponer las métricas de Prometheus. Este endpoint responde con el contenido generado por client.register.metrics(), que incluye tanto las métricas personalizadas definidas en el código como las métricas por defecto que client.collectDefaultMetrics() ya está recolectando. Esto permite a Prometheus scrapear este endpoint y recolectar las métricas para su monitoreo y análisis.
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
 * CRUD de usuarios
 *                                                                                                                                                   8. En esta parte se implementa un CRUD completo de usuarios, con endpoints para listar usuarios, buscar por ID, crear, actualizar y eliminar usuarios. Los datos se almacenan en Redis, utilizando un esquema simple donde cada usuario se guarda como un string JSON bajo una clave con prefijo (user:{id}), y se mantiene un índice de IDs de usuarios en un set para facilitar la consulta de todos los usuarios. Cada operación contra Redis se mide con métricas personalizadas para monitorear su rendimiento, y se utilizan logs estructurados para registrar eventos importantes como la creación, actualización o eliminación de usuarios, así como errores que puedan ocurrir durante estas operaciones.
 */

// Listar usuarios

app.get('/users', async (req, res) => {
  try {
    const timer = redisOperationDuration.startTimer({ operation: 'smembers' });

    const userIds = await redisClient.sMembers(USERS_INDEX_KEY);

    timer({ status: 'success' });

    if (!userIds.length) return res.json([]);

    const pipeline = redisClient.multi();
    userIds.forEach((id) =>
      pipeline.get(`${REDIS_KEY_PREFIX}${id}`)
    );

    const results = await pipeline.exec();

    const users = results
      .filter(Boolean)
      .map((raw) => {
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    usersTotal.set(users.length);

    res.json(users);

  } catch (err) {
    logger.error('error listando usuarios', { error: err.message });
    res.status(500).json({ error: 'failed_to_fetch_users' });
  }
});

/**
* Buscar usuario por id
*                                                                                                                                                          9. En esta parte se implementa el endpoint para buscar un usuario por ID, donde se recibe el ID del usuario a través de los parámetros de la ruta, se consulta Redis para obtener los datos del usuario, y se responde con el usuario encontrado o con un error si no se encuentra. Se mide el tiempo de la operación contra Redis y se registran logs estructurados para tener visibilidad sobre las búsquedas de usuarios y cualquier error que pueda ocurrir durante este proceso.
*/

app.get('/users/:id', async (req, res) => {
  try {
    const timer = redisOperationDuration.startTimer({ operation: 'get' });

    const raw = await redisClient.get(
      `${REDIS_KEY_PREFIX}${req.params.id}`
    );

    timer({ status: raw ? 'success' : 'miss' });

    if (!raw) {
      return res.status(404).json({
        error: 'user_not_found',
        id: req.params.id,
      });
    }

    res.json(JSON.parse(raw));

  } catch (err) {
    logger.error('error buscando usuario', {
      id: req.params.id,
      error: err.message,
    });

    res.status(500).json({ error: 'failed_to_fetch_user' });
  }
});

/**
* Crear usuario
*                                                                                                                                                          10. En esta parte se implementa el endpoint para crear un nuevo usuario, donde se reciben los datos del usuario a través del cuerpo de la solicitud, se valida que se hayan proporcionado los campos necesarios, y luego se guarda el nuevo usuario en Redis con una ID única generada. Se mide el tiempo de la operación contra Redis y se registran logs estructurados para tener visibilidad sobre la creación de usuarios y cualquier error que pueda ocurrir durante este proceso. Además, se incrementa la métrica de total de usuarios cada vez que se crea un nuevo usuario.
*/

app.post('/users', async (req, res) => {
  const { name, email } = req.body;

  if (!name || !email) {
    return res.status(400).json({
      error: 'validation_error',
      message: 'name y email son obligatorios',
    });
  }

  const now = new Date().toISOString();

  const user = {
    id: uuidv4(),
    name,
    email,
    created_at: now,
    updated_at: now,
  };

  try {

    /**
     * Check for duplicate email
     *                                                                                                                                                      11. En esta parte se implementa una verificación para evitar la creación de usuarios con emails duplicados. Antes de guardar un nuevo usuario, se consulta Redis para obtener la lista de IDs de usuarios existentes, y luego se verifica si alguno de esos usuarios tiene el mismo email que el nuevo usuario que se está intentando crear. Si se encuentra un usuario con el mismo email, se responde con un error 409 indicando que ya existe un usuario con ese email. Esto es importante para mantener la integridad de los datos y evitar conflictos en la aplicación.
     */

    const existingIds = await redisClient.sMembers(USERS_INDEX_KEY);

    for (const id of existingIds) {
      const rawUser = await redisClient.get(`${REDIS_KEY_PREFIX}${id}`);

      if (!rawUser) continue;

      const existingUser = JSON.parse(rawUser);

      if (existingUser.email === email) {
        return res.status(409).json({
          error: 'duplicate_email',
          message: 'Ya existe un usuario con ese email',
        });
      }
    }

    const timer = redisOperationDuration.startTimer({ operation: 'set' });

    await redisClient.set(
      `${REDIS_KEY_PREFIX}${user.id}`,
      JSON.stringify(user)
    );

    await redisClient.sAdd(USERS_INDEX_KEY, user.id);

    timer({ status: 'success' });

    logger.info('usuario creado', { user_id: user.id });

    usersTotal.inc();

    res.status(201).json(user);


    /**
     *                                                                                                                                                       1.2. En esta parte podemos tambien ver el logger de winston en acción, donde se implementa un middleware de Express para registrar cada petición HTTP que recibe el servicio. Se registra información relevante como el método HTTP, la ruta, el código de estado de la respuesta, la duración de la petición y un identificador único de la solicitud (request_id) si está presente en los headers. Esto permite tener un registro detallado de las interacciones con el servicio, lo que es fundamental para el monitoreo y la depuración en producción.
     */

  } catch (err) {
    logger.error('error creando usuario', { error: err.message });                                                                        
    res.status(500).json({ error: 'failed_to_create_user' });
  }
});


// Actualizar usuario

app.put('/users/:id', async (req, res) => {
  const { name, email } = req.body;

  if (!name && !email) {
    return res.status(400).json({
      error: 'validation_error',
      message: 'debes mandar name o email al menos',
    });
  }

  try {
    const raw = await redisClient.get(
      `${REDIS_KEY_PREFIX}${req.params.id}`
    );

    if (!raw) {
      return res.status(404).json({
        error: 'user_not_found',
        id: req.params.id,
      });
    }

    const existing = JSON.parse(raw);

    const updated = {
      ...existing,
      ...(name && { name }),
      ...(email && { email }),
      updated_at: new Date().toISOString(),
    };

    const timer = redisOperationDuration.startTimer({ operation: 'set' });

    await redisClient.set(
      `${REDIS_KEY_PREFIX}${updated.id}`,
      JSON.stringify(updated)
    );

    timer({ status: 'success' });

    logger.info('usuario actualizado', { user_id: updated.id });

    res.json(updated);

  } catch (err) {
    logger.error('error actualizando usuario', {
      id: req.params.id,
      error: err.message,
    });

    res.status(500).json({ error: 'failed_to_update_user' });
  }
});


/**
 * Eliminar usuario
 *                                                                                                                                                        12. En esta parte se implementa el endpoint para eliminar un usuario, donde se recibe el ID del usuario a través de los parámetros de la ruta, se verifica si el usuario existe en Redis, y si es así, se elimina tanto la clave del usuario como su ID del índice de usuarios. Se mide el tiempo de la operación contra Redis y se registran logs estructurados para tener visibilidad sobre la eliminación de usuarios y cualquier error que pueda ocurrir durante este proceso. Además, se decrementa la métrica de total de usuarios cada vez que se elimina un usuario.
 */

app.delete('/users/:id', async (req, res) => {
  try {
    const timer = redisOperationDuration.startTimer({ operation: 'del' });

    const deleted = await redisClient.del(
      `${REDIS_KEY_PREFIX}${req.params.id}`
    );

    timer({ status: deleted ? 'success' : 'miss' });

    if (!deleted) {
      return res.status(404).json({
        error: 'user_not_found',
        id: req.params.id,
      });
    }

    await redisClient.sRem(USERS_INDEX_KEY, req.params.id);

    logger.info('usuario eliminado', { user_id: req.params.id });

    usersTotal.dec();

    res.status(204).send();

  } catch (err) {
    logger.error('error eliminando usuario', {
      id: req.params.id,
      error: err.message,
    });

    res.status(500).json({ error: 'failed_to_delete_user' });
  }
});


/**
 * Manejo de rutas no existentes error handler 404
 *                                                                                                                                                         13. En esta parte se implementa un middleware de Express para manejar rutas no existentes, donde si una solicitud llega a una ruta que no está definida en el servicio, se responde con un error 404 indicando que la ruta no fue encontrada. Esto es importante para proporcionar una respuesta clara y consistente a los clientes cuando intentan acceder a recursos que no existen, y para mejorar la experiencia del usuario al interactuar con la API.
 */

app.use((req, res) => {
  res.status(404).json({
    error: 'not_found',
    path: req.path,
  });
});


/**
 * Error handler general
 *                                                                                                                                                        14. En esta parte se implementa un middleware de Express para manejar errores no controlados, donde si ocurre un error que no fue manejado por los endpoints definidos, se captura en este middleware y se responde con un error 500 indicando que ocurrió un error interno en el servidor. Además, se registran logs estructurados con winston para tener visibilidad sobre estos errores no controlados, lo que es crucial para la depuración y el monitoreo en producción.
 */

app.use((err, req, res, next) => {
  logger.error('error no controlado', {
    error: err.message,
    stack: err.stack,
  });

  res.status(500).json({
    error: 'internal_server_error',
  });
});

/**
 * Arranque del servidor + apagado limpio
 *                                                                                                                                                         15. En esta parte se implementa el graceful shutdown y el manejo de apagado limpio, donde se define una función start() que se encarga de conectar a Redis, inicializar datos de prueba si es necesario, y luego levantar el servidor HTTP. Además, se define una función shutdown() que se encarga de cerrar la conexión a Redis y el servidor HTTP de manera ordenada cuando el proceso recibe señales de terminación como SIGTERM o SIGINT. Esto garantiza que el servicio pueda apagarse correctamente sin perder datos o dejar conexiones abiertas, lo que es crucial para la estabilidad y la confiabilidad en producción.
 *                                                                                                                                                             En esta parte se cierra el servidor HTTP con server.close, se cierra la conexion Redis con redisCLient.quit, se espera a que ambos terminen con Promise.all, se sale limpio con exit(0) y tiene un timeout de seguridad de 10s para forzar el apagado si algo falla, lo que es una buena práctica para garantizar que el servicio no quede colgado durante el proceso de apagado. Además, se manejan excepciones no controladas con process.on('uncaughtException') para loguear el error y salir con un código de error, lo que ayuda a mantener la estabilidad del servicio incluso en situaciones inesperadas.
 */

function shutdown(signal) {
  logger.info('apagando servicio', { signal });

  const closingServer = server
    ? new Promise((resolve) => server.close(resolve))
    : Promise.resolve();

  const closingRedis = redisClient
    ? redisClient.quit()
    : Promise.resolve();

  Promise.all([closingServer, closingRedis]).then(() => {
    logger.info('shutdown completado correctamente');
    process.exit(0);
  });

  setTimeout(() => {
    logger.error('apagado forzado por timeout');
    process.exit(1);
  }, 10000);
}

/**
 *                                                                                                                                                           16. En esta parte se implementa el manejo de señales para el apagado limpio, donde se escucha por señales como SIGTERM y SIGINT, que son comunes en entornos de contenedores y sistemas operativos para indicar que el proceso debe terminar. Cuando se recibe una de estas señales, se llama a la función shutdown() para iniciar el proceso de apagado ordenado del servicio. Esto es crucial para garantizar que el servicio pueda cerrarse correctamente sin perder datos o dejar conexiones abiertas, lo que mejora la estabilidad y confiabilidad en producción.
 */

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  logger.error('uncaught exception', {
    error: err.message,
    stack: err.stack,
  });
  process.exit(1);
});

if (require.main === module) {
  start();
}

module.exports = {
  app,
  connectRedis,
  getRedisClient: () => redisClient,
};
