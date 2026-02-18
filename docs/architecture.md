# Architecture Documentation

## System Architecture

```
                        ┌─────────────────────────────────────────────┐
                        │           Kubernetes Cluster                │
                        │           (docker-desktop / EKS)            │
                        │                                             │
Internet ──────────▶   │   ┌─────────────────┐                      │
   :3000                │   │   api-gateway   │  ClusterIP :3000     │
                        │   │   (1-10 pods)   │                      │
                        │   └────────┬────────┘                      │
                        │            │ HTTP → :3001                  │
                        │   ┌────────▼────────┐                      │
                        │   │  user-service   │  ClusterIP :3001     │
                        │   │   (1-8 pods)    │                      │
                        │   └────────┬────────┘                      │
                        │            │ Redis → :6379                 │
                        │   ┌────────▼────────┐                      │
                        │   │     redis       │  ClusterIP :6379     │
                        │   │   (1 replica)   │                      │
                        │   └─────────────────┘                      │
                        │                                             │
                        │   ┌─────────────────┐                      │
                        │   │   Prometheus    │◀── scrape /metrics   │
                        │   └─────────────────┘    :3000, :3001      │
                        └─────────────────────────────────────────────┘
```

**Flujo de tráfico:**
1. Cliente hace `GET /api/users` al api-gateway en el puerto 3000
2. El api-gateway enruta la llamada a `http://user-service:3001/users` vía axios
3. El user-service ejecuta la lógica CRUD y consulta Redis en `redis:6379`
4. Redis responde, el user-service devuelve JSON al gateway
5. El gateway responde al cliente con el mismo status code y body

**Componentes desplegados:**
- `api-gateway` — Proxy HTTP con logging, métricas y health checks
- `user-service` — CRUD de usuarios sobre Redis con métricas y structured logs
- `redis` — Almacenamiento en memoria con autenticación obligatoria y AOF
- NetworkPolicies — Zero-trust: default deny-all + reglas explícitas
- HPA — Autoescalado por CPU (70%) y memoria (80%)
- PodDisruptionBudgets — Garantía de disponibilidad en mantenimientos

---

## Your Decisions

### Docker Strategy

**Base image choice:**

Elegí `node:20-alpine` para ambos servicios. Alpine Linux reduce el tamaño final a ~150MB frente a los ~900MB de la imagen completa de Node.js. Menos superficie de ataque, menos CVEs potenciales y builds más rápidos en CI/CD. Alternativa considerada: `node:20-slim`, que tiene más herramientas pero pesa considerablemente más.

**Multi-stage build approach:**

Implementé 4 stages en cada Dockerfile:

- **Stage `deps`**: Instala todas las dependencias incluyendo devDependencies. También instala `dumb-init` para el manejo correcto de señales del sistema operativo.
- **Stage `test`**: Copia el código y ejecuta `npm test`. Si los tests fallan, la imagen no se construye. Esto es clave: detectamos regresiones antes de que la imagen llegue a cualquier entorno.
- **Stage `production-deps`**: Reinstala únicamente las dependencias de producción (`--omit=dev`), sin Jest, ESLint ni otras herramientas de desarrollo.
- **Stage `final`**: Copia solo `node_modules/` desde `production-deps` y el código fuente. El resultado es una imagen mínima sin herramientas de desarrollo.

```dockerfile
FROM node:20-alpine AS deps
RUN apk add --no-cache dumb-init
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts && npm cache clean --force

FROM deps AS test
COPY src/ ./src/
RUN npm test

FROM node:20-alpine AS production-deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:20-alpine AS final
RUN apk add --no-cache dumb-init \
    && addgroup -S appgroup -g 1001 \
    && adduser -S appuser -u 1001 -G appgroup
COPY --from=production-deps --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --chown=appuser:appgroup src/ ./src/
USER appuser
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/index.js"]
```

**Security considerations:**

- **Usuario no-root**: Se crea `appuser` con `uid: 1001` y `gid: 1001`. El contenedor nunca corre como root.
- **dumb-init como PID 1**: Node.js no maneja SIGTERM correctamente si es PID 1. `dumb-init` actúa como proceso init mínimo y propaga las señales correctamente, lo que garantiza que Kubernetes pueda apagar el pod limpiamente.
- **HEALTHCHECK en Dockerfile**: Cada imagen define su propio healthcheck con `wget` al endpoint `/health/live`, independiente de las probes de Kubernetes.
- **OCI Labels**: Cada imagen incluye labels estándar con título, descripción, versión y source del repositorio para trazabilidad.
- **Capabilities dropped en Kubernetes**: A nivel de pod se aplica `drop: [ALL]`, `allowPrivilegeEscalation: false` y `readOnlyRootFilesystem: true`.

**Layer optimization:**

- Se copian `package.json` y `package-lock.json` antes que el código fuente. Docker cachea la capa de `npm ci` y solo la regenera si cambian las dependencias, no con cada cambio de código.
- Se ejecuta `npm cache clean --force` después de instalar para no inflar la imagen con cache de npm.
- El `.dockerignore` excluye `node_modules/`, `coverage/`, `*.test.js`, `docs/`, archivos de configuración del editor y pipelines de CI. Esto reduce el build context enviado al daemon de Docker.

---

### Kubernetes Design

**Namespace strategy:**

- **Dev**: `devops-challenge-dev` — aislamiento lógico, recursos más bajos, imágenes locales con `imagePullPolicy: Never`
- **Prod**: `devops-challenge-prod` — resource quotas estrictos, imágenes desde ghcr.io con SHA inmutable, secrets desde AWS Secrets Manager

Separar por namespace permite aplicar NetworkPolicies distintas, quotas independientes y flujos de deploy diferenciados sin riesgo de impactar producción.

**Resource allocation rationale:**

| Servicio | CPU Request | CPU Limit | RAM Request | RAM Limit | Razón |
|----------|-------------|-----------|-------------|-----------|-------|
| api-gateway | 100m | 500m | 128Mi | 256Mi | Proxy liviano. Limits previenen que un spike consuma el nodo. |
| user-service | 100m | 500m | 128Mi | 256Mi | CRUD simple. Si el tráfico sube, el HPA escala pods. |
| redis | 100m | 250m | 128Mi | 256Mi | Redis es eficiente. 256Mi soporta miles de claves. |

En dev los requests bajan a `50m` CPU y `64Mi` RAM para no consumir recursos del entorno local.

**Health check configuration:**

Hay tres probes distintas, cada una con un propósito diferente:

**Liveness** (`/health/live`): Verifica que el proceso Node.js esté vivo y respondiendo. Si falla 3 veces seguidas, Kubernetes reinicia el contenedor.
```yaml
livenessProbe:
  httpGet:
    path: /health/live
    port: 3000
  initialDelaySeconds: 15
  periodSeconds: 20
  failureThreshold: 3
```

**Readiness** (`/health/ready`): Verifica si el pod puede recibir tráfico. El api-gateway comprueba que user-service esté arriba; el user-service comprueba que Redis responda al `PING`. Si falla, el pod se retira del Service sin reiniciarse — esto es clave: reiniciar no soluciona que una dependencia externa esté caída.
```yaml
readinessProbe:
  httpGet:
    path: /health/ready
    port: 3000
  initialDelaySeconds: 10
  periodSeconds: 10
  failureThreshold: 3
```

**Startup** (`/health/live`): Da margen al contenedor en el arranque inicial. Con `failureThreshold: 12` y `periodSeconds: 5`, el pod tiene hasta 60 segundos para arrancar antes de que liveness lo mate.
```yaml
startupProbe:
  httpGet:
    path: /health/live
    port: 3001
  initialDelaySeconds: 5
  periodSeconds: 5
  failureThreshold: 12
```

Se añadió además un **initContainer** en user-service que espera con `nc -z redis 6379` antes de arrancar el contenedor principal, eliminando el restart inicial que ocurría cuando user-service arrancaba antes que Redis estuviera ready.

**Scaling strategy:**

HPA con métricas duales (CPU y memoria) en ambos servicios:

```yaml
metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 80

behavior:
  scaleUp:
    stabilizationWindowSeconds: 60    # Espera 60s antes de escalar
    policies:
      - type: Pods
        value: 2
        periodSeconds: 60             # Escala de 2 en 2
  scaleDown:
    stabilizationWindowSeconds: 300   # Espera 5 min antes de bajar
    policies:
      - type: Pods
        value: 1
        periodSeconds: 120            # Baja de 1 en 1
```

El scale-down es más lento para evitar thrashing. Es preferible mantener capacidad extra unos minutos que quedarse sin pods si el tráfico vuelve a subir.

Rangos configurados: api-gateway 2-10 pods, user-service 2-8 pods (prod). En dev: 1-2 pods para ambos.

**NetworkPolicies (Zero Trust):**

Default deny-all para todos los pods del namespace, con reglas explícitas mínimas:

- `api-gateway` → `user-service` en puerto 3001
- `user-service` → `redis` en puerto 6379
- `prometheus` (namespace `monitoring`) → todos los pods en `/metrics`
- DNS (CoreDNS) permitido en puerto 53 TCP/UDP para todos

**PodDisruptionBudgets:**

`minAvailable: 1` en api-gateway y user-service. Garantiza que durante un `kubectl drain` o rolling update siempre haya al menos un pod disponible.

---

### CI/CD Pipeline

**Pipeline stages:**

1. **Lint & Test** (paralelo para api-gateway y user-service): `npm run lint` + `npm test`. Si falla, aborta. Sube coverage como artifact.
2. **Build & Push**: Docker build multi-stage (los tests corren dentro del build). Tag con `sha-<7chars>` inmutable, nombre de branch y `latest` solo en main. Push a `ghcr.io`.
3. **Security Scan (Trivy)**: Escanea la imagen en busca de CVEs críticos/altos. Sube resultados SARIF al tab de Security de GitHub.
4. **Deploy DEV** (rama `develop`): Actualiza tag en kustomize overlay de dev → `kubectl apply -k` → `kubectl rollout status` → smoke test con `curl /health/ready`.
5. **Deploy PROD** (rama `main`, con approval gate): Fetch secrets desde AWS Secrets Manager → actualiza tags → apply → health check → auto-rollback si falla.
6. **Notificación Slack**: Resultado final (success/failure) con SHA, branch y link a la run.

**Deployment strategy:**

RollingUpdate con `maxSurge: 1` y `maxUnavailable: 0`. Kubernetes crea 1 pod nuevo, espera a que pase el readiness probe, y solo entonces termina el pod viejo. Zero-downtime garantizado en cada deploy.

**Rollback approach:**

- **Automático en CI/CD**: Si el health check post-deploy falla, el pipeline ejecuta `kubectl rollout undo deployment/<nombre> -n <namespace>` automáticamente.
- **Manual**: `kubectl rollout undo deployment/api-gateway -n devops-challenge-prod` en cualquier momento.
- **Ideal con GitOps**: Con ArgoCD, un `git revert` del commit problemático desencadena el rollback automáticamente sin intervención en el cluster.

**Secret management:**

En el pipeline de producción los secrets nunca se commitean. Se obtienen en runtime desde AWS Secrets Manager:
```yaml
- name: Fetch secrets
  run: |
    REDIS_PASS=$(aws secretsmanager get-secret-value \
      --secret-id devops-challenge/prod/redis-password \
      --query SecretString --output text)
    echo "redis-password=${REDIS_PASS}" > k8s/overlays/prod/secrets.env
```
Kustomize usa `secrets.env` para generar el Secret de Kubernetes. El archivo se crea en runtime y nunca toca el repositorio.

---

### Environment & Secrets Management

**How do you separate config from code?**

Principio 12-factor app: la configuración vive completamente fuera del código. El código solo lee `process.env.VARIABLE` y nunca tiene valores hardcodeados.

- **Local (npm start)**: archivo `.env` con dotenv (`require('dotenv').config()` solo si `NODE_ENV !== 'production'`)
- **Docker Compose**: variables en el bloque `environment` del `docker-compose.yml`
- **Kubernetes**: ConfigMaps para config no sensible, Secrets para credenciales

**How do you handle sensitive vs non-sensitive config?**

**ConfigMap** — config no sensible que puede vivir en Git:
```yaml
PORT_GATEWAY: "3000"
USER_SERVICE_URL: "http://user-service:3001"
REDIS_HOST: "redis"
REDIS_PORT: "6379"
LOG_LEVEL: "info"
NODE_ENV: "production"
REDIS_MAX_MEMORY: "128mb"
```

**Secret** — credenciales que nunca van a Git:
```yaml
REDIS_PASSWORD: <base64>
redis-password: <base64>
DATABASE_URL: <base64>
```

**How would you manage secrets in production?**

La solución ideal es **External Secrets Operator** + AWS Secrets Manager. El operador sincroniza automáticamente los secrets desde AWS hacia Kubernetes cada hora o cuando cambian, sin necesidad de intervención manual:

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: app-secrets
spec:
  secretStoreRef:
    name: aws-secrets-manager
    kind: SecretStore
  target:
    name: app-secrets
  data:
    - secretKey: redis-password
      remoteRef:
        key: devops-challenge/prod/redis-password
```

Alternativas consideradas: **Sealed Secrets** (Bitnami) para poder commitear secrets encriptados en GitOps, **Vault** (HashiCorp) para inyección directa en pods vía sidecar, **SOPS** para encriptar archivos YAML con KMS antes de commitear.

**How do you handle different environments (dev/staging/prod)?**

Kustomize overlays: la base contiene toda la configuración compartida; cada overlay sobreescribe solo lo que cambia.

```
k8s/
├── base/              # Configuración compartida (deployments, services, hpa, networkpolicies)
└── overlays/
    ├── dev/           # 1 replica, LOG_LEVEL: debug, imagePullPolicy: Never, imágenes locales
    └── prod/          # 3 replicas, LOG_LEVEL: warn, imágenes desde ghcr.io con SHA
```

En dev las imágenes se referencian como `devops-challenge/api-gateway:local` con `imagePullPolicy: Never` para usar las imágenes buildadas localmente sin necesidad de un registry externo. En prod se usa el SHA inmutable del commit: `ghcr.io/org/api-gateway:sha-abc1234`.

---

### Monitoring Strategy

**Metrics collected:**

Métricas por defecto de `prom-client` (activadas con `collectDefaultMetrics`):
- `process_cpu_seconds_total`
- `process_resident_memory_bytes`
- `nodejs_eventloop_lag_seconds`
- `nodejs_heap_size_used_bytes`

Métricas custom implementadas en ambos servicios:

| Métrica | Tipo | Labels | Servicio |
|---------|------|--------|----------|
| `http_requests_total` | Counter | method, route, status_code | Ambos |
| `http_request_duration_seconds` | Histogram | method, route, status_code | Ambos |
| `upstream_request_duration_seconds` | Histogram | service, method, status_code | api-gateway |
| `redis_operation_duration_seconds` | Histogram | operation, status | user-service |
| `users_total` | Gauge | — | user-service |

Los pods exponen las métricas en `/metrics` y tienen annotations de Prometheus para auto-discovery:
```yaml
annotations:
  prometheus.io/scrape: "true"
  prometheus.io/port: "3001"
  prometheus.io/path: "/metrics"
```

**Logging format:**

Structured JSON con Winston en ambos servicios. Cada log incluye timestamp, level, service, version, message y campos contextuales del request:

```json
{
  "timestamp": "2026-02-18T06:51:32.848Z",
  "level": "info",
  "service": "user-service",
  "version": "dev-local",
  "message": "user-service iniciado",
  "port": 3001,
  "env": "development",
  "redis_url": "redis://:***@redis:6379"
}
```

El api-gateway propaga un `X-Request-ID` generado en cada request hacia el user-service, permitiendo correlacionar logs end-to-end entre servicios. Los health checks de Kubernetes aparecen en los logs con `user_agent: "kube-probe/1.34"`, lo que confirma que las probes están funcionando.

**Alerting rules (proposed):**

**1. High Error Rate** — Tasa de errores 5xx > 5% en 5 minutos
```yaml
alert: HighErrorRate
expr: |
  rate(http_requests_total{status_code=~"5.."}[5m])
  / rate(http_requests_total[5m]) > 0.05
for: 2m
labels:
  severity: critical
```
Threshold 5%: balance entre ruido y sensibilidad. `for: 2m` evita alertas por spikes momentáneos.

**2. High P99 Latency** — Latencia P99 > 2 segundos
```yaml
alert: HighP99Latency
expr: |
  histogram_quantile(0.99,
    rate(http_request_duration_seconds_bucket[5m])
  ) > 2.0
for: 5m
labels:
  severity: warning
```
P99 en lugar de promedio para detectar tail latency que el average oculta.

**3. Pod Restart Loop** — Más de 3 reinicios en 15 minutos
```yaml
alert: PodRestartLoop
expr: increase(kube_pod_container_status_restarts_total[15m]) > 3
for: 5m
labels:
  severity: critical
```
Indica OOMKill, crash loop o error de configuración.

**4. Redis Down** — Redis no disponible
```yaml
alert: RedisDown
expr: up{job="redis"} == 0
for: 1m
labels:
  severity: critical
```
Crítico porque sin Redis el user-service devuelve 503 en todos los requests.

**5. HPA at Max Replicas** — HPA llegó al límite máximo de réplicas
```yaml
alert: HPAMaxReplicas
expr: |
  kube_horizontalpodautoscaler_status_current_replicas
  == kube_horizontalpodautoscaler_spec_max_replicas
for: 10m
labels:
  severity: warning
```
Warning (no critical) porque el servicio sigue funcionando, pero es señal de que hay que revisar la capacidad o el límite configurado.

---

## Trade-offs & Assumptions

**Trade-off 1: Redis como almacenamiento principal**
- **Decision:** Usar Redis directamente como base de datos, sin Postgres.
- **Rationale:** Para un CRUD simple de usuarios, Redis es más que suficiente. Sub-millisecond reads/writes, operación trivial, sin necesidad de joins, transacciones ni queries complejos.
- **Alternative considered:** PostgreSQL + Redis como cache. Más robusto para queries complejos pero mucho más overhead operacional para este caso de uso.

**Trade-off 2: maxUnavailable: 0 en Rolling Updates**
- **Decision:** Priorizar zero-downtime sobre eficiencia de recursos durante deploys.
- **Rationale:** Con `maxUnavailable: 0` y `maxSurge: 1`, siempre hay pods ready. El costo es 1 pod extra durante ~30 segundos por cada deploy.
- **Alternative considered:** `maxUnavailable: 1, maxSurge: 0` — ahorra recursos pero puede causar micro-downtime si el nuevo pod tarda en pasar readiness.

**Trade-off 3: Liveness y Readiness en endpoints separados**
- **Decision:** `/health/live` para liveness y `/health/ready` para readiness con lógicas distintas.
- **Rationale:** Si Redis cae, el user-service no necesita reiniciarse — reiniciar no arregla que Redis esté caído. Con endpoints separados, el pod se retira del Service (readiness falla) pero no se reinicia (liveness sigue OK). Esto reduce disrupciones innecesarias.
- **Alternative considered:** Un único endpoint `/health` que chequea todo. Más simple pero causa reinicios innecesarios ante fallas de dependencias externas.

**Trade-off 4: Tests dentro del Dockerfile**
- **Decision:** `npm test` corre en la stage `test` del build multi-stage.
- **Rationale:** Si los tests fallan, la imagen no se construye. Fail-fast: los bugs se detectan antes de llegar a Kubernetes, incluso en builds locales.
- **Alternative considered:** Correr tests solo en CI antes del build. Funciona pero permite construir una imagen localmente sin pasar por los tests.

---

## Security Considerations

- **Non-root containers**: Usuario `appuser` con `uid: 1001` en ambos servicios. Si el contenedor se compromete, el atacante no tiene privilegios de root.
- **readOnlyRootFilesystem: true**: El contenedor no puede escribir en su propio filesystem. Previene que malware persista después de un exploit.
- **capabilities drop ALL**: Se eliminan todas las capabilities de Linux a nivel de pod. Minimiza el daño potencial de un proceso comprometido.
- **allowPrivilegeEscalation: false**: Aunque hubiera un exploit, el proceso no puede escalar a root.
- **NetworkPolicies Zero Trust**: Default deny-all. Solo tráfico explícitamente permitido: api-gateway → user-service, user-service → redis, prometheus → /metrics. Limita el lateral movement.
- **Secrets fuera de ConfigMaps**: Credenciales en Kubernetes Secrets (base64), nunca en ConfigMaps ni en el repositorio. En producción, gestionados desde AWS Secrets Manager vía External Secrets Operator.
- **Image scanning con Trivy**: Cada build en CI escanea la imagen por CVEs críticos y altos. Resultados subidos como SARIF al tab de Security de GitHub.
- **dumb-init como PID 1**: Manejo correcto de señales del sistema. Garantiza que el proceso se cierre limpiamente cuando Kubernetes envía SIGTERM, sin dejar procesos zombie.

---

## What I Would Improve With More Time

1. **GitOps con ArgoCD**: Reemplazar `kubectl apply` en el pipeline por ArgoCD App-of-Apps. Declarativo, con drift detection automático y rollbacks via `git revert`.
2. **Redis High Availability**: Redis Sentinel para auto-failover o Redis Cluster para sharding. Actualmente Redis es un Single Point of Failure.
3. **Ingress Controller**: NGINX Ingress o AWS ALB con TLS termination, rate limiting y WAF. Actualmente el acceso es solo via port-forward.
4. **Integration tests en CI**: Levantar un cluster `kind` en GitHub Actions, hacer deploy completo y correr tests end-to-end antes de merge.
5. **Distributed tracing (OpenTelemetry)**: Trazas end-to-end de requests a través de todos los servicios con Jaeger o AWS X-Ray.
6. **PersistentVolumeClaim para Redis**: En producción, reemplazar `emptyDir` por un PVC para que los datos persistan ante reinicios del pod.
7. **KEDA para cost optimization**: Scale-to-zero en off-hours y escalado basado en eventos (queue depth, métricas custom).
8. **Chaos Engineering**: Chaos Mesh o Litmus para inyectar fallas controladas y validar la resiliencia ante pod kills, network delays y particiones.

---

## Time Spent

| Task | Time |
|------|------|
| Part 1: Docker | 1.5 horas |
| Part 2: Kubernetes | 2.5 horas |
| Part 3: CI/CD | 2 horas |
| Part 4: Monitoring | 1.5 horas |
| Part 5: Troubleshooting | 1 hora |
| Documentation | 1.5 horas |
| **Total** | **~10 horas** |

> La mayor parte del tiempo fue en Kubernetes (HPA, NetworkPolicies, Kustomize overlays, secrets management). El troubleshooting fue relativamente ágil una vez que se entiende el flujo de diagnóstico con `kubectl describe` y `kubectl get events`. La documentación tomó más de lo esperado porque el objetivo era explicar el *por qué* de cada decisión, no solo el *qué*.