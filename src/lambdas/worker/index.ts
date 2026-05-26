import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { SQSClient, ChangeMessageVisibilityCommand } from '@aws-sdk/client-sqs';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { classifyHttpResult } from '../../shared/error-classifier';
import { generateIdempotencyKey, buildDynamoPk } from '../../shared/idempotency';
import type { WorkerMessage, ErrorClassification, ProcessingResult } from '../../shared/types';

const dynamoClient = new DynamoDBClient({});
const sqsClient = new SQSClient({});

// Backoff sequence in seconds per retry attempt (1-indexed ApproximateReceiveCount)
const BACKOFF_SECONDS: Record<number, number> = { 1: 30, 2: 120, 3: 480 };
const MAX_RETRIES = Object.keys(BACKOFF_SECONDS).length;
const API_TIMEOUT_MS = 30_000;

export const handler = async (event: SQSEvent): Promise<void> => {
  const env = validateEnv();

  for (const record of event.Records) {
    await processRecord(record, env);
  }
};

async function processRecord(
  record: SQSRecord,
  env: ReturnType<typeof validateEnv>,
): Promise<void> {
  const message: WorkerMessage = JSON.parse(record.body) as WorkerMessage;
  const { id_registro, proveedor, batchDate, payload } = message;

  const receiveCount = parseInt(record.attributes.ApproximateReceiveCount, 10);
  const idempotencyKey = generateIdempotencyKey(id_registro, batchDate);

  console.log(`Processing ${id_registro} (proveedor=${proveedor}, attempt=${receiveCount})`);

  const { statusCode, isTimeout, responseBody, error } = await callApi(
    env.API_ENDPOINT,
    payload,
    idempotencyKey,
  );

  const { classification, cooldownSeconds } = await classifyHttpResult({
    statusCode,
    isTimeout,
    proveedor,
    configTableName: env.CONFIG_TABLE,
    dynamoClient,
  });

  const timestamp = new Date().toISOString();
  await saveResult({
    id_registro,
    proveedor,
    classification,
    statusCode: statusCode ?? undefined,
    error: error ?? undefined,
    idempotencyKey,
    timestamp,
    retryCount: receiveCount - 1,
    resultsTable: env.RESULTS_TABLE,
  });

  if (classification === 'RETRY') {
    await handleRetry({
      receiveCount,
      cooldownSeconds,
      record,
      id_registro,
      proveedor,
    });
    return;
  }

  console.log(`${id_registro}: ${classification} (status=${statusCode ?? 'timeout'})`);
  void responseBody;
}

async function callApi(
  endpoint: string,
  payload: Record<string, unknown>,
  idempotencyKey: string,
): Promise<{
  statusCode: number | null;
  isTimeout: boolean;
  responseBody?: unknown;
  error?: string;
}> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    let responseBody: unknown;
    try {
      responseBody = await response.json();
    } catch {
      responseBody = null;
    }

    return { statusCode: response.status, isTimeout: false, responseBody };
  } catch (err) {
    const isTimeout = (err as Error).name === 'AbortError';
    return {
      statusCode: null,
      isTimeout,
      error: isTimeout ? 'Request timeout after 30s' : (err as Error).message,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function handleRetry(params: {
  receiveCount: number;
  cooldownSeconds?: number;
  record: SQSRecord;
  id_registro: string;
  proveedor: string;
}): Promise<void> {
  const { receiveCount, cooldownSeconds, record, id_registro, proveedor } = params;

  if (receiveCount > MAX_RETRIES) {
    // SQS maxReceiveCount will route to DLQ — let it fail naturally
    console.warn(`${id_registro}: max retries exceeded — routing to DLQ`);
    throw new Error(`Max retries exceeded for ${id_registro}`);
  }

  // Use provider-defined cooldown (e.g. 429) or standard backoff
  const visibilitySeconds = cooldownSeconds ?? BACKOFF_SECONDS[receiveCount] ?? 480;

  await sqsClient.send(
    new ChangeMessageVisibilityCommand({
      QueueUrl: extractQueueUrl(record.eventSourceARN),
      ReceiptHandle: record.receiptHandle,
      VisibilityTimeout: visibilitySeconds,
    }),
  );

  console.log(
    `${id_registro} (${proveedor}): RETRY — next attempt in ${visibilitySeconds}s (attempt ${receiveCount})`,
  );

  // Throw so Lambda reports failure and SQS honors our updated visibility timeout
  throw new Error(`Retrying ${id_registro} in ${visibilitySeconds}s`);
}

async function saveResult(params: {
  id_registro: string;
  proveedor: string;
  classification: ErrorClassification;
  statusCode?: number;
  error?: string;
  idempotencyKey: string;
  timestamp: string;
  retryCount: number;
  resultsTable: string;
}): Promise<void> {
  const {
    id_registro,
    proveedor,
    classification,
    statusCode,
    error,
    idempotencyKey,
    timestamp,
    retryCount,
    resultsTable,
  } = params;

  const item: ProcessingResult = {
    pk: buildDynamoPk(proveedor, id_registro),
    sk: timestamp,
    proveedor,
    id_registro,
    classification,
    idempotency_key: idempotencyKey,
    timestamp_ejecucion: timestamp,
    retry_count: retryCount,
    ...(statusCode !== undefined && { statusCode }),
    ...(error !== undefined && { error }),
  };

  await dynamoClient.send(
    new PutItemCommand({
      TableName: resultsTable,
      Item: marshall(item, { removeUndefinedValues: true }),
    }),
  );
}

function extractQueueUrl(eventSourceARN: string): string {
  // arn:aws:sqs:region:accountId:queue-name → https://sqs.region.amazonaws.com/accountId/queue-name
  const parts = eventSourceARN.split(':');
  const region = parts[3];
  const accountId = parts[4];
  const queueName = parts[5];
  return `https://sqs.${region}.amazonaws.com/${accountId}/${queueName}`;
}

function validateEnv() {
  const required = ['RESULTS_TABLE', 'CONFIG_TABLE', 'API_ENDPOINT'] as const;
  for (const key of required) {
    if (!process.env[key]) throw new Error(`Missing env var: ${key}`);
  }
  return {
    RESULTS_TABLE: process.env.RESULTS_TABLE!,
    CONFIG_TABLE: process.env.CONFIG_TABLE!,
    API_ENDPOINT: process.env.API_ENDPOINT!,
  };
}
