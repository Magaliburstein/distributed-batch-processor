> **Última actualización:** 2026-05-26
> **Autor:** Magali Burstein
> **Versión del sistema:** v1

---

# Contexto del sistema — Batch Processor

## Por qué existe este sistema

Este sistema procesa 1 millón de registros diarios desde una tabla de base de datos, realizando un llamado HTTP a la API interna de Tapi por cada registro. La carga se distribuye a lo largo de 22 horas, dejando 2 horas de buffer al final del día para reintentos.

El objetivo principal no es solo que funcione — es que **termine dentro del día**. Si un ciclo no termina antes de medianoche, el siguiente arranca con deuda y el atraso se acumula indefinidamente.

---

## Decisiones de diseño que no son obvias

### Una cola SQS y una Lambda worker por proveedor

La serialización estricta por proveedor es un requerimiento de negocio. Se implementa como propiedad de infraestructura (`reservedConcurrentExecutions: 1` por worker) y no como lógica de código, lo que elimina la necesidad de locks, TTLs y race conditions.

### Los proveedores se declaran en el deploy, no se descubren dinámicamente

CDK sintetiza infraestructura estática antes del deploy y no puede consultar la base de datos en ese momento. La alternativa — que la Lambda orquestadora cree colas y Lambdas en runtime — requeriría permisos IAM muy amplios como `lambda:CreateFunction`. Ver [Agregar un proveedor nuevo](#cómo-agregar-un-proveedor-nuevo).

### DynamoDB para resultados y no RDS

El `response_body` de la API puede variar en estructura por proveedor, por lo que el schema flexible de DynamoDB es ideal. Además, Lambda abre y cierra conexiones constantemente — con RDS necesitarías RDS Proxy para evitar agotar el connection pool.

### Partition key `proveedor#id_registro` y no solo `id_registro`

Si los IDs son secuenciales, todas las escrituras irían a las mismas particiones internas de DynamoDB generando un hot partition que degrada el throughput de escritura. El prefijo del proveedor distribuye las escrituras uniformemente.

### Distribución temporal proporcional al volumen

Un proveedor con 900K registros necesita mucho más tiempo que uno con 1.000. Los proveedores de mayor volumen arrancan primero para tener todo el día disponible. La distribución es proporcional al volumen: si un proveedor tiene el 70% de los registros, su paginadora arranca al inicio de la ventana de 22 horas; el resto de los proveedores se distribuyen a partir de ese punto.

### Backoff 30s / 120s / 480s

Cubre el tiempo de recuperación de errores transitorios típicos sin saturar la API mientras se recupera. Los 429 tienen un cooldown mínimo de 60 segundos independientemente del intento.

---

## Cómo agregar un proveedor nuevo

1. Agregar el proveedor a la tabla de registros en la base de datos.
2. Actualizar el parámetro `providers` en el deploy incluyendo el nuevo proveedor.
3. Correr `cdk deploy` — CDK crea automáticamente la cola `tapi-queue-{proveedor}-{env}`, su DLQ `tapi-dlq-{proveedor}-{env}`, la Lambda worker `tapi-worker-{proveedor}-{env}` y las alarmas de CloudWatch correspondientes.
4. La Lambda orquestadora lo descubrirá en la próxima ejecución nocturna y creará su EventBridge Schedule dinámico bajo el grupo `tapi-batch-{env}`.

> **Nota:** los recursos de proveedores eliminados no se borran automáticamente. Para eliminarlos, removerlos del parámetro `providers` y correr `cdk deploy`. Si el DLQ tiene mensajes, vaciarlo primero.

---

## Cómo funciona el manejo de errores

La clasificación base es por HTTP status code:

| Clasificación | Status codes |
|---|---|
| **RETRY** | Timeout, error de red, `429`, `500`, `502`, `503`, `504` |
| **FATAL** | `400`, `401`, `403`, `404`, `422` |
| **RETRY con cooldown** | `429` → mínimo 60s de espera antes del próximo intento |

La tabla `tapi-configuracion-proveedores-{env}` en DynamoDB permite sobreescribir esta clasificación por proveedor sin tocar código ni hacer redeploy. Ejemplo: marcar el `503` como `FATAL` para un proveedor específico que no debería reintentarse.

Después de 3 reintentos el mensaje va al DLQ `tapi-dlq-{proveedor}-{env}` y dispara una alarma de CloudWatch via el SNS topic `tapi-alertas-{env}`.

---

## Qué pasa si algo falla

| Componente | Qué hacer |
|---|---|
| EventBridge no disparó | Invocar manualmente la Lambda `tapi-orchestrator-{env}` desde la consola o CLI |
| Lambda orquestadora falló | Revisar logs en CloudWatch, corregir el error, re-ejecutar manualmente |
| Un proveedor no se procesó | Revisar el schedule en el grupo `tapi-batch-{env}` de EventBridge Scheduler. Re-ejecutar la Lambda `tapi-paginator-{env}` manualmente con payload: `{ "proveedor": "X", "sqsQueueUrl": "https://sqs.{region}.amazonaws.com/{account}/tapi-queue-X-{env}", "batchDate": "YYYY-MM-DD" }` |
| Hay mensajes en DLQ | Revisar CloudWatch Logs de `tapi-worker-{proveedor}-{env}`. Corregir el problema. Mover mensajes del DLQ a la cola principal manualmente desde la consola de SQS |
| Sistema atrasado a las 12:00 | Revisar la métrica `ApproximateNumberOfMessagesVisible` por cola en CloudWatch para identificar el cuello de botella |

---

## Variables de entorno por Lambda

### `tapi-orchestrator-{env}`

| Variable | Origen | Requerida |
|---|---|---|
| `DATABASE_URL` | Contexto CDK `databaseUrl` | Sí |
| `SOURCE_TABLE` | CDK — nombre de la tabla de registros | Sí |
| `PAGINATOR_LAMBDA_ARN` | CDK — ARN de `tapi-paginator-{env}` | Sí |
| `SCHEDULER_ROLE_ARN` | CDK — ARN del rol `tapi-scheduler-role-{env}` | Sí |
| `SQS_QUEUE_URL_PREFIX` | CDK — prefijo de URL de las colas SQS | Sí |
| `SCHEDULER_GROUP_NAME` | CDK — nombre del grupo `tapi-batch-{env}` | Sí |
| `ENVIRONMENT` | Contexto CDK `environment` | Sí |

### `tapi-paginator-{env}`

| Variable | Origen | Requerida |
|---|---|---|
| `DATABASE_URL` | Contexto CDK `databaseUrl` | Sí |
| `SOURCE_TABLE` | CDK — nombre de la tabla de registros | Sí |

### `tapi-worker-{proveedor}-{env}`

| Variable | Origen | Requerida |
|---|---|---|
| `RESULTS_TABLE` | CDK — nombre de `tapi-resultados-{env}` | Sí |
| `CONFIG_TABLE` | CDK — nombre de `tapi-configuracion-proveedores-{env}` | Sí |
| `API_ENDPOINT` | Contexto CDK `apiEndpoint` | Sí |
| `ENVIRONMENT` | Contexto CDK `environment` | Sí |

---

## Preguntas pendientes con el equipo de Tapi

Estas preguntas surgieron durante el diseño y deben resolverse antes de ir a producción:

1. ¿La API interna implementa idempotencia con el header `X-Idempotency-Key`? Si no, los reintentos pueden tener efectos duplicados.
2. ¿Existe algún horario de mantenimiento de la API interna o alguna franja donde no deba recibir llamados?
3. ¿La restricción de concurrencia por proveedor es estrictamente 1, o existe un límite mayor para algunos proveedores?
4. ¿Hay proveedores que por diseño no deban reintentarse nunca?
5. ¿El endpoint de la API varía por registro o es el mismo para todos los registros de un proveedor?
6. ¿La base de datos de registros está en una VPC privada? De ser así, las Lambdas necesitan configuración de VPC adicional en los stacks CDK.
