# Monitoring & Observability Strategy

## Overview

This document describes the observability stack for the VIP Medical Group DevOps Challenge. The strategy follows the **three pillars of observability**: metrics, logs, and traces.

---

## 1. Metrics — Prometheus + Grafana

### Deployment

Both services expose a `/metrics` endpoint in Prometheus text format via `prom-client`. Prometheus scrapes these endpoints every 15 seconds using pod annotations:

```yaml
annotations:
  prometheus.io/scrape: "true"
  prometheus.io/port: "3001"
  prometheus.io/path: "/metrics"
```

### Metrics Collected

**Default Node.js metrics (via `prom-client` default collector):**
- `process_cpu_seconds_total` — CPU usage
- `process_resident_memory_bytes` — Memory usage
- `nodejs_eventloop_lag_seconds` — Event loop lag (critical for detecting blocked I/O)
- `nodejs_heap_size_used_bytes` — Heap usage

**Custom application metrics:**

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `http_requests_total` | Counter | method, route, status_code | Total HTTP requests |
| `http_request_duration_seconds` | Histogram | method, route, status_code | Request latency |
| `upstream_request_duration_seconds` | Histogram | service, method, status_code | Gateway → upstream latency |
| `redis_operation_duration_seconds` | Histogram | operation, status | Redis command latency |
| `users_total` | Gauge | — | Total users in system |

### Grafana Dashboards

Three dashboards are recommended:

1. **Service Overview** — request rate, error rate, p50/p95/p99 latency (RED method)
2. **Infrastructure** — CPU, memory, pod restarts, HPA scaling events
3. **Business Metrics** — users created/deleted per hour, active users

---

## 2. Logging — Structured JSON with Winston

All services use `winston` with JSON format. Every log line includes:

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

**Why structured JSON logs?**
- Parseable by any log aggregation system without regex
- Easily filtered/queried (e.g., `level=error AND service=user-service`)
- `request_id` propagation enables request tracing across services

### Log Aggregation Stack

In production (AWS EKS):
- **Fluent Bit** (DaemonSet) → collects container logs from `/var/log/containers/`
- **Amazon CloudWatch Logs** → centralized storage and querying
- **CloudWatch Log Insights** → ad-hoc queries, anomaly detection

Alternative open-source stack:
- **Fluent Bit** → **Loki** (log aggregation) → **Grafana** (visualization)

---

## 3. Distributed Tracing — OpenTelemetry

*(Bonus implementation)*

Instruments are added via `@opentelemetry/sdk-node` for end-to-end request tracing across the api-gateway → user-service chain.

In production: traces are exported to **AWS X-Ray** or **Jaeger**.

Each trace span captures:
- HTTP method, path, status code
- Upstream service calls with latency
- Redis operations
- Error stack traces

---

## 4. Alerting Rules

### Rule 1: High Error Rate

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
  summary: "High 5xx error rate on {{ $labels.service }}"
  description: "Error rate is {{ $value | humanizePercentage }} over the last 5 minutes"
  runbook_url: "https://wiki.example.com/runbooks/high-error-rate"
```

**Why:** A 5% error rate for 2 minutes signals a meaningful service degradation that requires immediate attention.

### Rule 2: High P99 Latency

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
  summary: "P99 latency above 2s on {{ $labels.service }}"
  description: "P99 latency is {{ $value }}s — users are experiencing slow responses"
```

**Why:** P99 at 2s means 1% of users wait more than 2 seconds. At scale this is significant. We use P99 rather than average because averages mask tail latency.

### Rule 3: Pod Restart Loop

```yaml
alert: PodRestartLoop
expr: |
  increase(kube_pod_container_status_restarts_total[15m]) > 3
for: 5m
labels:
  severity: critical
annotations:
  summary: "Pod {{ $labels.pod }} is restarting frequently"
  description: "Container {{ $labels.container }} has restarted {{ $value }} times in 15 minutes. Likely OOMKill or crash loop."
```

**Why:** More than 3 restarts in 15 minutes indicates a crash loop (OOMKill, config error, or unhandled exception).

### Rule 4: Redis Down

```yaml
alert: RedisDown
expr: up{job="redis"} == 0
for: 1m
labels:
  severity: critical
annotations:
  summary: "Redis is unreachable"
  description: "User service will start returning 503 — all user operations depend on Redis"
```

### Rule 5: HPA at Max Replicas

```yaml
alert: HPAMaxReplicasReached
expr: |
  kube_horizontalpodautoscaler_status_current_replicas
  ==
  kube_horizontalpodautoscaler_spec_max_replicas
for: 10m
labels:
  severity: warning
annotations:
  summary: "HPA {{ $labels.horizontalpodautoscaler }} has reached max replicas"
  description: "Cannot scale further — investigate traffic spike or resource bottleneck"
```

---

## 5. Secrets Management Strategy

### Problem

Kubernetes Secrets are base64-encoded (not encrypted) and are stored in etcd. If etcd is compromised or secrets are accidentally committed to Git, credentials are exposed.

### Production Solution: External Secrets Operator + AWS Secrets Manager

```
AWS Secrets Manager
      ↓  (IAM Role for Service Account — IRSA)
External Secrets Operator (k8s controller)
      ↓  (syncs every 1h or on-demand)
Kubernetes Secret (in-cluster, never in Git)
      ↓
Pod (mounted as env var or volume)
```

**Steps:**
1. Store secrets in AWS Secrets Manager (`devops-challenge/prod/redis-password`)
2. Install External Secrets Operator in cluster
3. Create `ExternalSecret` manifest (this IS committed to Git — it's just a reference, not the value)
4. ESO fetches the actual value from ASM and creates the Kubernetes Secret automatically
5. Secrets rotate automatically when ASM value changes

**For GitOps (ArgoCD/Flux):**
- Use **Sealed Secrets** (Bitnami) — encrypt secrets with a cluster-specific key so they can safely be committed to Git
- Only the cluster's private key can decrypt them

### What We NEVER Do
- Hardcode secrets in Dockerfiles, app code, or manifests
- Commit `.env` files with real values
- Use `imagePullPolicy: Always` with `latest` tag (unpredictable)
- Store secrets as ConfigMap values

---

## 6. Cost Optimization Notes

- Use **KEDA** (Kubernetes Event-Driven Autoscaling) for scale-to-zero during off-hours
- Set appropriate resource `requests` (affects scheduling) and `limits` (affects throttling)
- Use **Spot Instances** for non-critical workloads via node taints/tolerations
- Implement **CloudWatch Container Insights** for per-service cost attribution
- Review HPA metrics weekly to right-size `minReplicas`
