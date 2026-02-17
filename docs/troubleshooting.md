# Troubleshooting — Análisis del despliegue roto

**Archivo analizado:** `k8s/broken/deployment.yaml`  
**Problemas encontrados:** 12 (mínimo requerido: 8)

---

## Proceso de debugging

Antes de empezar a corregir cosas a ciegas, lo primero fue seguir un flujo básico de troubleshooting en Kubernetes. La idea es ir de lo más general a lo más concreto: primero ver qué rechaza el clúster, luego qué pods están corriendo (o no), y finalmente entender por qué.

```bash
# 1. Intentar aplicar el manifiesto y ver el error inicial
kubectl apply -f k8s/broken/deployment.yaml

# 2. Revisar qué recursos se llegaron a crear (si es que alguno)
kubectl get all -n production

# 3. Si el Deployment no levanta pods:
kubectl describe deployment api-gateway -n production

# 4. Si los pods están Pending o en CrashLoopBackOff:
kubectl describe pod <pod-name> -n production
kubectl logs <pod-name> -n production --previous

# 5. Ver si el Service realmente tiene endpoints
kubectl get endpoints api-gateway -n production

# 6. Revisar eventos del clúster (suelen dar las pistas más claras)
kubectl get events -n production --sort-by='.lastTimestamp'
```

---

## Problemas encontrados

### Issue 1 — Typo en el campo `kind`

El manifiesto tenía una `t` de más:

```yaml
kind: Deploymentt   # ← una "t" extra
```

Kubernetes no reconoce ese tipo de recurso y rechaza el manifiesto completo con un error del tipo `no matches for kind "Deploymentt"`. No se crea absolutamente nada. Es el primer error que salta con `kubectl apply` o cualquier validador como `kubeval`.

```yaml
# Corrección
kind: Deployment
```

---

### Issue 2 — `replicas: 0`

```yaml
replicas: 0
```

Un deployment con cero réplicas no ejecuta ningún pod. El servicio queda completamente caído desde el primer momento. En producción esto significa downtime total. `kubectl get deploy` lo habría mostrado como `READY 0/0` sin ningún pod asociado.

```yaml
# Corrección
replicas: 2   # mínimo razonable para alta disponibilidad
```

---

### Issue 3 — Labels del pod no coinciden con el selector

```yaml
selector:
  matchLabels:
    app: api-gateway

template:
  metadata:
    labels:
      app: backend   # ← no coincide con el selector
```

Kubernetes exige que el selector del Deployment coincida exactamente con los labels del template. Al no hacerlo, el manifiesto se rechaza directamente en el momento de aplicarlo.

```yaml
# Corrección
template:
  metadata:
    labels:
      app: api-gateway
```

---

### Issue 4 — Imagen sin registry

```yaml
image: api-gateway:latest
```

Sin un registry explícito, Kubernetes asume Docker Hub. Esa imagen no existe ahí, así que el pod se queda atascado en `ImagePullBackOff`. Además, usar `latest` en producción es una mala práctica: no hay forma de saber exactamente qué versión está corriendo ni de hacer rollback de forma fiable.

```yaml
# Corrección
image: ghcr.io/vipmed-technology/api-gateway:sha-abc1234
```

---

### Issue 5 — Puerto incorrecto (8080 vs 3000)

```yaml
containerPort: 8080   # la app escucha en 3000
targetPort: 8080
```

Las probes y el Service intentan conectarse al puerto 8080, pero la aplicación escucha en el 3000. El resultado es un `Connection refused` constante, pods que no pasan readiness y que Kubernetes reinicia una y otra vez.

```yaml
# Corrección
containerPort: 3000
targetPort: 3000
```

---

### Issue 6 — Nombre incorrecto del servicio upstream

```yaml
value: "http://userservice:3001"
```

El servicio real se llama `user-service`, con guión. Ese typo hace que el DNS interno de Kubernetes no resuelva el nombre y el gateway devuelva un `502` en todas las llamadas al User Service.

```yaml
# Corrección
value: "http://user-service:3001"
```

Se detecta fácilmente haciendo `nslookup userservice` desde dentro del clúster: devuelve `NXDOMAIN`.

---

### Issue 7 — Requests demasiado altos

```yaml
requests:
  cpu: "4000m"
  memory: "8Gi"
```

Con esos valores, el scheduler de Kubernetes casi nunca va a encontrar un nodo con suficientes recursos disponibles. Los pods se quedan eternamente en estado `Pending` sin llegar a arrancar jamás. `kubectl describe pod` lo confirmaría con `Insufficient cpu`.

```yaml
# Corrección
requests:
  cpu: "100m"
  memory: "128Mi"
```

---

### Issue 8 — Limit menor que el request

```yaml
requests:
  cpu: "4000m"
limits:
  cpu: "100m"
```

Kubernetes no permite que el límite sea inferior al request. Es una configuración directamente inválida que hace que el manifiesto sea rechazado en el momento de aplicarlo.

```yaml
# Corrección
requests:
  cpu: "100m"
  memory: "128Mi"
limits:
  cpu: "500m"
  memory: "256Mi"
```

---

### Issue 9 — Path incorrecto en la probe

```yaml
path: /healthz
```

La aplicación expone `/health/live`, no `/healthz`. La probe recibe un `404` en cada comprobación y Kubernetes reinicia el pod de forma continua aunque esté completamente sano. Esto genera un `CrashLoopBackOff` que no tiene nada que ver con la aplicación en sí.

```yaml
# Corrección
path: /health/live
port: 3000
```

---

### Issue 10 — Probes demasiado agresivas (`periodSeconds: 1`)

```yaml
periodSeconds: 1
```

Hacer un healthcheck cada segundo genera una cantidad innecesaria de requests, ensucia los logs y añade ruido a las métricas. En producción, un intervalo de 20 segundos con un timeout razonable es más que suficiente para detectar problemas reales sin penalizar el rendimiento.

```yaml
# Corrección
periodSeconds: 20
timeoutSeconds: 5
```

---

### Issue 11 — `failureThreshold: 1`

```yaml
failureThreshold: 1
```

Con este valor, un único fallo puntual (una pausa de GC, un pico de CPU momentáneo) ya provoca el reinicio del contenedor. En producción, lo habitual es tolerar al menos 3 fallos consecutivos antes de tomar cualquier acción. De lo contrario, se generan reinicios innecesarios que degradan el servicio sin que haya un problema real.

```yaml
# Corrección
failureThreshold: 3
```

---

### Issue 12 — Selector del Service no coincide con los labels

```yaml
# En el Service
selector:
  app: gateway

# En los pods
app: api-gateway
```

El Service no encuentra ningún pod porque el selector no coincide. El resultado es que no hay endpoints registrados y todo el tráfico falla. Se detecta inmediatamente con `kubectl get endpoints`, que devuelve `<none>`.

```yaml
# Corrección
selector:
  app: api-gateway
```

---

## Tabla resumen

| # | Problema | Impacto | Comando de detección |
|---|---|---|---|
| 1 | Typo en `kind` | Manifiesto rechazado | `kubectl apply` |
| 2 | `replicas: 0` | Sin pods corriendo | `kubectl get deploy` |
| 3 | Labels ≠ selector | Deployment inválido | `kubectl apply` |
| 4 | Imagen sin registry | `ImagePullBackOff` | `kubectl describe pod` |
| 5 | Puerto incorrecto | Probes fallan | `kubectl logs` |
| 6 | Servicio mal nombrado | DNS falla, 502 | `nslookup` |
| 7 | Requests excesivos | Pods en `Pending` | `kubectl describe pod` |
| 8 | Limit < request | Configuración inválida | `kubectl apply` |
| 9 | Path de probe incorrecto | `CrashLoopBackOff` | `kubectl describe pod` |
| 10 | Probes cada 1s | Overhead innecesario | Logs + métricas |
| 11 | Threshold demasiado bajo | Reinicios constantes | `kubectl get pods` |
| 12 | Selector del Service incorrecto | Sin endpoints | `kubectl get endpoints` |

---

## Herramientas utilizadas para el diagnóstico

```bash
# Validar sin aplicar cambios al clúster
kubectl apply --dry-run=client -f k8s/broken/deployment.yaml

# Análisis estático antes de aplicar
kubeval k8s/broken/deployment.yaml
kube-linter lint k8s/broken/

# Debug en runtime
kubectl get events --sort-by='.lastTimestamp' -n production
kubectl describe deployment api-gateway -n production
kubectl describe pod <pod-name> -n production
kubectl get endpoints -n production
kubectl top pods -n production
```