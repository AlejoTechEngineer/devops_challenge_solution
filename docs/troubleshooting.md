# Troubleshooting Report

**File analyzed:** `k8s/broken/deployment.yaml`  
**Issues found:** 12 (minimum required: 8)

---

## Debugging Process

Before fixing anything, the approach was to follow a structured flow from general to specific:

```bash
# 1. Apply the manifest and observe the initial error
kubectl apply -f k8s/broken/deployment.yaml

# 2. Check what resources were created (if any)
kubectl get all -n production

# 3. If the Deployment doesn't create pods:
kubectl describe deployment api-gateway -n production

# 4. If pods are Pending or in CrashLoopBackOff:
kubectl describe pod <pod-name> -n production
kubectl logs <pod-name> -n production --previous

# 5. Check if the Service actually has endpoints
kubectl get endpoints api-gateway -n production

# 6. Review cluster events (usually the clearest diagnostic signal)
kubectl get events -n production --sort-by='.lastTimestamp'
```

---

## Issues Found

### Issue 1

- **File:** `k8s/broken/deployment.yaml`
- **What is wrong:** Typo in the `kind` field — `Deploymentt` (extra `t`).
- **Why it causes a problem:** Kubernetes does not recognize `Deploymentt` as a valid resource type and rejects the entire manifest immediately with `no matches for kind "Deploymentt"`. Nothing gets created in the cluster.
- **How to fix it:**
```yaml
# Before
kind: Deploymentt

# After
kind: Deployment
```

---

### Issue 2

- **File:** `k8s/broken/deployment.yaml`
- **What is wrong:** `replicas: 0`
- **Why it causes a problem:** A Deployment with zero replicas runs no pods. The service is completely down from the start. `kubectl get deploy` shows `READY 0/0` with no pods associated.
- **How to fix it:**
```yaml
# Before
replicas: 0

# After
replicas: 2   # minimum for high availability
```

---

### Issue 3

- **File:** `k8s/broken/deployment.yaml`
- **What is wrong:** The pod template label `app: backend` does not match the selector `app: api-gateway`.
- **Why it causes a problem:** Kubernetes requires the Deployment selector to exactly match the pod template labels. When they don't match, the manifest is rejected at apply time with a validation error.
- **How to fix it:**
```yaml
# Before
template:
  metadata:
    labels:
      app: backend

# After
template:
  metadata:
    labels:
      app: api-gateway
```

---

### Issue 4

- **File:** `k8s/broken/deployment.yaml`
- **What is wrong:** Image specified without a registry: `image: api-gateway:latest`
- **Why it causes a problem:** Without an explicit registry, Kubernetes tries to pull from Docker Hub. That image does not exist there, so the pod stays stuck in `ImagePullBackOff`. Additionally, using `latest` in production makes rollbacks unreliable since there is no way to know exactly which version is running.
- **How to fix it:**
```yaml
# Before
image: api-gateway:latest

# After
image: ghcr.io/vipmed-technology/api-gateway:sha-abc1234
```

---

### Issue 5

- **File:** `k8s/broken/deployment.yaml`
- **What is wrong:** `containerPort: 8080` and `targetPort: 8080` — the application listens on port 3000.
- **Why it causes a problem:** Health check probes and the Service try to connect on port 8080, but the application is not listening there. This causes a constant `Connection refused`, pods never pass readiness, and Kubernetes keeps restarting them indefinitely.
- **How to fix it:**
```yaml
# Before
containerPort: 8080
targetPort: 8080

# After
containerPort: 3000
targetPort: 3000
```

---

### Issue 6

- **File:** `k8s/broken/deployment.yaml`
- **What is wrong:** `USER_SERVICE_URL: "http://userservice:3001"` — missing hyphen in the service name.
- **Why it causes a problem:** The actual Kubernetes Service is named `user-service`. Without the hyphen, Kubernetes DNS cannot resolve the name and returns `NXDOMAIN`. The api-gateway returns `502` on every call to the User Service. Detectable with `nslookup userservice` from inside the cluster.
- **How to fix it:**
```yaml
# Before
value: "http://userservice:3001"

# After
value: "http://user-service:3001"
```

---

### Issue 7

- **File:** `k8s/broken/deployment.yaml`
- **What is wrong:** Resource requests are absurdly high: `cpu: "4000m"` and `memory: "8Gi"`.
- **Why it causes a problem:** The Kubernetes scheduler cannot find a node with 4 CPUs and 8GB of RAM available for a single pod. Pods stay in `Pending` state indefinitely and never start. `kubectl describe pod` shows `Insufficient cpu`.
- **How to fix it:**
```yaml
# Before
requests:
  cpu: "4000m"
  memory: "8Gi"

# After
requests:
  cpu: "100m"
  memory: "128Mi"
```

---

### Issue 8

- **File:** `k8s/broken/deployment.yaml`
- **What is wrong:** Resource limit is lower than the request: `requests.cpu: "4000m"` vs `limits.cpu: "100m"`.
- **Why it causes a problem:** Kubernetes does not allow limits to be lower than requests. This is an invalid configuration that causes the manifest to be rejected immediately at apply time.
- **How to fix it:**
```yaml
# Before
requests:
  cpu: "4000m"
  memory: "8Gi"
limits:
  cpu: "100m"
  memory: "64Mi"

# After
requests:
  cpu: "100m"
  memory: "128Mi"
limits:
  cpu: "500m"
  memory: "256Mi"
```

---

### Issue 9

- **File:** `k8s/broken/deployment.yaml`
- **What is wrong:** Liveness probe uses `path: /healthz` and `port: 8080`.
- **Why it causes a problem:** The application exposes `/health/live` on port 3000, not `/healthz` on 8080. The probe gets a `404` on every check and Kubernetes continuously restarts the pod even though the application itself is perfectly healthy. This creates a `CrashLoopBackOff` with no real application error.
- **How to fix it:**
```yaml
# Before
livenessProbe:
  httpGet:
    path: /healthz
    port: 8080

# After
livenessProbe:
  httpGet:
    path: /health/live
    port: 3000
```

---

### Issue 10

- **File:** `k8s/broken/deployment.yaml`
- **What is wrong:** `periodSeconds: 1` — health check probe fires every second.
- **Why it causes a problem:** Probing every second generates unnecessary load, pollutes logs with probe requests, and adds noise to metrics. A standard production interval is 10-20 seconds, which is more than sufficient to detect real problems without the overhead.
- **How to fix it:**
```yaml
# Before
periodSeconds: 1

# After
periodSeconds: 20
timeoutSeconds: 5
```

---

### Issue 11

- **File:** `k8s/broken/deployment.yaml`
- **What is wrong:** `failureThreshold: 1`
- **Why it causes a problem:** A single probe failure immediately triggers a container restart. Transient issues like a GC pause, a momentary CPU spike, or a slow network response cause unnecessary restarts and service degradation. The standard is to tolerate at least 3 consecutive failures before taking action.
- **How to fix it:**
```yaml
# Before
failureThreshold: 1

# After
failureThreshold: 3
```

---

### Issue 12

- **File:** `k8s/broken/deployment.yaml`
- **What is wrong:** The Service selector uses `app: gateway` but the pod labels are `app: api-gateway`.
- **Why it causes a problem:** The Service cannot find any matching pods, so it has no endpoints. All traffic fails with a connection error. Detectable immediately with `kubectl get endpoints api-gateway -n production` which returns `<none>`.
- **How to fix it:**
```yaml
# Before
selector:
  app: gateway

# After
selector:
  app: api-gateway
```

---

## Summary Table

| # | Issue | Impact | Detection Command |
|---|-------|--------|-------------------|
| 1 | Typo in `kind` field | Manifest rejected entirely | `kubectl apply` |
| 2 | `replicas: 0` | No pods running, full downtime | `kubectl get deploy` |
| 3 | Pod labels ≠ selector | Deployment invalid, rejected | `kubectl apply` |
| 4 | Image without registry | `ImagePullBackOff` | `kubectl describe pod` |
| 5 | Wrong container port (8080 vs 3000) | Probes fail, constant restarts | `kubectl logs` |
| 6 | Upstream service name typo | DNS failure, 502 errors | `nslookup userservice` |
| 7 | Requests too high (4000m CPU, 8Gi RAM) | Pods stuck in `Pending` | `kubectl describe pod` |
| 8 | Limit lower than request | Invalid config, rejected | `kubectl apply` |
| 9 | Wrong probe path (`/healthz`) | `CrashLoopBackOff` | `kubectl describe pod` |
| 10 | `periodSeconds: 1` | Unnecessary overhead and log noise | Logs + metrics |
| 11 | `failureThreshold: 1` | Constant unnecessary restarts | `kubectl get pods` |
| 12 | Service selector mismatch | No endpoints, all traffic fails | `kubectl get endpoints` |

---

## Tools Used for Diagnosis

```bash
# Validate without applying changes to the cluster
kubectl apply --dry-run=client -f k8s/broken/deployment.yaml

# Static analysis before applying
kubeval k8s/broken/deployment.yaml
kube-linter lint k8s/broken/

# Runtime debugging
kubectl get events --sort-by='.lastTimestamp' -n production
kubectl describe deployment api-gateway -n production
kubectl describe pod <pod-name> -n production
kubectl get endpoints -n production
kubectl top pods -n production
```