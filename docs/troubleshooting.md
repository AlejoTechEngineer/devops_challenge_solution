# Troubleshooting — Broken Deployment Analysis

**File analyzed:** `k8s/broken/deployment.yaml`  
**Issues found:** 12 (minimum required: 8)

---

## Debugging Process

Before jumping to fixes, here's how I approached this systematically:

```bash
# 1. Try to apply and read the error
kubectl apply -f k8s/broken/deployment.yaml

# 2. Check what actually got created
kubectl get all -n production

# 3. For deployments with 0 pods:
kubectl describe deployment api-gateway -n production

# 4. For pods stuck in Pending/CrashLoopBackOff:
kubectl describe pod <pod-name> -n production
kubectl logs <pod-name> -n production --previous

# 5. Check service endpoints (is traffic actually routing?)
kubectl get endpoints api-gateway -n production

# 6. Check events for scheduling failures
kubectl get events -n production --sort-by='.lastTimestamp'
```

---

## Issues Found

---

### Issue 1 — Typo in `kind` field

**What is wrong:**
```yaml
kind: Deploymentt   # ← extra 't'
```

**Why it causes a problem:**  
Kubernetes API server will reject this manifest with `no matches for kind "Deploymentt"`. The entire deployment fails to apply — nothing gets created.

**How to fix:**
```yaml
kind: Deployment
```

**Detection:** `kubectl apply` immediately returns a validation error. Also caught by `kubectl dry-run=client` or any YAML linter (`kubeval`, `kube-linter`).

---

### Issue 2 — `replicas: 0`

**What is wrong:**
```yaml
replicas: 0
```

**Why it causes a problem:**  
A deployment with 0 replicas intentionally runs no pods. The service will have no endpoints and all traffic returns `503 Service Unavailable`. This can be intentional for "paused" deployments, but in production it means the application is completely down.

**How to fix:**
```yaml
replicas: 2   # At least 2 for high availability
```

**Detection:** `kubectl get deployment api-gateway` would show `READY 0/0`. No pods visible in `kubectl get pods`.

---

### Issue 3 — Pod label doesn't match selector

**What is wrong:**
```yaml
# Selector expects:
selector:
  matchLabels:
    app: api-gateway

# But pod template has:
template:
  metadata:
    labels:
      app: backend    # ← mismatch
```

**Why it causes a problem:**  
Kubernetes rejects this at apply time: `selector does not match template labels`. Even if it were created, the Deployment controller couldn't track its own pods, leading to infinite pod creation loops.

**How to fix:**
```yaml
template:
  metadata:
    labels:
      app: api-gateway   # Must match selector exactly
```

**Detection:** `kubectl apply` returns an immutable field validation error.

---

### Issue 4 — Image has no registry prefix

**What is wrong:**
```yaml
image: api-gateway:latest
```

**Why it causes a problem:**  
Without a fully qualified registry (e.g., `ghcr.io/org/api-gateway:latest`), Kubernetes defaults to Docker Hub. In most EKS/GKE production clusters, the image `api-gateway` doesn't exist on Docker Hub. The pod will be stuck in `ImagePullBackOff` permanently.

**How to fix:**
```yaml
image: ghcr.io/vipmed-technology/api-gateway:sha-abc1234
```

**Detection:** `kubectl describe pod <name>` shows `Failed to pull image "api-gateway:latest": ... not found`.

---

### Issue 5 — Wrong container port (8080 vs 3000)

**What is wrong:**
```yaml
ports:
  - containerPort: 8080   # ← App listens on 3000

# And in the Service:
targetPort: 8080           # ← Also wrong
```

**Why it causes a problem:**  
The application listens on port 3000. Health probes hitting port 8080 will get `Connection refused`, causing all pods to fail their liveness/readiness checks and restart continuously. Traffic from the Service is routed to port 8080, which is not listening.

**How to fix:**
```yaml
# In Deployment:
ports:
  - containerPort: 3000

# In Service:
targetPort: 3000
```

**Detection:** Pods in `CrashLoopBackOff` or `Running` but `0/1 READY`. `kubectl logs` shows normal startup but probes fail.

---

### Issue 6 — Wrong upstream service name

**What is wrong:**
```yaml
env:
  - name: USER_SERVICE_URL
    value: "http://userservice:3001"   # ← Missing hyphen
```

**Why it causes a problem:**  
Kubernetes DNS resolves service names as `<service-name>.<namespace>.svc.cluster.local`. The actual service is named `user-service` (with a hyphen). DNS resolution for `userservice` fails, so all requests to the user service return `ENOTFOUND` errors.

**How to fix:**
```yaml
value: "http://user-service:3001"
```

**Detection:** App starts, but `GET /api/users` returns 502. `kubectl exec` into the pod and `nslookup userservice` returns `NXDOMAIN`.

---

### Issue 7 — Resource requests are unreasonably high

**What is wrong:**
```yaml
resources:
  requests:
    cpu: "4000m"    # ← 4 full CPU cores per pod
    memory: "8Gi"   # ← 8 GB RAM per pod
```

**Why it causes a problem:**  
Requests affect scheduling — Kubernetes will only schedule a pod on a node that has 4 free CPU cores and 8 GB free memory. Most nodes in a standard cluster don't have this available. Pods stay in `Pending` indefinitely with `Insufficient cpu` events.

**How to fix:**
```yaml
resources:
  requests:
    cpu: "100m"     # 0.1 CPU cores is appropriate for this Node.js app
    memory: "128Mi"
```

**Detection:** `kubectl get pods` shows `Pending`. `kubectl describe pod` shows `0/N nodes are available: N Insufficient cpu`.

---

### Issue 8 — Resource limit is lower than request

**What is wrong:**
```yaml
resources:
  requests:
    cpu: "4000m"
  limits:
    cpu: "100m"    # ← limit < request — invalid
```

**Why it causes a problem:**  
Kubernetes requires `limits >= requests`. This is an invalid configuration that causes `kubectl apply` to fail with validation error: `Invalid value: "100m": must be greater than or equal to cpu request`. Even if it passed, a pod that requests 4 CPU but is limited to 0.1 CPU would be throttled to nearly zero actual execution.

**How to fix:**
```yaml
resources:
  requests:
    cpu: "100m"
    memory: "128Mi"
  limits:
    cpu: "500m"
    memory: "256Mi"
```

---

### Issue 9 — Health probe hits wrong path

**What is wrong:**
```yaml
livenessProbe:
  httpGet:
    path: /healthz      # ← App exposes /health/live, not /healthz
    port: 8080          # ← Wrong port (see Issue 5)
```

**Why it causes a problem:**  
The app exposes `/health/live` and `/health/ready`. A probe hitting `/healthz` gets a 404 response, which Kubernetes treats as probe failure. After `failureThreshold` failures, Kubernetes restarts the container — leading to a crash loop even though the app itself is healthy.

**How to fix:**
```yaml
livenessProbe:
  httpGet:
    path: /health/live
    port: 3000
readinessProbe:
  httpGet:
    path: /health/ready
    port: 3000
```

---

### Issue 10 — Probe fires every 1 second (`periodSeconds: 1`)

**What is wrong:**
```yaml
livenessProbe:
  periodSeconds: 1    # ← Extremely aggressive
```

**Why it causes a problem:**  
A 1-second probe interval generates 60 health check requests per minute per pod. Under load, these health checks compete with real traffic for CPU/memory, potentially slowing the app enough that the health check itself starts failing — a self-fulfilling death spiral. It also generates excessive logs and inflates HTTP metrics.

**How to fix:**
```yaml
livenessProbe:
  periodSeconds: 20     # Every 20s is standard
  timeoutSeconds: 5
readinessProbe:
  periodSeconds: 10     # Readiness can be more frequent but still reasonable
  timeoutSeconds: 3
```

---

### Issue 11 — `failureThreshold: 1`

**What is wrong:**
```yaml
livenessProbe:
  failureThreshold: 1   # ← Single failure triggers container restart
```

**Why it causes a problem:**  
A single transient probe failure (network hiccup, brief CPU spike, momentary GC pause) immediately kills and restarts the container. This causes unnecessary downtime and can cascade into a restart loop that triggers PodDisruptionBudget violations. Production apps should tolerate at least 3 consecutive failures before restart.

**How to fix:**
```yaml
livenessProbe:
  failureThreshold: 3   # 3 × 20s = 60s of tolerance before restart
```

---

### Issue 12 — Service selector doesn't match pod labels

**What is wrong:**
```yaml
# Service selector:
spec:
  selector:
    app: gateway          # ← "gateway"

# Pods have label:
labels:
  app: api-gateway        # ← "api-gateway"
```

**Why it causes a problem:**  
The Service has no matching pods — `kubectl get endpoints api-gateway` shows `<none>`. All traffic to the Service gets no response. This is one of the most common Kubernetes gotchas: the service appears to be running but receives zero traffic.

**How to fix:**
```yaml
spec:
  selector:
    app: api-gateway     # Must exactly match pod template labels
```

**Detection:** `kubectl get endpoints api-gateway -n production` shows empty endpoints. `kubectl describe service api-gateway` shows `Endpoints: <none>`.

---

## Summary Table

| # | Issue | Impact | Detection Command |
|---|-------|--------|-------------------|
| 1 | Typo in `kind: Deploymentt` | Manifest rejected entirely | `kubectl apply` error |
| 2 | `replicas: 0` | No pods, no traffic | `kubectl get deploy` |
| 3 | Pod label ≠ selector | Manifest rejected | `kubectl apply` error |
| 4 | No registry in image name | `ImagePullBackOff` | `kubectl describe pod` |
| 5 | Wrong container port (8080 vs 3000) | Connection refused on probes | `kubectl logs`, probe failures |
| 6 | Wrong service name `userservice` | DNS failure, 502 errors | `kubectl exec` + nslookup |
| 7 | CPU request 4000m | Pods stuck Pending | `kubectl describe pod` events |
| 8 | Limit < request | Manifest rejected | `kubectl apply` validation |
| 9 | Probe path `/healthz` (404) | CrashLoopBackOff | `kubectl describe pod` |
| 10 | `periodSeconds: 1` | Self-DoS, performance degradation | Metrics, logs |
| 11 | `failureThreshold: 1` | Constant restarts on any hiccup | `kubectl get pods` restart count |
| 12 | Service selector `gateway` ≠ `api-gateway` | No endpoints, 503 | `kubectl get endpoints` |

---

## Tools Used for Diagnosis

```bash
# Validate manifests without applying
kubectl apply --dry-run=client -f k8s/broken/deployment.yaml

# Static analysis
kubeval k8s/broken/deployment.yaml
kube-linter lint k8s/broken/

# Runtime debugging
kubectl get events --sort-by='.lastTimestamp' -n production
kubectl describe deployment api-gateway -n production
kubectl describe pod <pod-name> -n production
kubectl get endpoints -n production
kubectl top pods -n production
```
