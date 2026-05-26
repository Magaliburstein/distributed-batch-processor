import { SQSClient, SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { Pool } from 'pg';
import type { PaginatorEvent, WorkerMessage } from '../../shared/types';

const sqsClient = new SQSClient({});
let pool: Pool | null = null;

const BATCH_SIZE = 1000;
const SQS_BATCH_SIZE = 10;

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
  }
  return pool;
}

export const handler = async (event: PaginatorEvent): Promise<void> => {
  const { proveedor, sqsQueueUrl, batchDate } = event;
  const sourceTable = process.env.SOURCE_TABLE;
  if (!sourceTable) throw new Error('Missing env var: SOURCE_TABLE');

  let lastId: string | null = null;
  let totalEnqueued = 0;
  let pageNumber = 0;

  do {
    const records = await fetchPage(sourceTable, proveedor, lastId);
    if (records.length === 0) break;

    await enqueueBatch(records, proveedor, batchDate, sqsQueueUrl);

    lastId = records[records.length - 1].id_registro as string;
    totalEnqueued += records.length;
    pageNumber++;

    console.log(`Page ${pageNumber}: enqueued ${records.length} records for ${proveedor}`);
  } while (true);

  console.log(`Paginator done — ${proveedor}: ${totalEnqueued} records enqueued`);
};

async function fetchPage(
  sourceTable: string,
  proveedor: string,
  lastId: string | null,
): Promise<Record<string, unknown>[]> {
  const db = getPool();

  if (lastId === null) {
    const result = await db.query(
      `SELECT * FROM ${sourceTable} WHERE proveedor = $1 ORDER BY id_registro LIMIT ${BATCH_SIZE}`,
      [proveedor],
    );
    return result.rows;
  }

  const result = await db.query(
    `SELECT * FROM ${sourceTable} WHERE proveedor = $1 AND id_registro > $2 ORDER BY id_registro LIMIT ${BATCH_SIZE}`,
    [proveedor, lastId],
  );
  return result.rows;
}

async function enqueueBatch(
  records: Record<string, unknown>[],
  proveedor: string,
  batchDate: string,
  sqsQueueUrl: string,
): Promise<void> {
  // SQS SendMessageBatch accepts max 10 messages per call
  for (let i = 0; i < records.length; i += SQS_BATCH_SIZE) {
    const chunk = records.slice(i, i + SQS_BATCH_SIZE);

    const entries = chunk.map((record, idx) => {
      const message: WorkerMessage = {
        id_registro: record.id_registro as string,
        proveedor,
        batchDate,
        payload: record,
      };
      return {
        Id: `${i + idx}`,
        MessageBody: JSON.stringify(message),
      };
    });

    const response = await sqsClient.send(
      new SendMessageBatchCommand({ QueueUrl: sqsQueueUrl, Entries: entries }),
    );

    if (response.Failed && response.Failed.length > 0) {
      console.error('Failed SQS entries:', JSON.stringify(response.Failed));
      throw new Error(`SQS batch send failed for ${response.Failed.length} messages`);
    }
  }
}
