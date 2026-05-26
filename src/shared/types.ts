export type ErrorClassification = 'SUCCESS' | 'RETRY' | 'FATAL';

export interface ProviderVolume {
  proveedor: string;
  count: number;
}

export interface ProviderConfig {
  proveedor: string;
  retriable_status_codes?: number[];
  fatal_status_codes?: number[];
  cooldown_seconds?: number;
}

export interface WorkerMessage {
  id_registro: string;
  proveedor: string;
  batchDate: string;
  payload: Record<string, unknown>;
}

export interface PaginatorEvent {
  proveedor: string;
  sqsQueueUrl: string;
  batchDate: string;
}

export interface ProcessingResult {
  pk: string;
  sk: string;
  proveedor: string;
  id_registro: string;
  classification: ErrorClassification;
  statusCode?: number;
  error?: string;
  idempotency_key: string;
  timestamp_ejecucion: string;
  retry_count: number;
  ttl?: number;
}

export interface OrchestratorEnv {
  DATABASE_URL: string;
  SOURCE_TABLE: string;
  PAGINATOR_LAMBDA_ARN: string;
  SCHEDULER_ROLE_ARN: string;
  SQS_QUEUE_URL_PREFIX: string;
  SCHEDULER_GROUP_NAME: string;
  ENVIRONMENT: string;
}

export interface PaginatorEnv {
  DATABASE_URL: string;
  SOURCE_TABLE: string;
}

export interface WorkerEnv {
  RESULTS_TABLE: string;
  CONFIG_TABLE: string;
  API_ENDPOINT: string;
  ENVIRONMENT: string;
}
