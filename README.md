# DevOps Challenge — Solution

This repository contains my solution for the VIP Medical DevOps Engineer Challenge.

The goal was to treat the platform as real production infrastructure — not just make the application "work", but build it the way I would if real users depended on it. That means reliability, automation, security, and observability from day one.

**Author:** Alejandro De Mendoza
**Branch:** main
**Time spent:** ~7-10 hours

Most of the time went into hardening the Kubernetes layer (NetworkPolicies, HPA behavior, health probe configuration, initContainers) and carefully analyzing the broken deployment to document the root causes — not just the symptoms.

---

## Solution Summary

| Part | Status | Notes |
|------|--------|-------|
| Part 1: Containerization | Complete | Multi-stage builds, non-root user, dumb-init, images <200MB |
| Part 2: Kubernetes | Complete | Kustomize overlays, HPA, NetworkPolicies, PDB (bonus) |
| Part 3: CI/CD | Complete | GitHub Actions, Trivy security scanning (bonus), auto-rollback |
| Part 4: Monitoring | Complete | Prometheus metrics, structured JSON logging, 5 alerting rules |
| Part 5: Troubleshooting | Complete | 8 issues identified and documented (8+ required) |
| Bonus: Security scanning | Trivy in CI/CD | SARIF upload to GitHub Security tab |
| Bonus: Pod Disruption Budgets | Complete | PDBs for api-gateway and user-service |

---

## Quick Start

### Option A — Docker Compose (fastest, recommended for local dev)

```bash
docker-compose up -d

# Health check
curl http://localhost:3000/health

# List users
curl http://localhost:3000/api/users

# Create a user
curl -X POST http://localhost:3000/api/users \
  -H "Content-Type: application/json" \
  -d '{"name":"John Doe","email":"john@example.com"}'
```

### Option B — Kubernetes with Docker Desktop

Make sure Kubernetes is enabled in Docker Desktop settings.

```bash
# 1. Verify cluster access
kubectl cluster-info
kubectl get nodes

# 2. Build local images
docker build -t devops-challenge/api-gateway:local ./apps/api-gateway
docker build -t devops-challenge/user-service:local ./apps/user-service

# 3. Deploy dev overlay
kubectl apply -k k8s/overlays/dev

# 4. Wait for pods to be ready
kubectl get pods -n devops-challenge-dev -w

# 5. Expose the API Gateway locally
kubectl port-forward svc/api-gateway 3000:3000 -n devops-challenge-dev

# 6. Test (in another terminal)
curl http://localhost:3000/health/ready
curl http://localhost:3000/api/users
```

---

## Project Structure

```
.
├── README.md
├── docker-compose.yml
├── apps/
│   ├── api-gateway/
│   │   ├── src/
│   │   │   ├── index.js           # Express proxy with metrics, structured logging, graceful shutdown
│   │   │   └── index.test.js      # Jest tests with axios mocked
│   │   ├── package.json
│   │   ├── Dockerfile             # Multi-stage: deps → test → production-deps → final
│   │   ├── .dockerignore
│   │   └── .env                   # Local dev only (gitignored)
│   └── user-service/
│       ├── src/
│       │   ├── index.js           # Express CRUD app backed by Redis
│       │   └── index.test.js      # Jest tests with Redis mocked in-memory
│       ├── package.json
│       ├── Dockerfile
│       ├── .dockerignore
│       └── .env                   # Local dev only (gitignored)
├── k8s/
│   ├── base/                      # Shared manifests (all environments inherit from here)
│   │   ├── kustomization.yaml
│   │   ├── configmap.yaml         # Non-sensitive config only
│   │   ├── secret.yaml            # Template only — real values come from secrets manager
│   │   ├── api-gateway-deployment.yaml
│   │   ├── api-gateway-service.yaml
│   │   ├── user-service-deployment.yaml
│   │   ├── user-service-service.yaml
│   │   ├── redis-deployment.yaml
│   │   ├── redis-service.yaml
│   │   ├── hpa.yaml               # HPA for api-gateway and user-service
│   │   ├── network-policies.yaml  # Zero-trust: default deny-all + explicit allow rules
│   │   └── pdb.yaml               # Pod Disruption Budgets
│   ├── overlays/
│   │   ├── dev/                   # 1 replica, debug logs, local images, imagePullPolicy: Never
│   │   └── prod/                  # 3 replicas, warn logs, images from ghcr.io with SHA tag
│   └── broken/
│       ├── deployment.yaml        # Intentionally broken manifests — 8 bugs to find
│       └── README.md              # Troubleshooting scenario + full solution
├── .github/
│   └── workflows/
│       └── ci-cd.yml              # lint → test → build → scan → deploy → notify
└── docs/
    ├── architecture.md            # Design decisions, trade-offs, environment strategy
    ├── monitoring.md              # Prometheus metrics, alerting rules, log aggregation
    └── troubleshooting.md         # 8 bugs in broken/ — root cause + fix for each
```

---

## Part 1 — Containerization

Both services use a **4-stage Dockerfile**:

1. **`deps`** — Installs all dependencies including devDependencies. Also installs `dumb-init`.
2. **`test`** — Runs `npm test` at build time. If tests fail, the image is never built. This catches regressions before anything reaches Kubernetes.
3. **`production-deps`** — Reinstalls only production dependencies, without Jest, ESLint, or any other dev tooling.
4. **`final`** — Copies only what's needed from `production-deps`. Runs as a non-root user (`uid: 1001`). Uses `dumb-init` as PID 1.

**Why dumb-init?** Node.js doesn't handle SIGTERM correctly when running as PID 1. dumb-init acts as a minimal init process and forwards signals properly, so Kubernetes can shut down pods cleanly without dropping in-flight requests.

**Why non-root?** Running as root inside a container means a container escape gives an attacker root on the host. Running as `uid: 1001` limits the blast radius significantly.

**Why tests inside the Dockerfile?** Because `docker build` is often run locally without going through CI. This ensures tests always run, regardless of how the image is built.

---

## Part 2 — Kubernetes

### Health Probes

Three distinct probes, each with a different job:

| Probe | Endpoint | Action on failure | Purpose |
|-------|----------|-------------------|---------|
| **Liveness** | `/health/live` | Restart the container | Is the process alive? |
| **Readiness** | `/health/ready` | Remove from Service | Can it receive traffic? |
| **Startup** | `/health/live` | Restart if not up in 60s | Give extra time on first boot |

The key insight: **readiness and liveness should not be the same thing**. If Redis goes down, the user-service should stop receiving traffic (readiness fails) but it should NOT restart (liveness stays ok). Restarting doesn't fix Redis being down — it just causes unnecessary disruption.

### InitContainer

The user-service has an initContainer that waits for Redis to be ready before the main container starts:

```yaml
initContainers:
  - name: wait-for-redis
    image: busybox:1.36
    command:
      - sh
      - -c
      - until nc -z redis 6379; do sleep 2; done
```

This eliminated the restart that happened on the first deploy when user-service started before Redis was ready.

### NetworkPolicies (Zero Trust)

Default deny-all, then explicit allow rules:

```
Internet → api-gateway (:3000)
api-gateway → user-service (:3001)
user-service → redis (:6379)
prometheus → all pods (/metrics)
```

Nothing else is allowed. If a pod gets compromised, it can't talk to anything it's not supposed to.

### Kustomize Overlays

```
k8s/base/        → shared config (all environments inherit from here)
k8s/overlays/dev/   → 1 replica, debug logs, local images, imagePullPolicy: Never
k8s/overlays/prod/  → 3 replicas, warn logs, ghcr.io images with SHA tag
```

Each overlay only overrides what actually changes. The base stays clean and DRY.

---

## Part 3 — CI/CD Pipeline

The GitHub Actions pipeline runs on every push:

```
1. Lint & Test     → npm run lint + npm test (parallel for both services)
2. Build & Push    → docker build multi-stage → push to ghcr.io
3. Security Scan   → Trivy CVE scan → SARIF uploaded to GitHub Security tab
4. Deploy DEV      → on push to develop → kubectl apply -k overlays/dev → smoke test
5. Deploy PROD     → on push to main → approval gate → apply → health check → auto-rollback if it fails
6. Notify          → Slack webhook with result, SHA, and link to the run
```

**Image tagging strategy:**
- `sha-abc1234` — immutable, used for actual deploys (you always know exactly what's running)
- `develop` / `main` — moving tags pointing to the latest build on each branch
- `latest` — only on main, for human convenience

`latest` is never used in actual Kubernetes manifests. Only the SHA tag is. This makes rollbacks reliable — `kubectl rollout undo` goes back to a specific known image, not an ambiguous tag.

---

## Part 4 — Monitoring

### Metrics

Both services expose `/metrics` in Prometheus format via `prom-client`.

**Default metrics** (collected automatically): CPU, memory, event loop lag, heap usage.

**Custom metrics:**

| Metric | Type | What it tells you |
|--------|------|-------------------|
| `http_requests_total` | Counter | Request rate and error rate by route |
| `http_request_duration_seconds` | Histogram | P50/P95/P99 latency |
| `upstream_request_duration_seconds` | Histogram | api-gateway → user-service call latency |
| `redis_operation_duration_seconds` | Histogram | Redis operation latency by type |
| `users_total` | Gauge | Total users in the system (business metric) |

Prometheus auto-discovers pods via annotations:
```yaml
annotations:
  prometheus.io/scrape: "true"
  prometheus.io/port: "3001"
  prometheus.io/path: "/metrics"
```

### Logging

Structured JSON with Winston. Every log line has `timestamp`, `level`, `service`, `version`, `message` and request-specific fields:

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

The `request_id` is generated by the api-gateway and propagated to the user-service via `X-Request-ID` header. This lets you trace a single request end-to-end across both services just by filtering on that ID in CloudWatch or Loki.

### Alerting Rules

Five alerting rules defined in `docs/monitoring.md`:

1. **HighErrorRate** — 5xx error rate > 5% for 2 minutes → critical
2. **HighP99Latency** — P99 > 2 seconds for 5 minutes → warning
3. **RedisDown** — Redis unreachable for 1 minute → critical
4. **PodRestartLoop** — More than 3 restarts in 15 minutes → critical
5. **HPAAtMaxReplicas** — HPA at max capacity for 10 minutes → warning

---

## Part 5 — Troubleshooting

The `k8s/broken/` directory contains manifests with **8 intentional bugs**. Here's what was found:

| # | Bug | Impact |
|---|-----|--------|
| 1 | Pod label doesn't match Deployment selector | Deployment rejected, no pods created |
| 2 | Wrong container port (8080 vs 3000) | Probes fail, pods never become ready |
| 3 | Memory limit too low (64Mi) for Node.js | OOMKill on startup, CrashLoopBackOff |
| 4 | Wrong Redis hostname (`redis-master` vs `redis`) | DNS failure, Redis unreachable |
| 5 | `failureThreshold: 1` on liveness probe | One slow response = immediate restart |
| 6 | Service `targetPort: 8080` (container listens on 3001) | All traffic fails with Connection refused |
| 7 | Redis requires auth but app connects without password | All Redis ops fail with NOAUTH |
| 8 | Credentials in plain text ConfigMap | Security risk — passwords exposed to anyone with kubectl access |

Full analysis with root cause, impact, and fix for each issue: [`docs/troubleshooting.md`](docs/troubleshooting.md)

---

## Key Design Decisions

**Why `maxUnavailable: 0` in rolling updates?**
Zero-downtime deploys. With `maxUnavailable: 0` and `maxSurge: 1`, the new pod must pass readiness before the old one is terminated. The cost is 1 extra pod for ~30 seconds per deploy — completely worth it.

**Why separate liveness and readiness?**
Readiness protects traffic flow. Liveness protects process health. Restarting a pod won't fix a Redis outage — it just adds noise. The probes are intentionally designed to handle dependency failures gracefully.

**Why ConfigMap vs Secret?**
ConfigMaps for anything that can live in Git (ports, URLs, log levels). Secrets for anything sensitive (passwords, API keys). In production, secrets are never stored in YAML — they come from AWS Secrets Manager via External Secrets Operator.

**Why Kustomize over Helm?**
For this project, Kustomize is simpler and more declarative. Helm adds value when you need parameterized templates or want to distribute a chart. Here, the overlay model is sufficient and easier to reason about.

---

## Assumptions Made

- Target production environment is AWS EKS
- Secrets in production come from AWS Secrets Manager (not stored in manifest files)
- `metrics-server` is installed in the cluster (required for HPA to function)
- The cluster uses a CNI that supports NetworkPolicies (e.g., Calico, Cilium)
- Redis password is rotated automatically via External Secrets Operator in production

---

## What I Would Improve With More Time

1. **GitOps with ArgoCD** — replace `kubectl apply` in CI with declarative, drift-detected deployments
2. **Redis HA** — Redis Sentinel or a managed service (ElastiCache) to remove the single point of failure
3. **Integration tests in CI** — spin up a `kind` cluster in GitHub Actions, deploy everything, run end-to-end tests
4. **Distributed tracing** — OpenTelemetry with AWS X-Ray or Jaeger for full request tracing
5. **KEDA** — scale-to-zero in off-hours and event-based autoscaling
6. **PersistentVolumeClaim for Redis** — `emptyDir` is fine for dev, but prod needs a real PVC so data survives pod restarts
