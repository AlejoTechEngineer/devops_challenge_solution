# Architecture Documentation

## System Architecture

La arquitectura es directa y sencilla: un API Gateway recibe todo el tráfico externo y lo enruta hacia el User Service, que maneja la lógica de usuarios y usa Redis como almacenamiento. Todo corre en Kubernetes con monitoreo en Prometheus.

```
                        ┌─────────────────────────────────────┐
                        │         Kubernetes Cluster          │
                        │                                     │
Internet ───────────▶  │  ┌──────────────┐                  │
   :3000                │   │ api-gateway │────────────────┐  │
                        │   │ (2-15 pods) │                │  │
                        │   └─────────────┘                │  │
                        │         │                        ▼  │
                        │         │           ┌──────────────┐│
                        │         │           │ user-service ││
                        │         │           │  (2-12 pods) ││
                        │         │           └──────────────┘│
                        │         │                   │       │
                        │         │                   ▼       │
                        │         │           ┌──────────────┐│
                        │         │           │    Redis     ││
                        │         │           │  (1 replica) ││
                        │         │           └──────────────┘│
                        │         │                           │
                        │  ┌──────────────┐                   │
                        │  │  Prometheus  │──scrapes /metrics │
                        │  │   Grafana    │                   │
                        │  └──────────────┘                   │
                        └─────────────────────────────────────┘
```

**Flujo de tráfico:**
1. Usuario hace request a `http://api-gateway:3000/api/users`
2. API Gateway valida y enruta a `http://user-service:3001/users`
3. User Service ejecuta lógica de negocio y consulta Redis
4. Redis devuelve datos
5. User Service responde al Gateway
6. Gateway responde al usuario

---

## Your Decisions

### Docker Strategy

**Base image choice:**
- **Elegí**: `node:20-alpine`
- **Por qué**: Es la imagen oficial de Node.js en su versión más ligera. Alpine Linux reduce el tamaño de la imagen final a ~150MB vs ~900MB de la versión completa. Menos superficie de ataque, menos vulnerabilidades, y deployments más rápidos.
- **Alternativas consideradas**: `node:20-slim` (más grande pero con más herramientas), `distroless` (ultra-segura pero más compleja de debuggear).

**Multi-stage build approach:**
Implementé 4 stages para optimizar al máximo:

1. **Stage `deps`**: Instala TODAS las dependencias (incluidas dev) para poder correr tests.
2. **Stage `test`**: Corre `npm test` en build-time. Si falla, la imagen no se construye. Esto es clave porque detectamos bugs antes de que lleguen a producción.
3. **Stage `production-deps`**: Reinstala solo dependencias de producción sin dev dependencies, reduciendo el tamaño final.
4. **Stage `final`**: Copia solo lo necesario desde `production-deps`. Resultado: imagen mínima y segura.

**¿Por qué multi-stage?** Porque quiero tests automáticos en cada build pero sin meter Jest, ESLint y otras dev tools en la imagen final que va a producción. Separo concerns: validación vs ejecución.

**Security considerations:**
- **Usuario no-root**: Creo un usuario `appuser` con `uid: 1001` y corro todo como él. Nunca como root.
- **dumb-init como PID 1**: Node.js no maneja señales SIGTERM correctamente si es PID 1. `dumb-init` asegura que el shutdown sea limpio cuando Kubernetes mata el pod.
- **Capabilities dropped**: En Kubernetes uso `drop: [ALL]` para quitar todas las capabilities del contenedor.
- **readOnlyRootFilesystem**: El contenedor no puede escribir en su propio filesystem, solo en volúmenes montados.
- **allowPrivilegeEscalation: false**: Incluso si hay un exploit, no puede escalar privilegios.

**Layer optimization:**
- Copio `package.json` y `package-lock.json` ANTES que el código para aprovechar cache de Docker. Si solo cambia el código, no reinstala dependencias.
- `.dockerignore` excluye `node_modules/`, tests, docs, y archivos innecesarios. Esto acelera el build context transfer.
- `npm cache clean --force` después de instalar para no inflar la imagen con cache de npm.

---

### Kubernetes Design

**Namespace strategy:**
- **Dev**: `devops-challenge-dev` (aislamiento lógico, más permisivo con recursos)
- **Prod**: `devops-challenge-prod` (aislamiento fuerte, resource quotas estrictos)

**¿Por qué separar por namespace?** Facilita aplicar NetworkPolicies distintas, quotas de CPU/memoria diferentes, y deployment workflows independientes sin riesgo de pisar el ambiente de prod accidentalmente.

**Resource allocation rationale:**

| Servicio | Requests | Limits | Razón |
|----------|----------|--------|-------|
| api-gateway | 100m CPU, 128Mi RAM | 500m CPU, 256Mi RAM | Es un proxy liviano. Requests bajos garantizan scheduling fácil. Limits previenen que un spike consuma todo el nodo. |
| user-service | 100m CPU, 128Mi RAM | 500m CPU, 256Mi RAM | CRUD simple con Redis. No necesita más. Si el tráfico sube, el HPA escala pods en vez de dar más recursos a uno solo. |
| redis | 100m CPU, 128Mi RAM | 250m CPU, 256Mi RAM | Redis es eficiente. Con 256MB puede manejar miles de usuarios sin problemas. |

**¿Por qué límites tan conservadores?** Porque estoy optimizando para **density** (cuántos pods caben en un nodo) y **predictability** (evitar que un servicio acapare recursos). Si un pod necesita más, el HPA crea otro en vez de competir por recursos con vecinos.

**Health check configuration:**

**Liveness probe** (`/health/live`):
- **Qué valida**: ¿El proceso está vivo?
- **Si falla**: Kubernetes REINICIA el pod.
- **Config**: `initialDelaySeconds: 15, periodSeconds: 20, failureThreshold: 3`
- **Por qué**: Le doy 15s de margen inicial (startup), chequeo cada 20s (no tan agresivo), y tolero 3 fallas consecutivas antes de reiniciar (60s de gracia).

**Readiness probe** (`/health/ready`):
- **Qué valida**: ¿Puede recibir tráfico? (API Gateway chequea que user-service responda, user-service chequea que Redis esté up)
- **Si falla**: El pod se QUITA del Service (no recibe tráfico) pero NO se reinicia.
- **Config**: `initialDelaySeconds: 10, periodSeconds: 10, failureThreshold: 3`
- **Por qué**: Si Redis cae, user-service deja de ser "ready" pero no lo reinicio porque no solucionaría nada. Espero a que Redis vuelva.

**Startup probe** (`/health/live` también):
- **Qué valida**: ¿Arrancó exitosamente la primera vez?
- **Config**: `initialDelaySeconds: 5, periodSeconds: 5, failureThreshold: 12` (60s total)
- **Por qué**: Le doy tiempo al contenedor para arrancar sin que liveness lo mate prematuramente.

**Scaling strategy:**

**HPA (Horizontal Pod Autoscaler):**
- **Métricas**: CPU al 70% o memoria al 80%
- **Dev**: 1-2 replicas (mínimo para HA, máximo para no explotar mi laptop)
- **Prod**: 3-15 replicas (mínimo 3 para HA real distribuida en availability zones, máximo 15 para limitar costos)

**Configuración de scaling:**
```yaml
scaleUp:
  stabilizationWindowSeconds: 60  # Espera 60s antes de escalar
  policies:
    - type: Pods
      value: 2                      # Escala de 2 en 2

scaleDown:
  stabilizationWindowSeconds: 300  # Espera 5 minutos antes de bajar
  policies:
    - type: Pods
      value: 1                      # Baja de 1 en 1
```

**¿Por qué scale-down es más lento?** Para evitar "thrashing" (subir y bajar constantemente). Es mejor mantener capacidad extra unos minutos que quedarme corto si el tráfico vuelve a subir.

**NetworkPolicies:**
Implementé zero-trust: por defecto TODO está bloqueado. Solo permito:
- api-gateway → user-service (puerto 3001)
- user-service → redis (puerto 6379)
- prometheus → todos (para scraping de /metrics)

Esto limita el blast radius si algún pod se compromete.

**Pod Disruption Budgets (PDB):**
```yaml
minAvailable: 1
```
Garantiza que durante rolling updates o drain de nodos, siempre haya al menos 1 pod de api-gateway y user-service disponible. Esto previene outages durante mantenimiento.

---

### CI/CD Pipeline

**Pipeline stages:**

1. **Lint & Test** (paralelo):
   - Corre `npm run lint` y `npm test` en api-gateway y user-service
   - Si falla: aborta todo
   - Sube coverage reports como artifacts

2. **Build & Push**:
   - Construye imágenes Docker multi-stage
   - Taggea con `sha-<7chars>` (inmutable) + `branch name` + `latest` (solo en main)
   - Push a GitHub Container Registry (ghcr.io)
   - Genera SBOM (Software Bill of Materials) y SLSA provenance para supply chain security

3. **Security Scan** (Trivy):
   - Escanea imágenes en busca de CVEs críticos/altos
   - Sube resultados SARIF a GitHub Security tab
   - No bloquea el deploy (modo report-only) pero se puede configurar para fallar en CVEs críticos

4. **Deploy DEV** (si branch = `develop`):
   - Actualiza tags de imágenes en kustomize overlay de dev
   - Aplica con `kubectl apply -k k8s/overlays/dev`
   - Espera a que pods pasen readiness (`kubectl rollout status`)
   - Smoke test: `curl http://api-gateway/health/ready`

5. **Deploy PROD** (si branch = `main`):
   - Requiere aprobación manual (GitHub Environment protection)
   - Fetch secrets desde AWS Secrets Manager
   - Actualiza tags de imágenes + APP_VERSION con git SHA
   - Aplica con `kubectl apply -k k8s/overlays/prod`
   - Verifica salud con health checks
   - Si falla: auto-rollback con `kubectl rollout undo`

6. **Notificaciones**:
   - Slack webhook en success/failure con SHA, branch, y link a la run

**Deployment strategy:**
- **Dev**: Deploy automático en cada push a `develop`
- **Prod**: Deploy automático en push a `main` pero con approval gate manual

**RollingUpdate**:
```yaml
maxSurge: 1
maxUnavailable: 0
```
Esto significa: crea 1 pod nuevo, espera a que pase readiness, LUEGO mata el viejo. Zero-downtime garantizado.

**Rollback approach:**
- **Automático**: Si el health check post-deploy falla, el pipeline ejecuta `kubectl rollout undo`
- **Manual**: En cualquier momento puedo hacer `kubectl rollout undo deployment/api-gateway -n prod` para volver a la versión anterior
- **GitOps ideal**: Con ArgoCD, simplemente hago `git revert` del commit problemático y ArgoCD revierte automáticamente

**Secret management:**

En el pipeline:
```yaml
- name: Fetch secrets from AWS Secrets Manager
  run: |
    REDIS_PASSWORD=$(aws secretsmanager get-secret-value \
      --secret-id devops-challenge/prod/redis-password \
      --query SecretString --output text)
    echo "redis-password=${REDIS_PASSWORD}" > k8s/overlays/prod/secrets.env
```

Kustomize usa `secrets.env` para generar el Secret de Kubernetes. El archivo se crea en runtime y NUNCA se commitea.

**Image tagging strategy:**
- `sha-abc1234`: Inmutable, usado en deploys para rastreabilidad exacta
- `develop` / `main`: Moving target que apunta al último build de esa branch
- `latest`: Solo en main, para indicar el último release de prod

**¿Por qué NO usar `latest` en deploys?** Porque es ambiguo. Si hago rollback, no sé a qué versión exactamente estoy volviendo. Con `sha-abc1234`, tengo trazabilidad completa.

---

### Environment & Secrets Management

**How do you separate config from code?**

Uso el principio de [12-factor app](https://12factor.net/config): **config vive fuera del código**.

- **En local**: `.env` files (para desarrollo rápido con `npm start`)
- **En Docker Compose**: Variables en `docker-compose.yml`
- **En Kubernetes**: ConfigMaps (config no sensible) + Secrets (passwords, tokens)

El código NUNCA tiene valores hardcodeados. Todo viene de `process.env.VARIABLE`.

**How do you handle sensitive vs non-sensitive config?**

**ConfigMap** (no sensible):
- Ports (3000, 3001)
- URLs de servicios internos (`USER_SERVICE_URL`)
- Nivel de logs (`LOG_LEVEL`)
- Ambiente (`NODE_ENV`)

**Secret** (sensible):
- Passwords de Redis
- API keys de terceros
- Certificados TLS
- Tokens de autenticación

**¿Por qué separar?** Porque ConfigMaps se pueden versionar en Git sin problemas. Secrets NUNCA van a Git.

**How would you manage secrets in production?**

**Solución actual (básica):**
- Secrets viven en AWS Secrets Manager
- CI/CD los inyecta en runtime al generar los manifiestos
- Kustomize los monta como Kubernetes Secrets

**Solución ideal (production-grade):**

**External Secrets Operator** + AWS Secrets Manager:

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

Esto es DECLARATIVO y vive en Git. El operador sincroniza automáticamente desde AWS Secrets Manager cada 1h o cuando el secret cambia. **NUNCA** tengo que copiar passwords manualmente.

**Alternativas consideradas:**
- **Sealed Secrets** (Bitnami): Encripta secrets con una clave del cluster para poder commitearlos a Git. Bueno para GitOps.
- **Vault Agent Injector** (HashiCorp): Inyecta secrets directamente en pods vía sidecar. Muy potente pero más complejo.
- **SOPS**: Encripta archivos YAML con KMS antes de commitear. Bueno pero requiere proceso manual.

**How do you handle different environments (dev/staging/prod)?**

**Kustomize overlays:**
```
k8s/
├── base/              # Configuración compartida
├── overlays/
│   ├── dev/           # 1 replica, debug logs, imagePullPolicy: Never
│   └── prod/          # 3 replicas, warn logs, PVC para Redis
```

Cada overlay hereda de `base/` y sobrescribe solo lo que cambia:

**Dev**:
- `replicas: 1` (ahorro de recursos)
- `LOG_LEVEL: debug` (más verboso)
- `image: devops-challenge/api-gateway:local` (imágenes locales sin registry)
- Secrets en plaintext (no importa, es dev)

**Prod**:
- `replicas: 3` (HA real)
- `LOG_LEVEL: warn` (menos ruido)
- `image: ghcr.io/org/api-gateway:sha-abc1234` (registry externo con SHA)
- Secrets desde AWS Secrets Manager
- PersistentVolumeClaim para Redis (datos persisten)

**¿Por qué Kustomize vs Helm?** Kustomize es más simple para este caso. Helm tiene ventaja cuando necesitas templating complejo o charts reutilizables. Para este proyecto, Kustomize es suficiente y más declarativo.

---

### Monitoring Strategy

**Metrics collected:**

**Default metrics** (vía `prom-client` default collector):
- `process_cpu_seconds_total`: Uso de CPU del proceso
- `process_resident_memory_bytes`: Memoria RAM consumida
- `nodejs_eventloop_lag_seconds`: Event loop lag (indica si Node está bloqueado)
- `nodejs_heap_size_used_bytes`: Memoria heap usada

**Custom metrics**:

| Métrica | Tipo | Labels | Qué mide |
|---------|------|--------|----------|
| `http_requests_total` | Counter | method, route, status_code | Total de requests HTTP recibidos |
| `http_request_duration_seconds` | Histogram | method, route, status_code | Latencia de requests (permite calcular p50, p95, p99) |
| `upstream_request_duration_seconds` | Histogram | service, method, status_code | Latencia de llamadas a user-service desde api-gateway |
| `redis_operation_duration_seconds` | Histogram | operation, status | Tiempo de operaciones contra Redis (GET, SET, DEL, etc.) |
| `users_total` | Gauge | — | Cantidad de usuarios en el sistema |

**Logging format:**

**Structured JSON con Winston:**
```json
{
  "timestamp": "2026-02-17T23:46:48.538Z",
  "level": "info",
  "service": "api-gateway",
  "version": "1.0.0",
  "message": "request completed",
  "method": "POST",
  "path": "/api/users",
  "status_code": 201,
  "duration_ms": 7,
  "request_id": "lq9x8-5f3a9",
  "user_agent": "Mozilla/5.0...",
  "remote_addr": "::ffff:127.0.0.1"
}
```

**¿Por qué JSON?** Porque sistemas como CloudWatch Logs Insights, Loki, y ELK pueden parsearlo sin regex. Filtrar por `service="user-service" AND level="error"` es trivial.

**Request ID propagation:**
El api-gateway genera un `X-Request-ID` y lo propaga al user-service. Todos los logs de esa request llevan el mismo ID. Esto permite seguir una request end-to-end en los logs.

**Alerting rules (proposed):**

**1. High Error Rate**
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
  summary: "5xx error rate >5% on {{ $labels.service }}"
  description: "Error rate is {{ $value | humanizePercentage }}"
```
**¿Por qué 5%?** Es un balance entre ruido (no alertar por 1-2 errores esporádicos) y sensibilidad (detectar problemas reales rápido). 2 minutos de "for" evita alertas por spikes momentáneos.

**2. High P99 Latency**
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
  summary: "P99 latency >2s on {{ $labels.service }}"
```
**¿Por qué P99 y no average?** Porque el average oculta tail latency. Si P99 está en 2s, significa que 1% de usuarios esperan >2 segundos, lo cual es inaceptable.

**3. Pod Restart Loop**
```yaml
alert: PodRestartLoop
expr: increase(kube_pod_container_status_restarts_total[15m]) > 3
for: 5m
labels:
  severity: critical
annotations:
  summary: "Pod {{ $labels.pod }} restarting frequently"
  description: "{{ $value }} restarts in 15 minutes. Likely OOMKill or crash loop."
```
**¿Por qué 3 restarts?** Más de 3 en 15 minutos indica un problema serio (OOM, crash, config error). No es normal.

**4. Redis Down**
```yaml
alert: RedisDown
expr: up{job="redis"} == 0
for: 1m
labels:
  severity: critical
annotations:
  summary: "Redis is unreachable"
  description: "User service will return 503 for all requests."
```
**¿Por qué crítico?** Porque sin Redis, el servicio completo está caído.

**5. HPA at Max Replicas**
```yaml
alert: HPAMaxReplicas
expr: |
  kube_horizontalpodautoscaler_status_current_replicas
  ==
  kube_horizontalpodautoscaler_spec_max_replicas
for: 10m
labels:
  severity: warning
annotations:
  summary: "HPA {{ $labels.horizontalpodautoscaler }} at max capacity"
  description: "Cannot scale further. Investigate traffic spike or bottleneck."
```
**¿Por qué warning y no critical?** Porque el servicio sigue funcionando, solo está al límite. Pero es señal de que hay que revisar si necesitamos más capacidad.

---

## Trade-offs & Assumptions

### Trade-off 1: Redis vs PostgreSQL

**Decision:** Usar Redis como almacenamiento principal.

**Rationale:**
- Para un CRUD simple de usuarios, Redis es más que suficiente
- Sub-millisecond reads/writes vs ~5-10ms con Postgres
- Extremadamente fácil de operar (literalmente un `docker run`)
- No necesito transacciones, joins, ni queries complejos

**Alternative considered:**
- PostgreSQL + Redis como cache: Más robusto para queries complejos pero más overhead operacional
- DynamoDB: Serverless pero lock-in a AWS y más caro para cargas pequeñas

**Trade-off aceptado:**
- No puedo hacer queries del tipo `SELECT * FROM users WHERE created_at > '2024-01-01' ORDER BY name`
- No hay integridad referencial (foreign keys)
- En producción real con búsquedas complejas, usaría Postgres + Redis cache

---

### Trade-off 2: maxUnavailable: 0 en Rolling Updates

**Decision:** Priorizar zero-downtime sobre eficiencia de recursos.

**Rationale:**
- `maxUnavailable: 0` + `maxSurge: 1` garantiza que SIEMPRE haya pods ready durante deploys
- El costo es tener 1 pod extra temporalmente (por ~30 segundos)
- En un sistema de producción con usuarios reales, prefiero pagar ese costo a tener aunque sea 1 segundo de downtime

**Alternative considered:**
- `maxUnavailable: 1, maxSurge: 0`: Ahorra recursos pero puede causar micro-downtimes si el nuevo pod tarda en pasar readiness

**Trade-off aceptado:**
- Consumo extra de CPU/memoria temporal durante cada deploy
- No es problema en la nube porque se cobra por uso promedio, no pico instantáneo

---

### Trade-off 3: Liveness probe independiente de Readiness

**Decision:** Separar los endpoints y propósitos de liveness (`/health/live`) y readiness (`/health/ready`).

**Rationale:**
- Si Redis cae, user-service deja de ser "ready" (no recibe tráfico) pero NO necesita reiniciarse
- Reiniciar el pod no soluciona que Redis esté caído
- Con probes separadas, el pod espera pacientemente a que Redis vuelva sin restarts innecesarios

**Alternative considered:**
- Un solo endpoint `/health` que chequea todo: Más simple pero causaría restarts innecesarios cuando falla una dependencia externa

**Trade-off aceptado:**
- Más complejidad en la lógica de health checks
- Pero gano estabilidad: menos restarts = menos disrupciones

---

### Trade-off 4: Tests en build-time vs runtime

**Decision:** Correr `npm test` DENTRO del Dockerfile en la stage `test`.

**Rationale:**
- Si los tests fallan, la imagen nunca se construye
- Fail-fast: detecto bugs antes de que lleguen a Kubernetes
- Los tests NO inflan la imagen final porque uso multi-stage y solo copio desde `production-deps`

**Alternative considered:**
- Correr tests en CI antes de build: Funciona pero permite que una imagen "broken" se construya si alguien hace `docker build` local sin tests

**Trade-off aceptado:**
- Builds más lentos (~30 segundos extra)
- Pero la ganancia en calidad vale la pena

---

## Security Considerations

1. **Non-root containers:**
   - Usuario `appuser` con `uid: 1001`
   - Si el contenedor se compromete, el atacante NO tiene root

2. **ReadOnlyRootFilesystem:**
   - El contenedor no puede escribir en su propio filesystem
   - Previene que malware persista después de un exploit

3. **Capabilities dropped:**
   ```yaml
   capabilities:
     drop: [ALL]
   ```
   - Quito TODAS las capabilities de Linux
   - Minimiza lo que un proceso comprometido puede hacer

4. **NetworkPolicies:**
   - Default deny-all
   - Solo permito tráfico explícito (api-gateway → user-service, user-service → redis)
   - Limita lateral movement si un pod se compromete

5. **Secrets management:**
   - Secrets NUNCA en Git
   - Inyectados desde AWS Secrets Manager en runtime
   - Rotación manual (ideal: auto-rotación con Vault)

6. **Image scanning (Trivy):**
   - Escaneo automático en CI/CD
   - Detección de CVEs críticos/altos
   - SARIF upload a GitHub Security tab para visibilidad

7. **SBOM + SLSA Provenance:**
   - Software Bill of Materials en cada imagen
   - Provenance de supply chain para rastrear origen de dependencias

8. **Pod Security Standards:**
   - Baseline: `allowPrivilegeEscalation: false`, `runAsNonRoot: true`
   - No uso Restricted porque necesito escribir en /tmp, pero podría si fuera necesario

---

## What I Would Improve With More Time

1. **GitOps con ArgoCD:**
   - Reemplazar `kubectl apply` en CI/CD con ArgoCD App-of-Apps
   - Declarativo, auditable, con drift detection automático
   - Rollbacks triviales (solo `git revert`)

2. **Redis High Availability:**
   - Redis Sentinel para auto-failover
   - O Redis Cluster para sharding y mayor capacidad
   - Actualmente Redis es un SPOF

3. **Ingress Controller:**
   - NGINX Ingress o AWS ALB Ingress
   - TLS termination, rate limiting, WAF
   - Mejor que exponer servicios con LoadBalancer

4. **Service Mesh (Istio):**
   - mTLS automático entre todos los pods
   - Circuit breaking, retries, timeouts configurables
   - Observabilidad granular de tráfico inter-service

5. **Integration tests en CI:**
   - Levantar un cluster `kind` en GitHub Actions
   - Deploy completo + tests end-to-end
   - Validar el stack completo antes de merge

6. **KEDA para cost optimization:**
   - Scale-to-zero durante off-hours
   - Escalado basado en eventos (queue depth, metrics custom)

7. **Distributed tracing (OpenTelemetry):**
   - Trazas end-to-end de requests a través de todos los servicios
   - Jaeger o AWS X-Ray para visualización

8. **Chaos Engineering:**
   - Chaos Mesh o Litmus para inyectar fallas controladas
   - Validar resiliencia ante pod kills, network delays, etc.

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

**Notas:**
- La mayor parte del tiempo fue en Kubernetes (HPA, NetworkPolicies, Kustomize overlays)
- CI/CD tomó tiempo porque quise hacerlo production-grade con Trivy, SBOM, y auto-rollback
- Troubleshooting fue relativamente rápido porque los bugs eran evidentes una vez entendías Kubernetes
- Documentación tomó más de lo esperado porque quise explicar el "por qué" de cada decisión, no solo el "qué"