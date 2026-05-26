#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { StackPersistencia } from '../lib/stack-persistencia';
import { StackWorkers } from '../lib/stack-workers';
import { StackOrchestration } from '../lib/stack-orchestration';
import { StackTrigger } from '../lib/stack-trigger';
import { StackObservabilidad } from '../lib/stack-observabilidad';

const app = new cdk.App();

const environment = app.node.tryGetContext('environment') as string ?? 'dev';
// TRADE-OFF CONSCIENTE: los proveedores se declaran aquí en tiempo de deploy, no se descubren
// automáticamente desde la tabla de registros. CDK corre en tiempo de deploy y no puede
// consultar la DB para crear recursos dinámicos. Esto significa que agregar un proveedor
// nuevo a la tabla requiere también actualizar este parámetro y correr `cdk deploy`.
// Ver sección "Agregar un nuevo proveedor" en el README.
const rawProviders = app.node.tryGetContext('providers') as string ?? 'providerA,providerB,providerC';
const providers = rawProviders.split(',').map((p: string) => p.trim()).filter(Boolean);
const alertEmail = app.node.tryGetContext('alertEmail') as string ?? 'alertas@tapi.com';
const apiEndpoint = app.node.tryGetContext('apiEndpoint') as string ?? 'https://api.tapi.internal/process';
const databaseUrl = app.node.tryGetContext('databaseUrl') as string ?? '';

const awsEnv: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};

// 1. Tablas DynamoDB — sin dependencias externas
const persistenciaStack = new StackPersistencia(app, `tapi-persistencia-${environment}`, {
  env: awsEnv,
  environment,
  description: `Tapi Batch — DynamoDB (resultados + config proveedores) [${environment}]`,
});

// 2. Workers — SQS queues + Lambda paginadora + Lambda workers (una por proveedor)
const workersStack = new StackWorkers(app, `tapi-workers-${environment}`, {
  env: awsEnv,
  environment,
  providers,
  resultsTable: persistenciaStack.resultsTable,
  configTable: persistenciaStack.configTable,
  apiEndpoint,
  databaseUrl,
  description: `Tapi Batch — SQS + Lambda Paginadora + Lambda Workers [${environment}]`,
});
workersStack.addDependency(persistenciaStack);

// SQS Queue URL prefix construido a partir del account/region del env
const sqsQueueUrlPrefix = `https://sqs.${awsEnv.region}.amazonaws.com/${awsEnv.account}/tapi-queue-`;

// 3. Orquestador — crea EventBridge Schedules dinámicos por proveedor
const orchestrationStack = new StackOrchestration(app, `tapi-orchestration-${environment}`, {
  env: awsEnv,
  environment,
  configTable: persistenciaStack.configTable,
  paginatorFunction: workersStack.paginatorFunction,
  sqsQueueUrlPrefix,
  databaseUrl,
  description: `Tapi Batch — Lambda Orquestadora [${environment}]`,
});
orchestrationStack.addDependency(workersStack);

// 4. Trigger — EventBridge Scheduler cron medianoche que dispara el orquestador
const triggerStack = new StackTrigger(app, `tapi-trigger-${environment}`, {
  env: awsEnv,
  environment,
  orchestratorFunction: orchestrationStack.orchestratorFunction,
  description: `Tapi Batch — EventBridge Scheduler nightly trigger [${environment}]`,
});
triggerStack.addDependency(orchestrationStack);

// 5. Observabilidad — alarmas CloudWatch + dashboard + SNS
const observabilidadStack = new StackObservabilidad(app, `tapi-observabilidad-${environment}`, {
  env: awsEnv,
  environment,
  providers,
  workerFunctions: workersStack.workerFunctions,
  dlqQueues: workersStack.dlqQueues,
  orchestratorFunction: orchestrationStack.orchestratorFunction,
  alertEmail,
  description: `Tapi Batch — CloudWatch Alarms + Dashboard [${environment}]`,
});
observabilidadStack.addDependency(workersStack);
observabilidadStack.addDependency(orchestrationStack);

app.synth();
