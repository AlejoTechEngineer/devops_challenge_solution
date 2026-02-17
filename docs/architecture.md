# Documentación de Arquitectura

## Descripción general del sistema

La arquitectura es bastante directa: un API Gateway recibe todo el tráfico externo y lo redirige al User Service. El User Service gestiona toda la lógica relacionada con usuarios y utiliza Redis como almacenamiento. Todo corre dentro de un clúster de Kubernetes y se monitorea con Prometheus.

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

---

## Responsabilidades de cada servicio

### API Gateway (puerto 3000)

El gateway es el punto de entrada único al sistema. Todo el tráfico externo pasa por aquí antes de llegar a cualquier otro servicio.

Se encarga de recibir todo el tráfico externo, redirigir las rutas `/api/users/*` al User Service y añadir trazabilidad a cada request mediante el header `X-Request-ID`. También expone los endpoints `/health/live`, `/health/ready` y `/metrics`.

Al no guardar estado, se puede escalar horizontalmente sin ningún problema ni coordinación adicional.

---

### User Service (puerto 3001)

Este servicio es el núcleo de la lógica de negocio. Se encarga de todo lo relacionado con usuarios: implementa el CRUD completo y usa Redis como capa de almacenamiento.

Expone los endpoints `/health/live`, `/health/ready` (que verifica activamente la conexión a Redis) y `/metrics`.

La aplicación en sí es stateless; son los datos en Redis los que persisten entre reinicios.

---

### Redis (puerto 6379)

Redis actúa como base de datos principal en forma de almacenamiento clave-valor simple.

Las claves siguen el formato `user:<uuid>`, y se mantiene un índice global en `users:index`, que es un set con todos los IDs existentes. Tiene autenticación por contraseña habilitada y usa la política `allkeys-lru` para gestionar la presión de memoria cuando el espacio es limitado.

---

## Decisiones de diseño

### ¿Por qué Redis en lugar de PostgreSQL?

Para este proyecto, Redis es más que suficiente. Es extremadamente rápido, fácil de operar y se adapta perfectamente a un CRUD simple como el que se necesita aquí.

El trade-off es claro: no soporta queries complejas ni relaciones entre entidades. En un entorno real donde se necesiten búsquedas avanzadas o joins, usaría PostgreSQL como base de datos principal y Redis como caché por encima.

---

### ¿Por qué contenedores sin root?

Ejecutar procesos como root dentro de un contenedor es una mala práctica de seguridad. Si el contenedor se ve comprometido de alguna forma, tener privilegios de root amplifica considerablemente el impacto potencial.

Por eso se usa un usuario sin privilegios con `uid: 1001` y se deshabilita explícitamente la escalación de privilegios en el security context del pod.

---

### ¿Por qué `dumb-init` como PID 1?

Node.js no está diseñado para ser PID 1 dentro de un contenedor. Cuando Kubernetes envía una señal `SIGTERM` para apagar un pod, el proceso en PID 1 es el responsable de reenviar esa señal correctamente al resto del árbol de procesos. Si no lo hace, los procesos hijos pueden quedar huérfanos y el shutdown no se completa de forma limpia.

`dumb-init` resuelve exactamente esto: actúa como un init mínimo que gestiona las señales correctamente y garantiza que el apagado sea ordenado.

---

### ¿Por qué `maxUnavailable: 0` en el RollingUpdate?

Con `maxUnavailable: 0`, Kubernetes primero levanta el nuevo pod antes de eliminar el antiguo. Esto garantiza cero downtime durante cualquier despliegue, aunque implique consumir capacidad extra de forma temporal mediante `maxSurge: 1`.

Es un trade-off consciente: prefiero pagar un poco más de recursos puntualmente a arriesgar que el servicio quede momentáneamente sin réplicas disponibles durante una actualización.

---

### ¿Por qué probes de liveness y readiness separadas?

Son conceptos distintos que no deben mezclarse.

El probe de **liveness** (`/health/live`) solo verifica que el proceso está vivo. Si falla, Kubernetes reinicia el pod.

El probe de **readiness** (`/health/ready`) verifica si el pod está en condiciones de recibir tráfico. Si Redis cae, este probe devuelve error y el pod deja de recibir requests, pero no se reinicia.

La razón es simple: si Redis está temporalmente caído, reiniciar el pod no soluciona nada. Lo correcto es sacarlo de la rotación hasta que Redis vuelva, y eso es exactamente lo que hace el readiness probe.

---

### Gestión de secretos

En producción, la solución correcta es usar **AWS Secrets Manager** junto con el **External Secrets Operator**. Los secretos no deberían vivir nunca en el repositorio.

Los manifiestos que se incluyen en este proyecto son plantillas. Los valores reales se inyectan desde el pipeline de CI/CD en el momento del despliegue.

---

## Qué mejoraría con más tiempo

Con más tiempo, estas son las áreas en las que me enfocaría:

1. Implementar **GitOps con ArgoCD** en lugar de aplicar manifiestos con `kubectl apply` directamente.
2. Alta disponibilidad para Redis usando **Sentinel o Redis Cluster**.
3. Un **Ingress Controller real** (NGINX o ALB) en lugar de exponer servicios directamente.
4. Un **Service Mesh con Istio** para mTLS entre servicios y control de tráfico avanzado.
5. **Tests de integración completos en CI** usando `kind` para validar el stack completo en cada PR.
6. Escalado basado en eventos con **KEDA** para reducir costos en periodos de baja carga.

---

## Arranque rápido en local

### Opción 1 — Docker Compose

```bash
docker-compose up -d

curl http://localhost:3000/health

curl -X POST http://localhost:3000/api/users \
  -H "Content-Type: application/json" \
  -d '{"name":"John","email":"john@example.com"}'
```

### Opción 2 — kind (Kubernetes en local)

```bash
# Crear el clúster
kind create cluster --name devops-challenge

# Construir las imágenes
docker build -t devops-challenge/api-gateway:local ./apps/api-gateway
docker build -t devops-challenge/user-service:local ./apps/user-service

# Cargarlas en el clúster
kind load docker-image devops-challenge/api-gateway:local --name devops-challenge
kind load docker-image devops-challenge/user-service:local --name devops-challenge

# Desplegar y exponer el servicio
kubectl apply -k k8s/overlays/dev
kubectl port-forward svc/api-gateway 3000:3000 -n devops-challenge-dev
```