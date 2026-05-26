import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import type { ErrorClassification, ProviderConfig } from './types';

export interface ClassificationResult {
  classification: ErrorClassification;
  cooldownSeconds?: number;
}

const DEFAULT_RETRIABLE = new Set([429, 500, 502, 503, 504]);
const DEFAULT_FATAL = new Set([400, 401, 403, 404, 422]);
const DEFAULT_COOLDOWN_SECONDS = 60;

export async function classifyHttpResult(params: {
  statusCode: number | null;
  isTimeout: boolean;
  proveedor: string;
  configTableName: string;
  dynamoClient: DynamoDBClient;
}): Promise<ClassificationResult> {
  const { statusCode, isTimeout, proveedor, configTableName, dynamoClient } = params;

  if (isTimeout || statusCode === null) {
    return { classification: 'RETRY' };
  }

  if (statusCode >= 200 && statusCode < 300) {
    return { classification: 'SUCCESS' };
  }

  const config = await fetchProviderConfig(proveedor, configTableName, dynamoClient);
  return applyClassification(statusCode, config);
}

export function applyClassification(
  statusCode: number,
  config: ProviderConfig | null,
): ClassificationResult {
  if (statusCode >= 200 && statusCode < 300) {
    return { classification: 'SUCCESS' };
  }

  if (config?.retriable_status_codes?.includes(statusCode)) {
    return {
      classification: 'RETRY',
      cooldownSeconds: statusCode === 429
        ? (config.cooldown_seconds ?? DEFAULT_COOLDOWN_SECONDS)
        : undefined,
    };
  }

  if (config?.fatal_status_codes?.includes(statusCode)) {
    return { classification: 'FATAL' };
  }

  if (DEFAULT_RETRIABLE.has(statusCode)) {
    return {
      classification: 'RETRY',
      cooldownSeconds: statusCode === 429 ? DEFAULT_COOLDOWN_SECONDS : undefined,
    };
  }

  if (DEFAULT_FATAL.has(statusCode)) {
    return { classification: 'FATAL' };
  }

  // Unknown status codes default to RETRY to avoid silent data loss
  return { classification: 'RETRY' };
}

export async function fetchProviderConfig(
  proveedor: string,
  configTableName: string,
  dynamoClient: DynamoDBClient,
): Promise<ProviderConfig | null> {
  try {
    const result = await dynamoClient.send(
      new GetItemCommand({
        TableName: configTableName,
        Key: marshall({ proveedor }),
      }),
    );
    if (!result.Item) return null;
    return unmarshall(result.Item) as ProviderConfig;
  } catch {
    return null;
  }
}
