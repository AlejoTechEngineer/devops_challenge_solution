'use strict';

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const express = require('express');
const http = require('http');
const axios = require('axios');
const client = require('prom-client');
const { createLogger, format, transports } = require('winston');

/**
 * Logger básico con winston.
 * Lo dejo en formato JSON porque es más fácil de parsear cuando corre en contenedores o en la nube.
 *                                                                                                                1. Aca se implementa el structured JSON logging (level: config + winston automáticomente agrega timestamp y stack trace en caso de errores). 
 *                                                                                                                   Se cumple con LOGS en fomrato JSON, Timestamp automatico, level automatico y messsage automatico. Esto es fundamental para poder analizar los logs de forma eficiente, especialmente cuando el servicio corre en contenedores o en la nube, donde los logs suelen ser consumidos por sistemas de monitoreo centralizados. Al tener un formato estructurado, es mucho más fácil filtrar, buscar y correlacionar eventos en los logs, lo que mejora significativamente la capacidad de debugging y monitoreo del servicio.
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
 * Aca se definen las métricas que vamos a exponer para Prometheus, incluyendo:                                   6.1. Aca se implementa la configuración de métricas con Prometheus, definiendo métricas clave para monitorear el rendimiento y la salud del servicio. Esto incluye métricas para medir la duración de las peticiones HTTP que recibe el gateway, el total de requests que llegan al gateway, y el tiempo de llamadas hacia otros servicios (upstream). Estas métricas son fundamentales para tener visibilidad sobre el comportamiento del servicio en producción y para detectar posibles problemas de rendimiento o disponibilidad.
 *                                                                                                                     Se crea un registro de metricas, se activan las metricas por defecto de Node.js lo que cumple con prom-client library to expose default and custom metrics
 *                                                                                                                     Se definen las metricas custom con cada uno de los const y eso cumple con expose default and custom metrics
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

/**
 * Middleware global: genera o reutiliza un Request ID
 * Esto permite trazabilidad end-to-end en microservicios
 *                                                                                                              2.1 Aca se hace la implementacion del request context con un logger contextual por request. Esto es clave para poder seguir la trazabilidad de una petición a través de los logs, especialmente cuando el servicio interactúa con otros servicios (como en este caso con user-service). Al generar o reutilizar un Request ID y agregarlo al logger, podemos correlacionar fácilmente los logs relacionados con la misma petición, incluso si involucran múltiples servicios. Esto es fundamental para debugging y monitoreo en entornos de microservicios.
 */
app.use((req, res, next) => {
  req.requestId = req.headers['x-request-id'] || generateRequestId();                                       

  // devolvemos el ID al cliente también
  res.setHeader('X-Request-ID', req.requestId);

  next();
});

/**
 * Middleware: logger contextual por request
 * Todos los logs desde aquí incluyen request_id, method y path
 *                                                                                                              2.2 Aca se implementa el logger contextual por request, que es una extensión del punto anterior. Al crear un logger hijo (child) para cada request, podemos incluir automáticamente información contextual relevante (como el request_id, método HTTP y ruta) en todos los logs generados durante el procesamiento de esa petición. Esto mejora significativamente la capacidad de análisis y debugging, ya que cada log relacionado con una petición específica tendrá esta información clave sin necesidad de agregarla manualmente en cada llamada al logger.   
 */
app.use((req, res, next) => {
  req.logger = logger.child({
    request_id: req.requestId,
    method: req.method,
    path: req.path,
  });

  next();
});

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
 * Middleware: logging estructurado completo
 *                                                                                                              2.3 Aca se implementa el logging estructurado completo, que es una extensión de los puntos anteriores. Al escuchar el evento 'finish' de la respuesta, podemos registrar un log detallado cuando la petición se completa, incluyendo información como el status code, duración de la petición, user agent y dirección IP del cliente. Esto proporciona una visión completa de cada petición en los logs, lo que es invaluable para monitoreo, análisis y debugging. Además, al usar un formato JSON estructurado, estos logs son fácilmente parseables por herramientas de análisis de logs o sistemas de monitoreo centralizados.
 *                                                                                                              3. y 4. En esta parte de igual manera se implementa el Add request logging middleware que trae method, path, status code, response time in ms
 *                                                                                                                 Captura el tiempo inicial de la request, escucha el evento finish de la respuesta, registra method, path, status code y duración en milisegundos y utiliza un logger contextual (logger.child) para incluir automáticamente metadata del request
 */

app.use((req, res, next) => {
  const start = Date.now();
                                                                                                                
  res.on('finish', () => {
    req.logger.info('request completed', {
      status_code: res.statusCode,
      duration_ms: Date.now() - start,
      user_agent: req.get('user-agent'),
      remote_addr: req.ip,
    });
  });

  next();
});

/**
 * Health checks                                                                                                5. Aca se implementan todos los health checks necesarios para Kubernetes, incluyendo liveness y readiness. El liveness check es simple y solo verifica que el proceso esté vivo, mientras que el readiness check es más completo e incluye una verificación de que el user-service esté accesible. Esto es fundamental para asegurar que Kubernetes pueda gestionar correctamente el ciclo de vida del contenedor, reiniciándolo si se detecta que no está vivo o evitando enviar tráfico a un contenedor que no está listo para manejarlo.
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
 *                                                                                                                6.2 Aca se establece el content-type correcto, devuelve todas las metricas registradas; default metrics, httpRequestDuration, httpRequestTotal y upstreamRequestDuration. Esto es esencial para que Prometheus pueda scrapear las métricas correctamente y tener visibilidad sobre el rendimiento y la salud del servicio a través de las métricas expuestas. Al incluir tanto las métricas por defecto como las personalizadas, se obtiene una visión completa del comportamiento del servicio en producción.
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
 *                                                                                                                7. Aca se implementa el proxy hacia User-Service, que es el servicio principal al que este API Gateway va a enrutar. Este endpoint captura todas las rutas bajo /api/users y las redirige al user-service, propagando el método HTTP, la ruta, el cuerpo de la petición y los headers relevantes (como el request ID para trazabilidad). Además, se mide el tiempo que tarda la llamada al user-service usando la métrica upstreamRequestDuration, lo que permite monitorear el rendimiento de las llamadas a este servicio externo. En caso de error, se maneja adecuadamente registrando un log con el error y devolviendo una respuesta con un mensaje claro para el cliente.
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

        // Propago el mismo request ID para trazabilidad end-to-end, o genero uno nuevo si no viene
        'X-Request-ID': req.requestId,
        'X-Forwarded-For': req.ip,
      },
      timeout: 10000,
    });
    timer({ status_code: response.status });
    res.status(response.status).json(response.data);
  } catch (err) {
    const statusCode = err.response?.status || 502;
    timer({ status_code: statusCode });
    req.logger.error('error llamando a user-service', {
      upstream_service: 'user-service',
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
 *                                                                                                                8. Aca se implementa un manejo básico de rutas no encontradas (404), que devuelve un mensaje de error claro en formato JSON. Esto es importante para mejorar la experiencia del cliente al interactuar con el API, ya que proporciona una respuesta consistente y fácil de entender cuando se accede a rutas que no existen en el servicio. Además, al incluir el path solicitado en la respuesta, se facilita el debugging tanto para los desarrolladores como para los clientes que consumen la API.
 */

app.use((req, res) => {
  res.status(404).json({ error: 'not_found', path: req.path });
});

/**
 * Global error handler con contexto (Aunque no use next, debe estar ahí para que Express lo registre como error handler.)
 *                                                                                                                9. Aca se implementa un manejador global de errores, que captura cualquier error no manejado que ocurra durante el procesamiento de las peticiones. Este middleware registra un log de error con el mensaje y stack trace del error, y devuelve una respuesta JSON con un mensaje genérico de error interno. Esto es fundamental para asegurar que el servicio pueda manejar situaciones inesperadas de manera controlada, proporcionando información útil en los logs para debugging sin exponer detalles sensibles al cliente.
 */
app.use((err, req, res, next) => {        
  req.logger?.error('unhandled error', {
    error: err.message,
    stack: err.stack,
  });

  res.status(500).json({
    error: 'internal_server_error',
    request_id: req.requestId,
  });
});

/**
 * Arranque del servidor + apagado controlado
 *                                                                                                                10. Aca en function shutdown se implementa graceful shutdown, que es una práctica esencial para asegurar que el servicio pueda cerrarse de manera controlada cuando recibe señales de terminación (como SIGTERM o SIGINT). Al cerrar el servidor de forma ordenada, se permite que las conexiones existentes se completen antes de que el proceso se termine, lo que mejora la experiencia del usuario y reduce la probabilidad de errores o pérdida de datos. Además, al incluir un timeout para forzar el cierre si algo se queda colgado, se asegura que el proceso no quede en un estado indeterminado por mucho tiempo.
 *                                                                                                                    Adicionalmente en server.close se frenan la aceptacion a nuevas conexiones HTTP, con SIGTERM o SIGINT, se espera a que las conexiones actuales terminen, se loguea el apagado y se sale del proceso. Si algo se queda colgado, se fuerza el apagado después de 10 segundos para evitar que el proceso quede en un estado indeterminado.
 *                                                                                                                    Ahora con process.exit(0) sale correctamente, y con process.exit(1) sale con error, lo que es útil para detectar en Kubernetes que el contenedor no se cerró correctamente.
 *                                                                                                                    Ahora si algo se cuelga con setTimeout se fuerza el apagado después de 10 segundos, lo que es útil para evitar que el proceso quede en un estado (zombie) indeterminado por mucho tiempo.
 *                                                                                                                    De esta manera se cumple con Graceful shutdown, stop accepting new connections, finish processing in-flight requests, close connections to downstream services (Axios no mantiene conexiones persistentes manualmente, así que no hay mucho que cerrar, aplica mas para pools y kafka) y exit cleanly.
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

/**
* Señales del sistema
*                                                                                                                 11. Aca se implementa el manejo de señales del sistema para permitir un apagado controlado del servicio. Al escuchar las señales SIGTERM y SIGINT, se llama a la función shutdown, que maneja el proceso de cierre ordenado del servidor. Además, se manejan los eventos uncaughtException y unhandledRejection para registrar cualquier error no manejado que ocurra en el proceso, lo que es crucial para mantener la estabilidad del servicio y facilitar el debugging en caso de errores inesperados.
*/
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
