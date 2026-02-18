# Monitoring Strategy

## Metrics

### Application Metrics

List the metrics collected from the applications:

| Metric Name | Type | Description |
|-------------|------|-------------|
| `http_requests_total` | Counter | Total de requests HTTP recibidos. Labels: `method`, `route`, `status_code`. Permite calcular la tasa de errores (5xx) y el throughput por ruta. |
| `http_request_duration_seconds` | Histogram | Latencia de cada request HTTP en segundos. Labels: `method`, `route`, `status_code`. Permite calcular p50, p95, p99. |
| `upstream_request_duration_seconds` | Histogram | Latencia de las llamadas del api-gateway hacia el user-service. Labels: `service`, `method`, `status_code`. Útil para separar latencia propia del gateway vs latencia del upstream. |
| `redis_operation_duration_seconds` | Histogram | Latencia de cada operación contra Redis (GET, SET, DEL, PING, SMEMBERS). Labels: `operation`, `status`. Ayuda a detectar degradación en Redis antes de que afecte a los usuarios. |
| `users_total` | Gauge | Cantidad total de usuarios activos en el sistema. Se incrementa en cada POST y decrementa en cada DELETE. Métrica de negocio. |

### Infrastructure Metrics

| Metric Name | Source | Description |
|-------------|--------|-------------|
| `process_cpu_seconds_total` | prom-client default | Uso de CPU del proceso Node.js en modo usuario y kernel. |
| `process_resident_memory_bytes` | prom-client default | Memoria RAM consumida por el proceso. |
| `nodejs_eventloop_lag_seconds` | prom-client default | Lag del event loop. Si sube, indica que el hilo principal está bloqueado. |
| `nodejs_heap_size_used_bytes` | prom-client default | Uso del heap de V8. Útil para detectar memory leaks. |
| `kube_pod_container_status_restarts_total` | kube-state-metrics | Número de reinicios por contenedor. Permite alertar sobre crash loops. |
| `kube_horizontalpodautoscaler_status_current_replicas` | kube-state-metrics | Réplicas actuales del HPA. Permite detectar cuando se alcanza el máximo de escalado. |

---

## Logging

### Log Format

Structured JSON con Winston en ambos servicios. Todos los logs incluyen `timestamp`, `level`, `service`, `version` y `message` como campos base. Los requests HTTP añaden campos adicionales de trazabilidad:

```json
{
  "timestamp": "2026-02-18T06:51:32.848Z",
  "level": "info",
  "service": "user-service",
  "version": "dev-local",
  "message": "request procesado",
  "method": "POST",
  "path": "/users",
  "status": 201,
  "duration_ms": 7,
  "request_id": "lq9x8-5f3a9"
}
```

El api-gateway genera un `X-Request-ID` por request y lo propaga al user-service vía header. Esto permite correlacionar todos los logs de una misma request end-to-end, incluso cuando atraviesa varios servicios.

Los health checks de Kubernetes aparecen en los logs con `user_agent: "kube-probe/1.34"`, lo que permite filtrarlos en producción si generan demasiado ruido.

### Log Aggregation Strategy

**En AWS EKS (producción):**

```
Fluent Bit (DaemonSet en cada nodo)
    │
    ▼
CloudWatch Logs (un log group por servicio)
    │
    ▼
CloudWatch Log Insights (queries ad-hoc)
    │
    ▼
CloudWatch Dashboards + Alarms
```

Fluent Bit corre como DaemonSet y recolecta stdout de todos los contenedores automáticamente. Al estar los logs en JSON, CloudWatch Log Insights puede queryarlos con sintaxis como:

```
fields @timestamp, service, level, message, duration_ms
| filter level = "error"
| sort @timestamp desc
```

**Alternativa open-source:**

```
Fluent Bit → Loki → Grafana
```

Elegí JSON estructurado porque elimina la necesidad de regex en el ingestion pipeline, reduce errores de parsing y hace los logs directamente queryables por cualquier campo.

---

## Alerting Rules

### Alert 1: Alta tasa de errores 5xx

```yaml
alert: HighErrorRate
expr: |
  rate(http_requests_total{status_code=~"5.."}[5m])
  /
  rate(http_requests_total[5m]) > 0.05
for: 2m
labels:
  severity: critical
annotations:
  summary: "Tasa de errores 5xx > 5% en {{ $labels.service }}"
  description: |
    El {{ $value | humanizePercentage }} de las requests están fallando.
    Threshold: 5%. Revisar logs del servicio y estado de dependencias.
```

**Razonamiento:** El threshold del 5% balancea sensibilidad y ruido. `for: 2m` evita alertas por spikes momentáneos. Se alerta por síntoma (errores que ven los usuarios) y no por causa interna.

---

### Alert 2: Latencia P99 alta

```yaml
alert: HighP99Latency
expr: |
  histogram_quantile(0.99,
    rate(http_request_duration_seconds_bucket[5m])
  ) > 2.0
for: 5m
labels:
  severity: warning
annotations:
  summary: "Latencia P99 > 2s en {{ $labels.service }}"
  description: |
    El 1% de los usuarios está experimentando > 2 segundos de espera.
    P99 actual: {{ $value | humanizeDuration }}.
    Revisar upstream_request_duration_seconds y redis_operation_duration_seconds.
```

**Razonamiento:** Se usa P99 en lugar del promedio porque el promedio oculta la tail latency. Si el promedio es 100ms pero el P99 es 3s, hay un problema real que el promedio no muestra.

---

### Alert 3: Redis no disponible

```yaml
alert: RedisDown
expr: up{job="redis"} == 0
for: 1m
labels:
  severity: critical
annotations:
  summary: "Redis no responde"
  description: |
    Redis lleva más de 1 minuto sin responder al scraping de Prometheus.
    El user-service está devolviendo 503 en todos los requests de readiness.
    Acción inmediata requerida.
```

**Razonamiento:** Crítico porque sin Redis el user-service no puede atender requests. `for: 1m` da tiempo para distinguir un restart legítimo de una caída real.

---

### Alert 4: Pod en crash loop

```yaml
alert: PodRestartLoop
expr: increase(kube_pod_container_status_restarts_total[15m]) > 3
for: 5m
labels:
  severity: critical
annotations:
  summary: "Pod {{ $labels.pod }} reiniciando frecuentemente"
  description: |
    {{ $value }} reinicios en los últimos 15 minutos.
    Causas posibles: OOMKill, error en la aplicación, config incorrecta.
    Ejecutar: kubectl describe pod {{ $labels.pod }} -n {{ $labels.namespace }}
```

---

### Alert 5: HPA en máximo de réplicas

```yaml
alert: HPAAtMaxReplicas
expr: |
  kube_horizontalpodautoscaler_status_current_replicas
  ==
  kube_horizontalpodautoscaler_spec_max_replicas
for: 10m
labels:
  severity: warning
annotations:
  summary: "HPA {{ $labels.horizontalpodautoscaler }} en máximo de réplicas"
  description: |
    El HPA lleva 10 minutos en el máximo configurado y no puede escalar más.
    Posibles causas: pico de tráfico sostenido, límite mal dimensionado,
    cuello de botella en un servicio dependiente (Redis).
    Considerar aumentar maxReplicas o revisar la carga.
```

**Razonamiento:** Warning y no critical porque el servicio sigue funcionando, solo está al límite. Es una señal de capacidad, no de incidente activo.

---

## Dashboards

Si se conecta Grafana a Prometheus, los paneles recomendados son:

1. **Request Rate (RPS)**: `rate(http_requests_total[1m])` agrupado por servicio. Muestra el throughput actual y permite detectar caídas abruptas de tráfico.

2. **Error Rate (%)**: `rate(http_requests_total{status_code=~"5.."}[5m]) / rate(http_requests_total[5m]) * 100`. Panel con threshold en rojo al cruzar el 5%.

3. **Latencia P50 / P95 / P99**: `histogram_quantile(0.50|0.95|0.99, rate(http_request_duration_seconds_bucket[5m]))`. Tres líneas en el mismo panel para visualizar la distribución de latencia.

4. **Redis operation duration**: `histogram_quantile(0.99, rate(redis_operation_duration_seconds_bucket[5m]))` por operación (GET, SET, DEL). Permite detectar degradación de Redis antes de que impacte a los usuarios.

5. **Pod replicas y HPA**: `kube_horizontalpodautoscaler_status_current_replicas` vs `spec_max_replicas`. Muestra cuánto margen de escalado queda disponible.

6. **Users total (métrica de negocio)**: `users_total`. Gauge simple que muestra la cantidad de usuarios en el sistema. Útil para correlacionar picos de carga con crecimiento de datos.

7. **CPU y memoria por pod**: `rate(process_cpu_seconds_total[1m])` y `process_resident_memory_bytes`. Permite detectar fugas de memoria o procesos que consumen más de lo esperado.

---

## Distributed Tracing (Bonus)

La trazabilidad básica está implementada mediante propagación de `X-Request-ID`. El api-gateway genera un ID único por request con `generateRequestId()` (timestamp en base36 + random) y lo propaga al user-service via header `X-Request-ID`. Todos los logs de ambos servicios incluyen este ID, permitiendo correlacionar el recorrido completo de una request en CloudWatch Log Insights o Grafana Loki.

Para trazas distribuidas completas, la implementación se haría con **OpenTelemetry**:

```
api-gateway ──(OTLP)──▶ OTel Collector ──▶ AWS X-Ray / Jaeger
     │
user-service ──(OTLP)──▶ OTel Collector
```

Cada span capturaría: método HTTP, ruta, status code, duración, `request_id` y propagación del `traceparent` header entre servicios. Esto permitiría ver en un solo trace el tiempo total de una request, desglosado por api-gateway, llamada al user-service y operación Redis.