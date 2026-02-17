# DevOps Challenge — Solution
This repository contains my solution for the VIP Medical DevOps Engineer Challenge.
The goal was to treat the platform as production infrastructure — focusing on reliability, automation, security, and observability rather than just making the application “work”.

**Author:** Alejandro De Mendoza  
**Branch:** main

**Time spent:** ~8-10 hours  
Most of the time was spent hardening the Kubernetes layer (NetworkPolicies, HPA behavior, probes configuration) and carefully analyzing the broken deployment to document the root causes properly.

---

## Solution Summary

This solution implements all five required parts of the challenge and includes several production-oriented improvements.

| Part | Status | Notes |
|------|--------|-------|
| Part 1: Containerization | Complete | Multi-stage, non-root, dumb-init, <200MB |
| Part 2: Kubernetes | Complete | Kustomize, HPA, NetworkPolicies, PDB (bonus) |
| Part 3: CI/CD | Complete | GitHub Actions, Trivy scanning (bonus), auto-rollback |
| Part 4: Monitoring | Complete | Prometheus metrics, structured logging, 5 alert rules |
| Part 5: Troubleshooting | Complete | 12 issues identified (8+ required) |
| Bonus: Security scanning | Trivy in CI/CD | SARIF upload to GitHub Security tab |
| Bonus: Pod Disruption Budgets | Complete | api-gateway and user-service PDBs |

---

## Quick Start

### Docker Compose (recommended for local dev)

```bash
docker-compose up -d
curl http://localhost:3000/health
curl http://localhost:3000/api/users
curl -X POST http://localhost:3000/api/users \
  -H "Content-Type: application/json" \
  -d '{"name":"John Doe","email":"john@example.com"}'
```

### Kubernetes (Docker Desktop)
This assumes Kubernetes is enabled in Docker Desktop.

```bash
# Verify cluster access
kubectl cluster-info

# Build local images
docker build -t devops-challenge/api-gateway:local ./apps/api-gateway
docker build -t devops-challenge/user-service:local ./apps/user-service

# Deploy development overlay
kubectl apply -k k8s/overlays/dev

# Expose API Gateway locally
kubectl port-forward svc/api-gateway 3000:3000 -n devops-challenge-dev

# Test
curl http://localhost:3000/health/ready
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
│   │   │   ├── index.js           # Express app with proxy, metrics, structured logging
│   │   │   └── index.test.js      # Jest tests
│   │   ├── package.json
│   │   ├── Dockerfile             # Multi-stage, non-root, dumb-init
│   │   └── .dockerignore
│   └── user-service/
│       ├── src/
│       │   ├── index.js           # Express CRUD app backed by Redis
│       │   └── index.test.js      # Jest tests with Redis mock
│       ├── package.json
│       ├── Dockerfile
│       └── .dockerignore
├── k8s/
│   ├── base/                      # Shared manifests
│   │   ├── kustomization.yaml
│   │   ├── configmap.yaml         # Non-sensitive config
│   │   ├── secret.yaml            # TEMPLATE ONLY — values from secrets manager
│   │   ├── *-deployment.yaml
│   │   ├── *-service.yaml
│   │   ├── hpa.yaml               # HPA for api-gateway and user-service
│   │   ├── network-policies.yaml  # Zero-trust pod-to-pod traffic
│   │   └── pdb.yaml               # Pod Disruption Budgets
│   ├── overlays/
│   │   ├── dev/                   # 1 replica, debug logs, local images
│   │   └── prod/                  # 3 replicas, PVC for Redis, secrets from ASM
│   └── broken/
│       └── deployment.yaml        # 12 intentional bugs — see docs/troubleshooting.md
├── .github/
│   └── workflows/
│       └── ci-cd.yml              # Full CI/CD: test → build → scan → deploy → notify
└── docs/
    ├── architecture.md            # Design decisions and trade-offs
    ├── monitoring-strategy.md     # Prometheus metrics, alerts, secrets management
    └── troubleshooting.md         # 12 bugs in broken/ analyzed and fixed

The Kubernetes manifests follow a base + overlay structure using Kustomize to separate environment concerns cleanly (dev vs prod).
```

---

## Key Design Decisions

**Why dumb-init?** Node.js running as PID 1 does not properly handle signal forwarding. Using dumb-init ensures graceful shutdowns during rolling deployments and avoids dropped in-flight requests.

**Why non-root containers?** Running as a non-root user reduces blast radius in case of container compromise and aligns with security best practices.

**Why `maxUnavailable: 0`?** Guarantees zero-downtime rolling deploys. New pods must pass readiness checks before old pods are terminated.

**Why separate liveness and readiness probes?** If Redis goes down, readiness fails (stop sending traffic) but liveness stays healthy (don't restart). Restarting the app won't fix a Redis outage.

**Why GitHub Container Registry?** Free, integrated with GitHub Actions via `GITHUB_TOKEN` (no extra secrets needed), and supports OCI image manifests with SBOM/provenance.

**Image tagging strategy:** `sha-<7chars>` for immutable deploy references + branch name tags for human-readable latest. Never deploying `latest` to production.

---

## What I Would Improve With More Time

1. **GitOps with ArgoCD** — declarative deploys, automatic drift detection, easy rollbacks via Git revert
2. **Redis HA** — Redis Sentinel or Cluster to eliminate the SPOF
3. **Integration tests in CI** — spin up a `kind` cluster and run full API tests before any merge
4. **Istio service mesh** — replace NetworkPolicies with mTLS for encrypted service-to-service communication
5. **KEDA** — scale to zero during off-hours for cost savings

---

## Assumptions Made

- The application runs in AWS EKS (Secrets Manager integration, EBS gp3 storage class)
- Slack webhook URL is available for deploy notifications
- HPA requires metrics-server to be installed and configured properly.
- CNI plugin supports NetworkPolicies (Calico/Cilium — not Flannel)
- Production Redis password is stored in AWS Secrets Manager at `devops-challenge/prod/redis-password`
