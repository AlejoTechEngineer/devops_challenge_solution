# Estrategia de Monitorización y Observabilidad

## Descripción general

Este documento describe la estrategia de observabilidad del proyecto, cubriendo los tres pilares fundamentales:

- Métricas
- Logs
- Trazas

La implementación sigue buenas prácticas estándar de la industria y está diseñada para ser extensible a un entorno productivo real.

---

## 1. Métricas — Prometheus + Grafana

### Recolección de métricas

Ambos servicios exponen un endpoint `/metrics` mediante `prom-client`. Prometheus realiza scraping cada 15 segundos usando anotaciones en los pods:

```yaml
annotations:
  prometheus.io/scrape: "true"
  prometheus.io/port: "3001"
  prometheus.io/path: "/metrics"
```

### Métricas por defecto de Node.js

El collector por defecto de `prom-client` expone automáticamente las siguientes métricas:

| Métrica | Descripción |
|---|---|
| `process_cpu_seconds_total` | Uso de CPU |
| `process_resident_memory_bytes` | Uso de memoria |
| `nodejs_eventloop_lag_seconds` | Lag del event loop (clave para detectar bloqueos) |
| `nodejs_heap_size_used_bytes` | Uso de heap |

### Métricas personalizadas de la aplicación

| Métrica | Tipo | Labels | Descripción |
|---|---|---|---|
| `http_requests_total` | Counter | `method`, `route`, `status_code` | Total de requests HTTP |
| `http_request_duration_seconds` | Histogram | `method`, `route`, `status_code` | Latencia de requests HTTP |
| `upstream_request_duration_seconds` | Histogram | `service`, `method`, `status_code` | Latencia gateway → servicio |
| `redis_operation_duration_seconds` | Histogram | `operation`, `status` | Latencia de operaciones Redis |
| `users_total` | Gauge | — | Total de usuarios registrados |

Estas métricas permiten aplicar el modelo **RED** (Rate, Errors, Duration) sobre los servicios.

### Dashboards sugeridos en Grafana

**Service Overview**
- Requests por segundo
- Tasa de errores (5xx)
- Latencias p50 / p95 / p99

**Infraestructura**
- CPU y memoria por pod
- Reinicios de pods
- Eventos de HPA

**Métricas de negocio**
- Usuarios creados por hora
- Usuarios eliminados
- Total de usuarios activos

---

## 2. Logging — JSON estructurado con Winston

Los servicios utilizan `winston` con salida en formato JSON estructurado.

### Ejemplo de log

```json
{
  "timestamp": "2024-01-15T10:30:00.000Z",
  "level": "info",
  "service": "api-gateway",
  "version": "1.0.0",
  "message": "request completed",
  "method": "GET",
  "path": "/api/users",
  "status": 200,
  "duration_ms": 45,
  "request_id": "abc123"
}
```

### Razones para usar logs en JSON

- Son fáciles de parsear sin necesidad de expresiones regulares.
- Permiten filtrado eficiente por cualquier campo.
- Facilitan la correlación de requests mediante `request_id`.
- Con el header `X-Request-ID` es posible rastrear una request desde el gateway hasta el `user-service`.

### Stack de agregación de logs

**Entorno AWS EKS:**

```
Fluent Bit (DaemonSet) → CloudWatch Logs → CloudWatch Log Insights
```

**Alternativa open-source:**

```
Fluent Bit → Loki → Grafana
```

---

## 3. Trazas distribuidas — OpenTelemetry

Instrumentación disponible mediante `@opentelemetry/sdk-node` para trazabilidad completa de:

- Flujo `api-gateway` → `user-service`
- Llamadas HTTP entre servicios
- Operaciones Redis
- Propagación de errores

### Backends de exportación compatibles

- AWS X-Ray
- Jaeger

### Atributos por span

| Atributo | Descripción |
|---|---|
| Método HTTP | Verbo de la request |
| Path | Ruta invocada |
| Status | Código de respuesta |
| Latencia | Duración del span |
| Errores | Detalle del error si aplica |

---

## 4. Reglas de alertas

### 4.1 Alta tasa de errores (5xx)

```yaml
alert: HighErrorRate
expr: |
  rate(http_requests_total{status_code=~"5.."}[5m])
  /
  rate(http_requests_total[5m]) > 0.05
for: 2m
```

Si más del 5% de las requests fallan durante 2 minutos consecutivos, se considera un incidente activo.

### 4.2 Latencia P99 alta

```yaml
alert: HighP99Latency
expr: |
  histogram_quantile(0.99,
    rate(http_request_duration_seconds_bucket[5m])
  ) > 2.0
for: 5m
```

Se utiliza el percentil 99 en lugar del promedio para evitar que la cola de latencia quede oculta. Si el 1% de los usuarios experimenta más de 2 segundos de espera, se considera una degradación del servicio.

### 4.3 Pods en reinicio continuo

```yaml
alert: PodRestartLoop
expr: |
  increase(kube_pod_container_status_restarts_total[15m]) > 3
for: 5m
```

Más de 3 reinicios en 15 minutos suele indicar alguna de las siguientes causas:
- OOMKill por límites de memoria insuficientes
- Crash loop por error en la aplicación
- Error de configuración o variables de entorno incorrectas

### 4.4 Redis no disponible

```yaml
alert: RedisDown
expr: up{job="redis"} == 0
for: 1m
```

Si Redis cae, el `user-service` comenzará a devolver respuestas `503`. Esta alerta es de prioridad crítica.

### 4.5 HPA en máximo de réplicas

```yaml
alert: HPAMaxReplicasReached
expr: |
  kube_horizontalpodautoscaler_status_current_replicas
  ==
  kube_horizontalpodautoscaler_spec_max_replicas
for: 10m
```

Si el HPA permanece en el máximo durante un periodo prolongado, puede indicar:
- Pico de tráfico sostenido
- Recursos mal dimensionados
- Cuello de botella en un servicio dependiente

---

## 5. Gestión de secretos

### Problema

Los Kubernetes Secrets están codificados en base64, no cifrados. Si etcd o el repositorio se ven comprometidos, las credenciales quedan expuestas.

### Solución recomendada — External Secrets Operator + AWS Secrets Manager

Flujo de sincronización:

```
AWS Secrets Manager
        |
External Secrets Operator
        |
Kubernetes Secret
        |
       Pod
```

**Pasos de implementación:**

1. Almacenar los secretos en AWS Secrets Manager.
2. Crear un recurso `ExternalSecret` en Kubernetes.
3. El operador sincroniza el valor real de forma automática.
4. Los secretos rotan sin necesidad de modificar el código ni los manifiestos.

### Prácticas que deben evitarse

- Hardcodear secretos en el código fuente o en Dockerfiles.
- Incluir archivos `.env` reales en el repositorio.
- Usar la etiqueta `latest` en imágenes de producción.
- Almacenar secretos en ConfigMaps.

---

## 6. Optimización de costos

Consideraciones aplicables si el sistema pasa a un entorno productivo:

- Usar **KEDA** para escalar a cero en horarios de baja carga.
- Ajustar correctamente los valores de `requests` y `limits` por pod.
- Utilizar instancias **Spot** para cargas de trabajo no críticas.
- Revisar las métricas del HPA de forma periódica.
- Implementar herramientas de cost attribution por servicio.

---

## Conclusión

La estrategia de observabilidad cubre los aspectos esenciales de un sistema en producción:

- Métricas con visibilidad sobre el modelo RED.
- Logs estructurados con correlación de requests.
- Trazas distribuidas mediante OpenTelemetry.
- Alertas enfocadas en síntomas de problemas reales.
- Gestión segura de secretos con rotación automática.

Es una base sólida y extensible, lista para crecer en complejidad según las necesidades del entorno.