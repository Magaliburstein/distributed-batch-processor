# Tapi Batch System

Sistema de procesamiento batch que consume hasta 1 millón de registros diarios desde una tabla relacional, distribuyendo la carga de llamadas HTTP a la API interna de Tapi a lo largo de 22 horas. Cada proveedor recibe su propio canal de procesamiento (cola SQS + Lambda worker) con concurrencia reservada 1, garantizando orden y evitando sobrecarga a la API. El 2-hour buffer al final del día es el margen de reintentos antes del siguiente ciclo.

El sistema se diseñó para ser determinista y observable: cada registro queda persistido en DynamoDB con su resultado (SUCCESS / RETRY / FATAL), idempotency key y número de intento. La clasificación de errores es configurable por proveedor en la tabla `configuracion_proveedores`, permitiendo ajustar qué status codes son retriables o fatales sin tocar código.

La infraestructura es completamente reproducible via CDK y se despliega en dos ambientes (QA y producción) con autenticación OIDC a AWS desde GitHub Actions, sin credenciales de larga duración almacenadas en el repositorio.

---

## Flujo de ejecución

```text
EventBridge Scheduler (cron 00:00 UTC)
         │
         ▼
Lambda Orquestadora (tapi-orchestrator-{env})
  │  SELECT proveedor, COUNT(*) FROM registros GROUP BY proveedor
  │  Ordena por volumen DESC
  │  Calcula timestamps proporcionales en ventana de 22h
  │
  ├─► EventBridge Schedule → tapi-paginator-providerA-YYYY-MM-DD (at 00:00)
  ├─► EventBridge Schedule → tapi-paginator-providerB-YYYY-MM-DD (at 08:48)
  └─► EventBridge Schedule → tapi-paginator-providerC-YYYY-MM-DD (at 17:36)
              │ (DeleteAfterCompletion = true)
              ▼
  Lambda Paginadora (tapi-paginator-{env})
    │  SELECT * WHERE proveedor = X ORDER BY id_registro LIMIT 1000  [keyset pagination]
    │  SendMessageBatch → SQS (10 msgs/call)
    └─► SQS Queue (tapi-queue-{proveedor}-{env}, permanente)
              │
              ▼
  Lambda Worker (tapi-worker-{proveedor}-{env}, reservedConcurrency=1)
    │  Llama a API interna (POST, 30s timeout, X-Idempotency-Key: id#YYYY-MM-DD)
    │  Clasifica respuesta: SUCCESS / RETRY / FATAL
    │  Guarda en DynamoDB (PK: proveedor#id_registro, SK: timestamp)
    │
    ├─ SUCCESS/FATAL → retorna OK → SQS elimina el mensaje
    └─ RETRY → ChangeMessageVisibility (30s/120s/480s) → lanza error
              │
              ▼ (tras 4 recepciones)
  SQS DLQ (tapi-dlq-{proveedor}-{env})
    └─► CloudWatch Alarm → SNS → Email de alerta

DynamoDB: tapi-resultados-{env}      (PK: proveedor#id_registro, SK: timestamp_ejecucion)
DynamoDB: tapi-configuracion-proveedores-{env}  (PK: proveedor)
```

---

## Setup local con LocalStack

### Prerequisitos

```bash
npm install
pip install localstack awscli-local
```

### Levantar LocalStack

```bash
localstack start -d
```

### Crear recursos locales

```bash
# DynamoDB
awslocal dynamodb create-table \
  --table-name tapi-resultados-dev \
  --attribute-definitions \
    AttributeName=pk,AttributeType=S \
    AttributeName=sk,AttributeType=S \
  --key-schema AttributeName=pk,KeyType=HASH AttributeName=sk,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST

awslocal dynamodb create-table \
  --table-name tapi-configuracion-proveedores-dev \
  --attribute-definitions AttributeName=proveedor,AttributeType=S \
  --key-schema AttributeName=proveedor,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST

# SQS (una por proveedor)
awslocal sqs create-queue --queue-name tapi-queue-providerA-dev
awslocal sqs create-queue --queue-name tapi-dlq-providerA-dev
```

### Correr tests

```bash
# Unit tests
npm test

# Integration tests contra LocalStack
AWS_ENDPOINT_URL=http://localhost:4566 npm run test:integration
```

---

## Comandos de deploy

### QA (automático en merge a develop)

```bash
npm run cdk:deploy:qa
# Equivalente a:
cdk deploy --all \
  --context environment=qa \
  --context providers=providerA,providerB,providerC \
  --context apiEndpoint=https://api-qa.tapi.internal/process \
  --context alertEmail=dev@tapi.com \
  --require-approval never
```

### Producción (manual con aprobación en GitHub)

Via GitHub Actions → **Actions → Deploy → Run workflow → environment: prod**

O desde CLI (requiere credenciales de prod):

```bash
npm run cdk:deploy:prod -- \
  --context providers=providerA,providerB,providerC \
  --context apiEndpoint=https://api.tapi.internal/process \
  --context alertEmail=ops@tapi.com
```

### CDK Diff antes de deploy

```bash
cdk diff --all --context environment=prod
```

---

## Descripción de los stacks CDK

### `stack-persistencia`

Crea las dos tablas DynamoDB:

- **`tapi-resultados-{env}`** — historial de ejecuciones. PK `proveedor#id_registro` (evita hot partitions distribuyendo escrituras por proveedor), SK `timestamp_ejecucion` (permite ver todos los intentos de un mismo registro). PITR habilitado en prod.
- **`tapi-configuracion-proveedores-{env}`** — override de clasificación de errores por proveedor. Siempre con `RemovalPolicy.RETAIN`.

### `stack-workers`

Por cada proveedor en el contexto `providers` crea:

- **SQS Queue** (`tapi-queue-{proveedor}-{env}`) — permanente, visibility timeout 600s, `maxReceiveCount=4` (3 reintentos + DLQ).
- **SQS DLQ** (`tapi-dlq-{proveedor}-{env}`) — retención 14 días.
- **Lambda Worker** (`tapi-worker-{proveedor}-{env}`) — `reservedConcurrentExecutions=1`, batchSize SQS=1, timeout 60s.

También crea la **Lambda Paginadora** (`tapi-paginator-{env}`) compartida entre todos los proveedores, con timeout de 15 min.

### `stack-orchestration`

Crea la **Lambda Orquestadora** (`tapi-orchestrator-{env}`) con permisos IAM mínimos:

- `scheduler:CreateSchedule / DeleteSchedule / GetSchedule / ListSchedules` en el grupo `tapi-batch-{env}`.
- `iam:PassRole` para delegar el rol de ejecución al Scheduler.

También crea el **ScheduleGroup** de EventBridge y el **rol de ejecución del Scheduler** (asume `scheduler.amazonaws.com`, invoca la Lambda paginadora).

### `stack-trigger`

Crea el **EventBridge Scheduler** (`tapi-nightly-{env}`) con cron `0 0 * * ? *` (medianoche UTC) que invoca el orquestador. Configura retry policy: 3 intentos, hasta 1h de edad del evento.

### `stack-observabilidad`

Crea por cada proveedor:

- Alarma **DLQ con mensajes** — dispara si hay ≥1 mensaje visible en el DLQ.
- Alarma **Worker error rate > 5%** — evaluada cada 15 min durante 2 períodos.

Alarmas globales:

- **Orquestador no invocado** en últimas 26h (detecta fallo del trigger).
- **Orquestador con errores**.

Todo conectado a un **SNS Topic** con suscripción por email y un **CloudWatch Dashboard** consolidado.

---

## Agregar un nuevo proveedor

> **Trade-off arquitectónico:** la infraestructura estática (colas SQS, Lambda workers) se crea
> en tiempo de deploy vía CDK, no en tiempo de ejecución. CDK no puede consultar la base de datos
> para descubrir proveedores dinámicamente — corre antes de que haya datos. Por eso los proveedores
> deben declararse explícitamente al deployar. Este trade-off se eligió sobre la alternativa
> (que la Lambda orquestadora cree colas y Lambdas en runtime vía SDK) porque esa alternativa
> requiere permisos IAM muy amplios (`lambda:CreateFunction`) y aumenta la complejidad operacional.

Cuando se incorpora un proveedor nuevo a la tabla de registros:

1. **Agregar el proveedor a la tabla de registros** en la base de datos de origen.

2. **Actualizar el parámetro `providers`** en el deploy incluyendo el nuevo proveedor:

   ```bash
   # QA
   cdk deploy --all \
     --context environment=qa \
     --context providers=providerA,providerB,providerC,providerNuevo

   # Producción (vía GitHub Actions → workflow_dispatch → providers)
   # o desde CLI:
   npm run cdk:deploy:prod -- --context providers=providerA,providerB,providerC,providerNuevo
   ```

3. **CDK crea automáticamente** la nueva SQS queue, DLQ, Lambda worker y alarmas de CloudWatch
   para el proveedor nuevo. La Lambda orquestadora lo descubrirá en la próxima ejecución nocturna
   y le creará su EventBridge Schedule dinámico.

> **Nota:** los recursos de proveedores eliminados no se borran automáticamente al quitarlos del
> parámetro (CDK los deja huérfanos). Para eliminarlos, removerlos del parámetro y correr
> `cdk deploy`; si el recurso tenía datos en la DLQ, vaciarla primero.

---

## Variables de contexto CDK

| Variable | Descripción | Default |
| --- | --- | --- |
| `environment` | Sufijo de todos los recursos (`qa`, `prod`) | `dev` |
| `providers` | Lista de proveedores separada por comas | `providerA,providerB,providerC` |
| `apiEndpoint` | URL del endpoint de la API interna de Tapi | `https://api.tapi.internal/process` |
| `alertEmail` | Email para recibir alertas de CloudWatch | `alertas@tapi.com` |
| `databaseUrl` | Connection string de la base de datos de registros (requerido) | — |

## GitHub Actions — setup OIDC

1. Crear un IAM Identity Provider en AWS para GitHub Actions (OIDC).
2. Crear roles `tapi-deploy-qa` y `tapi-deploy-prod` con trust policy hacia el repo.
3. En GitHub → Settings → Environments → crear `qa` y `prod`.
4. Para `prod`, agregar **Required reviewers** (aprobación manual).
5. En cada environment, agregar variables:
   - `AWS_ROLE_ARN_QA` / `AWS_ROLE_ARN_PROD`
   - `AWS_ACCOUNT_ID`
   - `AWS_REGION`
