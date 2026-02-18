# Troubleshooting Scenario

The manifests in this directory represent a **broken production deployment**. Your team deployed these manifests and the application is not working. Users are reporting errors.

## Your Task

1. Review the manifests and identify **all the issues**
2. Document each issue you find in `docs/troubleshooting.md`
3. For each issue explain:
   - What is wrong
   - Why it causes a problem
   - How to fix it

## Context

- The application was working before this deployment
- The Docker images exist and are valid
- The Kubernetes cluster is healthy
- Redis is running and accessible at `redis:6379`

## Hints

There are **at least 8 issues** across these manifests. Some are obvious, some are subtle.

---

## Solution — Issues Found and Fixed

### BUG 1 — Label doesn't match selector (`api-gateway-deployment.yaml`)

**What is wrong:**
```yaml
# BROKEN
selector:
  matchLabels:
    app: api-gateway
template:
  metadata:
    labels:
      app: gateway   # ← doesn't match selector
```

**Why it causes a problem:** Kubernetes requires the Deployment selector to exactly match the pod template labels. With this mismatch, the Deployment is rejected at apply time — no pods are ever created.

**How it was fixed:**
```yaml
# FIXED
selector:
  matchLabels:
    app: api-gateway
template:
  metadata:
    labels:
      app: api-gateway   # ← now matches selector
```

---

### BUG 2 — Wrong container port (`api-gateway-deployment.yaml`)

**What is wrong:**
```yaml
# BROKEN
ports:
  - containerPort: 8080   # app runs on 3000
```

**Why it causes a problem:** The application listens on port 3000. Health check probes and internal routing attempt to reach port 8080 where nothing is listening. Pods never become ready and Kubernetes keeps restarting them.

**How it was fixed:**
```yaml
# FIXED
ports:
  - containerPort: 3000
    name: http
```

---

### BUG 3 — Memory limit too low for Node.js (`api-gateway-deployment.yaml`)

**What is wrong:**
```yaml
# BROKEN
limits:
  cpu: "50m"
  memory: "64Mi"   # too low for Node.js
```

**Why it causes a problem:** Node.js requires significantly more than 64Mi to run. The container gets OOMKilled immediately on startup and enters `CrashLoopBackOff`. The pod never stabilizes.

**How it was fixed:**
```yaml
# FIXED
resources:
  requests:
    cpu: "100m"
    memory: "128Mi"
  limits:
    cpu: "500m"
    memory: "256Mi"
```

---

### BUG 4 — Wrong Redis hostname (`user-service-deployment.yaml`)

**What is wrong:**
```yaml
# BROKEN
- name: REDIS_HOST
  value: "redis-master"   # service is named "redis"
```

**Why it causes a problem:** The Kubernetes Service for Redis is named `redis`, not `redis-master`. Kubernetes DNS returns `NXDOMAIN` for `redis-master`. The user-service cannot connect to Redis and fails on every request.

**How it was fixed:**
```yaml
# FIXED — correct hostname with full auth URL
- name: REDIS_URL
  value: "redis://:$(REDIS_PASSWORD)@redis:6379"
```

---

### BUG 5 — Liveness probe too aggressive (`user-service-deployment.yaml`)

**What is wrong:**
```yaml
# BROKEN
livenessProbe:
  httpGet:
    path: /health       # wrong path, app exposes /health/live
    port: 3001
  initialDelaySeconds: 3
  periodSeconds: 5
  failureThreshold: 1   # 1 failure = immediate restart
```

**Why it causes a problem:** A `failureThreshold` of 1 means any single transient failure (GC pause, CPU spike) immediately triggers a container restart. This causes constant unnecessary restarts that degrade availability even when the app is healthy. The probe path `/health` was also incorrect.

**How it was fixed:**
```yaml
# FIXED
livenessProbe:
  httpGet:
    path: /health/live
    port: 3001
  initialDelaySeconds: 15
  periodSeconds: 20
  timeoutSeconds: 5
  failureThreshold: 3

startupProbe:
  httpGet:
    path: /health/live
    port: 3001
  initialDelaySeconds: 5
  periodSeconds: 5
  failureThreshold: 12   # gives 60s max for startup
```

---

### BUG 6 — Service `targetPort` doesn't match container port (`user-service-service.yaml`)

**What is wrong:**
```yaml
# BROKEN
ports:
  - port: 3001
    targetPort: 8080   # container listens on 3001, not 8080
```

**Why it causes a problem:** The Service forwards traffic to port 8080 inside the pod, but the container listens on 3001. All traffic routed through this Service fails with `Connection refused`.

**How it was fixed:**
```yaml
# FIXED
ports:
  - port: 3001
    targetPort: 3001
    name: http
```

---

### BUG 7 — Redis requires auth but app doesn't send password (`redis-deployment.yaml`)

**What is wrong:**
```yaml
# BROKEN — Redis started with requirepass but user-service connects without auth
command: ["redis-server", "--requirepass", "supersecret"]

# user-service had no REDIS_PASSWORD configured
- name: REDIS_HOST
  value: "redis-master"
```

**Why it causes a problem:** Redis rejects all unauthenticated connections with `NOAUTH Authentication required`. The user-service connects without sending a password and gets an auth error on every Redis operation. All CRUD endpoints return 500.

**How it was fixed:**
```yaml
# FIXED — password injected from Secret, connection URL includes auth
# redis-deployment.yaml
- name: REDIS_PASSWORD
  valueFrom:
    secretKeyRef:
      name: app-secrets
      key: REDIS_PASSWORD

# user-service-deployment.yaml
- name: REDIS_PASSWORD
  valueFrom:
    secretKeyRef:
      name: app-secrets
      key: redis-password
- name: REDIS_URL
  value: "redis://:$(REDIS_PASSWORD)@redis:6379"
```

---

### BUG 8 — Sensitive credentials in plain text ConfigMap (`configmap.yaml`)

**What is wrong:**
```yaml
# BROKEN — passwords exposed in ConfigMap
data:
  REDIS_PASSWORD: "supersecret"
  DATABASE_URL: "postgresql://admin:p4ssw0rd@db:5432/app"
```

**Why it causes a problem:** ConfigMaps are stored unencrypted in etcd and visible to anyone with `kubectl get configmap` access. Credentials in ConfigMaps violate the principle of least privilege and are a critical security risk. In GitOps workflows they often end up committed to Git, permanently exposing credentials.

**How it was fixed:**
```yaml
# FIXED — ConfigMap only contains non-sensitive config
data:
  PORT_GATEWAY: "3000"
  USER_SERVICE_URL: "http://user-service:3001"
  REDIS_HOST: "redis"
  REDIS_PORT: "6379"
  LOG_LEVEL: "info"
  NODE_ENV: "production"
  REDIS_MAX_MEMORY: "128mb"

# All sensitive data moved to secret.yaml (Kubernetes Secrets)
# In production: AWS Secrets Manager + External Secrets Operator
```

---

## Summary Table

| # | Bug | File | Impact | Fix Applied |
|---|-----|------|--------|-------------|
| 1 | Label doesn't match selector | `api-gateway-deployment.yaml` | Deployment rejected, no pods created | Aligned pod labels with selector (`api-gateway`) |
| 2 | Wrong container port (8080 vs 3000) | `api-gateway-deployment.yaml` | Probes fail, pods never ready | Changed to `containerPort: 3000` |
| 3 | Memory limit too low (64Mi) | `api-gateway-deployment.yaml` | OOMKill, CrashLoopBackOff | Raised limits to `256Mi` memory, `500m` CPU |
| 4 | Wrong Redis hostname (`redis-master`) | `user-service-deployment.yaml` | DNS failure, Redis unreachable | Changed to `redis` with full auth URL |
| 5 | `failureThreshold: 1` + wrong probe path | `user-service-deployment.yaml` | Constant unnecessary restarts | Set to `3`, fixed path, added startup probe |
| 6 | Service `targetPort: 8080` | `user-service-service.yaml` | All traffic fails with Connection refused | Changed to `targetPort: 3001` |
| 7 | Redis auth mismatch (no password in app) | `redis-deployment.yaml` | All Redis ops fail with NOAUTH | Password injected from Secret, URL includes auth |
| 8 | Credentials in plain text ConfigMap | `configmap.yaml` | Security risk, credentials exposed | Moved to Kubernetes Secrets |

> Full detailed analysis: [`docs/troubleshooting.md`](../../docs/troubleshooting.md)