import * as cdk from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import * as path from 'path';

// TRADE-OFF CONSCIENTE: la lista de proveedores se recibe como parámetro de deploy (contexto CDK),
// no se descubre dinámicamente desde la tabla de registros en tiempo de ejecución.
// CDK sintetiza infraestructura estática antes del deploy, por lo que no puede consultar la DB
// para crear SQS queues y Lambda workers por proveedor de forma automática.
// Alternativa descartada (Opción A): que la Lambda orquestadora cree colas y Lambdas en runtime
// vía SDK — añade complejidad operacional alta y permisos IAM riesgosos (lambda:CreateFunction).
// Consecuencia: cada vez que se incorpora un proveedor nuevo a la tabla de registros, es necesario
// actualizar el parámetro `providers` en el deploy y ejecutar `cdk deploy`. Ver README.
interface StackWorkersProps extends cdk.StackProps {
  environment: string;
  providers: string[];
  resultsTable: dynamodb.Table;
  configTable: dynamodb.Table;
  apiEndpoint: string;
  databaseUrl: string;
}

export class StackWorkers extends cdk.Stack {
  readonly paginatorFunction: lambda.Function;
  readonly workerFunctions: Map<string, lambda.Function> = new Map();
  readonly dlqQueues: Map<string, sqs.Queue> = new Map();
  readonly providerQueues: Map<string, sqs.Queue> = new Map();

  constructor(scope: Construct, id: string, props: StackWorkersProps) {
    super(scope, id, props);

    const { environment, providers, resultsTable, configTable, apiEndpoint, databaseUrl } = props;

    // Paginator Lambda — única, invocada una vez por proveedor por EventBridge Scheduler
    this.paginatorFunction = new lambdaNode.NodejsFunction(this, 'PaginatorFunction', {
      functionName: `tapi-paginator-${environment}`,
      entry: path.join(__dirname, '../../src/lambdas/paginator/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.minutes(15),
      memorySize: 512,
      environment: {
        SOURCE_TABLE: `registros_${environment}`,
        DATABASE_URL: databaseUrl,
      },
      bundling: { minify: true, sourceMap: true },
    });

    // Permisos de red VPC heredados del rol de ejecución — la conexión DB viene por DATABASE_URL

    for (const proveedor of providers) {
      this.createProviderResources(proveedor, environment, resultsTable, configTable, apiEndpoint);
    }

    // Output con el URL prefix de las colas (usado por el orquestador)
    new cdk.CfnOutput(this, 'SqsQueueUrlPrefix', {
      value: `https://sqs.${this.region}.amazonaws.com/${this.account}/tapi-queue-`,
      exportName: `tapi-sqs-queue-url-prefix-${environment}`,
    });
  }

  private createProviderResources(
    proveedor: string,
    environment: string,
    resultsTable: dynamodb.Table,
    configTable: dynamodb.Table,
    apiEndpoint: string,
  ): void {
    const safeName = proveedor.toLowerCase().replace(/[^a-z0-9-]/g, '-');

    const dlq = new sqs.Queue(this, `DLQ-${proveedor}`, {
      queueName: `tapi-dlq-${safeName}-${environment}`,
      retentionPeriod: cdk.Duration.days(14),
    });

    const queue = new sqs.Queue(this, `Queue-${proveedor}`, {
      queueName: `tapi-queue-${safeName}-${environment}`,
      // Visibility timeout debe ser mayor que el máximo backoff (480s) + tiempo de procesamiento
      visibilityTimeout: cdk.Duration.seconds(600),
      deadLetterQueue: {
        queue: dlq,
        // 1 intento inicial + 3 reintentos con backoff = 4 recepciones antes del DLQ
        maxReceiveCount: 4,
      },
    });

    this.dlqQueues.set(proveedor, dlq);
    this.providerQueues.set(proveedor, queue);

    const workerFn = new lambdaNode.NodejsFunction(this, `WorkerFunction-${proveedor}`, {
      functionName: `tapi-worker-${safeName}-${environment}`,
      entry: path.join(__dirname, '../../src/lambdas/worker/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      reservedConcurrentExecutions: 1,
      environment: {
        RESULTS_TABLE: resultsTable.tableName,
        CONFIG_TABLE: configTable.tableName,
        API_ENDPOINT: apiEndpoint,
        ENVIRONMENT: environment,
      },
      bundling: { minify: true, sourceMap: true },
    });

    // Permisos mínimos
    resultsTable.grantWriteData(workerFn);
    configTable.grantReadData(workerFn);
    queue.grantConsumeMessages(workerFn);

    // Permiso para modificar visibility timeout (necesario para el backoff)
    workerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['sqs:ChangeMessageVisibility'],
        resources: [queue.queueArn],
      }),
    );

    workerFn.addEventSource(
      new lambdaEventSources.SqsEventSource(queue, {
        batchSize: 1,
        // reportBatchItemFailures permite que Lambda reporte fallos individuales
        reportBatchItemFailures: true,
      }),
    );

    // Permisos al paginator para encolar en esta cola
    queue.grantSendMessages(this.paginatorFunction);

    this.workerFunctions.set(proveedor, workerFn);
  }
}
