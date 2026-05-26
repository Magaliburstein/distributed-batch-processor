import { SchedulerClient, CreateScheduleCommand } from '@aws-sdk/client-scheduler';
import { Pool } from 'pg';
import type { ProviderVolume } from '../../shared/types';

const schedulerClient = new SchedulerClient({});
let pool: Pool | null = null;

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

export const handler = async (): Promise<void> => {
  const env = validateEnv();
  const batchDate = new Date().toISOString().slice(0, 10);

  const providers = await fetchProviderVolumes(env.SOURCE_TABLE);
  if (providers.length === 0) {
    console.log('No providers found — nothing to schedule');
    return;
  }

  const schedules = buildSchedules(providers, batchDate);
  console.log(`Scheduling ${schedules.length} providers across 22h`);

  for (const { proveedor, startTime } of schedules) {
    await createProviderSchedule({
      proveedor,
      startTime,
      batchDate,
      env,
    });
  }

  console.log('Orchestration complete', { batchDate, providerCount: schedules.length });
};

export function buildSchedules(
  providers: ProviderVolume[],
  batchDate: string,
): { proveedor: string; startTime: Date }[] {
  // Sort descending: highest volume starts first
  const sorted = [...providers].sort((a, b) => b.count - a.count);
  const total = sorted.reduce((sum, p) => sum + p.count, 0);

  const midnight = new Date(`${batchDate}T00:00:00Z`);
  const windowMs = 22 * 60 * 60 * 1000;

  let cumulative = 0;
  return sorted.map(({ proveedor, count }) => {
    const fraction = total > 0 ? cumulative / total : 0;
    const startTime = new Date(midnight.getTime() + fraction * windowMs);
    cumulative += count;
    return { proveedor, startTime };
  });
}

async function fetchProviderVolumes(sourceTable: string): Promise<ProviderVolume[]> {
  const db = getPool();
  const result = await db.query<{ proveedor: string; count: string }>(
    `SELECT proveedor, COUNT(*) AS count FROM ${sourceTable} GROUP BY proveedor`,
  );
  return result.rows.map((row) => ({
    proveedor: row.proveedor,
    count: parseInt(row.count, 10),
  }));
}

async function createProviderSchedule(params: {
  proveedor: string;
  startTime: Date;
  batchDate: string;
  env: ReturnType<typeof validateEnv>;
}): Promise<void> {
  const { proveedor, startTime, batchDate, env } = params;

  const scheduleName = `tapi-paginator-${proveedor}-${batchDate}`.replace(/[^a-zA-Z0-9_-]/g, '-');
  const sqsQueueUrl = `${env.SQS_QUEUE_URL_PREFIX}${proveedor}-${env.ENVIRONMENT}`;

  // EventBridge Scheduler at() expression requires format: YYYY-MM-DDTHH:MM:SS
  const atExpression = `at(${startTime.toISOString().slice(0, 19)})`;

  await schedulerClient.send(
    new CreateScheduleCommand({
      Name: scheduleName,
      GroupName: env.SCHEDULER_GROUP_NAME,
      ScheduleExpression: atExpression,
      ScheduleExpressionTimezone: 'UTC',
      FlexibleTimeWindow: { Mode: 'OFF' },
      ActionAfterCompletion: 'DELETE',
      Target: {
        Arn: env.PAGINATOR_LAMBDA_ARN,
        RoleArn: env.SCHEDULER_ROLE_ARN,
        Input: JSON.stringify({
          proveedor,
          sqsQueueUrl,
          batchDate,
        }),
      },
    }),
  );

  console.log(`Scheduled ${proveedor} at ${atExpression}`);
}

function validateEnv() {
  const required = [
    'DATABASE_URL',
    'SOURCE_TABLE',
    'PAGINATOR_LAMBDA_ARN',
    'SCHEDULER_ROLE_ARN',
    'SQS_QUEUE_URL_PREFIX',
    'SCHEDULER_GROUP_NAME',
    'ENVIRONMENT',
  ] as const;

  for (const key of required) {
    if (!process.env[key]) throw new Error(`Missing env var: ${key}`);
  }

  return {
    DATABASE_URL: process.env.DATABASE_URL!,
    SOURCE_TABLE: process.env.SOURCE_TABLE!,
    PAGINATOR_LAMBDA_ARN: process.env.PAGINATOR_LAMBDA_ARN!,
    SCHEDULER_ROLE_ARN: process.env.SCHEDULER_ROLE_ARN!,
    SQS_QUEUE_URL_PREFIX: process.env.SQS_QUEUE_URL_PREFIX!,
    SCHEDULER_GROUP_NAME: process.env.SCHEDULER_GROUP_NAME!,
    ENVIRONMENT: process.env.ENVIRONMENT!,
  };
}
