# Architecture Documentation

## System Overview

```
                        ┌─────────────────────────────────────┐
                        │         Kubernetes Cluster           │
                        │                                      │
Internet ──────────────▶│  ┌─────────────┐                   │
   :3000                │  │ api-gateway  │────────────────┐  │
                        │  │  (2-15 pods) │                │  │
                        │  └─────────────┘                │  │
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
                        │  ┌──────────────┐                  │
                        │  │  Prometheus  │──scrapes /metrics │
                        │  │   Grafana    │                   │
                        │  └──────────────┘                  │
                        └─────────────────────────────────────┘
```

## Service Responsibilities

### API Gateway (port 3000)
- Single entry point for all external traffic
- Routes `/api/users/*` to User Service
- Implements request tracing via `X-Request-ID` header
- Exposes `/health/live`, `/health/ready`, `/metrics`
- Does NOT hold state — horizontally scalable

### User Service (port 3001)
- Manages CRUD operations for users
- Backed by Redis for persistence
- Exposes `/health/live` (always), `/health/ready` (checks Redis), `/metrics`
- Stateless application layer — Redis holds all data

### Redis (port 6379)
- Key-value store for user data
- Keys: `user:<uuid>` (user JSON), `users:index` (set of IDs)
- Protected by password authentication
- `maxmemory-policy: allkeys-lru` to handle memory pressure gracefully

---

## Design Decisions

### Why Redis instead of PostgreSQL?

**Trade-off:** Redis is fast and simple for key-value operations but lacks complex querying, transactions, and relational integrity.

**Decision rationale:** For this challenge scope (user CRUD), Redis provides sub-millisecond reads/writes with minimal operational overhead. In production with complex query requirements (search, filtering, joins), I would use PostgreSQL with Redis as a read-through cache.

### Why non-root containers?

Running as root inside a container is a security risk — if the container is compromised, the attacker has root privileges inside the namespace. Using `uid: 1001` with `allowPrivilegeEscalation: false` limits blast radius.

### Why `dumb-init` as PID 1?

Node.js is not designed to be PID 1. When Kubernetes sends SIGTERM to a container, PID 1 must forward it to child processes. Without `dumb-init`, the Node process may not receive SIGTERM, preventing graceful shutdown (in-flight requests are dropped, connections aren't closed cleanly).

### Why `maxUnavailable: 0` in RollingUpdate?

Setting `maxUnavailable: 0` ensures that during a rolling deploy, new pods must be ready before old pods are terminated. This guarantees zero-downtime deploys at the cost of temporarily requiring extra capacity (`maxSurge: 1`).

### Why separate liveness and readiness probes?

- **Liveness** (`/health/live`): Is the process alive? Only fails on deadlock, out-of-memory, or unrecoverable error. Failure triggers **restart**.
- **Readiness** (`/health/ready`): Can the service accept traffic right now? Checks Redis connectivity. Failure removes the pod from the Service's endpoint list (stops traffic) but does NOT restart it.

This distinction is critical: if Redis is temporarily unavailable, we want to stop sending traffic to user-service pods (readiness fails), but we should NOT restart them (liveness stays healthy). Restarting would be pointless and counterproductive.

### Secrets Management Strategy

See `docs/monitoring-strategy.md` for full details.

**Short version:** In production, use External Secrets Operator + AWS Secrets Manager. The Secret manifest in `k8s/base/secret.yaml` is a placeholder template — real values are injected by CI/CD from a secrets manager and never committed to Git.

---

## What I Would Improve With More Time

1. **GitOps with ArgoCD** — Replace `kubectl apply` in CI/CD with ArgoCD App-of-Apps pattern for declarative, auditable deployments with automatic drift detection.

2. **Redis High Availability** — Use Redis Sentinel or Redis Cluster for production. Currently Redis is a SPOF.

3. **Ingress Controller** — Add an NGINX or AWS ALB Ingress Controller instead of port-forwarding for production traffic routing.

4. **mTLS with Istio** — Replace NetworkPolicies with a full service mesh for encrypted pod-to-pod communication and more granular traffic management.

5. **Integration tests in CI** — Add a `kind` cluster to CI/CD and run full end-to-end API tests before pushing to staging.

6. **KEDA for cost optimization** — Scale to zero during off-hours using Kubernetes Event-Driven Autoscaling with CloudWatch metrics as the scaler.

---

## Local Development Quick Start

```bash
# Option A: Docker Compose (simplest)
docker-compose up -d
curl http://localhost:3000/health
curl -X POST http://localhost:3000/api/users \
  -H "Content-Type: application/json" \
  -d '{"name":"John","email":"john@example.com"}'

# Option B: kind cluster
kind create cluster --name devops-challenge
docker build -t devops-challenge/api-gateway:local ./apps/api-gateway
docker build -t devops-challenge/user-service:local ./apps/user-service
kind load docker-image devops-challenge/api-gateway:local --name devops-challenge
kind load docker-image devops-challenge/user-service:local --name devops-challenge
kubectl apply -k k8s/overlays/dev
kubectl port-forward svc/api-gateway 3000:3000 -n devops-challenge-dev
```
