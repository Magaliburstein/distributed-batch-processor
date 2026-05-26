import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SQSEvent } from 'aws-lambda';

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: vi.fn(() => ({ send: vi.fn().mockResolvedValue({}) })),
  PutItemCommand: vi.fn((input) => input),
  GetItemCommand: vi.fn((input) => input),
}));

vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: vi.fn(() => ({ send: mockSqsSend })),
  ChangeMessageVisibilityCommand: vi.fn((input) => input),
}));

vi.mock('@aws-sdk/util-dynamodb', () => ({
  marshall: vi.fn((obj) => obj),
  unmarshall: vi.fn((obj) => obj),
}));

vi.mock('../../shared/error-classifier', () => ({
  classifyHttpResult: mockClassify,
  fetchProviderConfig: vi.fn().mockResolvedValue(null),
}));

const mockSqsSend = vi.fn();
const mockClassify = vi.fn();
const mockFetch = vi.fn();

global.fetch = mockFetch as typeof fetch;

function makeSQSEvent(overrides: Partial<{
  body: string;
  receiveCount: string;
  receiptHandle: string;
  eventSourceARN: string;
}>): SQSEvent {
  return {
    Records: [
      {
        messageId: 'msg-1',
        receiptHandle: overrides.receiptHandle ?? 'rh-1',
        body: overrides.body ?? JSON.stringify({
          id_registro: 'rec-1',
          proveedor: 'p1',
          batchDate: '2024-01-15',
          payload: { data: 'test' },
        }),
        attributes: {
          ApproximateReceiveCount: overrides.receiveCount ?? '1',
          SentTimestamp: '1705276800000',
          SenderId: 'sender',
          ApproximateFirstReceiveTimestamp: '1705276800000',
        },
        messageAttributes: {},
        md5OfBody: '',
        eventSource: 'aws:sqs',
        eventSourceARN: overrides.eventSourceARN ?? 'arn:aws:sqs:us-east-1:123456789:tapi-queue-p1-qa',
        awsRegion: 'us-east-1',
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.RESULTS_TABLE = 'tapi-resultados-qa';
  process.env.CONFIG_TABLE = 'tapi-config-qa';
  process.env.API_ENDPOINT = 'https://api.tapi.internal/process';
});

describe('worker/handler — SUCCESS', () => {
  it('guarda resultado SUCCESS en DynamoDB y retorna sin error', async () => {
    mockFetch.mockResolvedValue({ status: 200, json: async () => ({ ok: true }) });
    mockClassify.mockResolvedValue({ classification: 'SUCCESS' });

    const { handler } = await import('./index');
    await expect(handler(makeSQSEvent({}))).resolves.toBeUndefined();
    expect(mockSqsSend).not.toHaveBeenCalled();
  });
});

describe('worker/handler — FATAL', () => {
  it('guarda resultado FATAL y retorna sin error (elimina el mensaje)', async () => {
    mockFetch.mockResolvedValue({ status: 404, json: async () => null });
    mockClassify.mockResolvedValue({ classification: 'FATAL' });

    const { handler } = await import('./index');
    await expect(handler(makeSQSEvent({}))).resolves.toBeUndefined();
    expect(mockSqsSend).not.toHaveBeenCalled();
  });
});

describe('worker/handler — RETRY', () => {
  it('cambia visibility timeout a 30s en el primer intento y lanza error', async () => {
    mockFetch.mockResolvedValue({ status: 500, json: async () => null });
    mockClassify.mockResolvedValue({ classification: 'RETRY' });

    const { handler } = await import('./index');
    await expect(handler(makeSQSEvent({ receiveCount: '1' }))).rejects.toThrow('Retrying');

    expect(mockSqsSend).toHaveBeenCalledOnce();
    const cmd = mockSqsSend.mock.calls[0][0] as { VisibilityTimeout: number };
    expect(cmd.VisibilityTimeout).toBe(30);
  });

  it('cambia visibility timeout a 120s en el segundo intento', async () => {
    mockFetch.mockResolvedValue({ status: 500, json: async () => null });
    mockClassify.mockResolvedValue({ classification: 'RETRY' });

    const { handler } = await import('./index');
    await expect(handler(makeSQSEvent({ receiveCount: '2' }))).rejects.toThrow('Retrying');

    const cmd = mockSqsSend.mock.calls[0][0] as { VisibilityTimeout: number };
    expect(cmd.VisibilityTimeout).toBe(120);
  });

  it('cambia visibility timeout a 480s en el tercer intento', async () => {
    mockFetch.mockResolvedValue({ status: 500, json: async () => null });
    mockClassify.mockResolvedValue({ classification: 'RETRY' });

    const { handler } = await import('./index');
    await expect(handler(makeSQSEvent({ receiveCount: '3' }))).rejects.toThrow('Retrying');

    const cmd = mockSqsSend.mock.calls[0][0] as { VisibilityTimeout: number };
    expect(cmd.VisibilityTimeout).toBe(480);
  });

  it('usa cooldownSeconds del clasificador cuando se provee (ej: 429)', async () => {
    mockFetch.mockResolvedValue({ status: 429, json: async () => null });
    mockClassify.mockResolvedValue({ classification: 'RETRY', cooldownSeconds: 60 });

    const { handler } = await import('./index');
    await expect(handler(makeSQSEvent({ receiveCount: '1' }))).rejects.toThrow('Retrying');

    const cmd = mockSqsSend.mock.calls[0][0] as { VisibilityTimeout: number };
    expect(cmd.VisibilityTimeout).toBe(60);
  });

  it('lanza error cuando supera MAX_RETRIES para ir al DLQ', async () => {
    mockFetch.mockResolvedValue({ status: 500, json: async () => null });
    mockClassify.mockResolvedValue({ classification: 'RETRY' });

    const { handler } = await import('./index');
    await expect(handler(makeSQSEvent({ receiveCount: '4' }))).rejects.toThrow('Max retries exceeded');
    expect(mockSqsSend).not.toHaveBeenCalled();
  });
});

describe('worker/handler — timeout', () => {
  it('clasifica AbortError como timeout (statusCode null, isTimeout true)', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    mockFetch.mockRejectedValue(abortError);
    mockClassify.mockResolvedValue({ classification: 'RETRY' });

    const { handler } = await import('./index');
    await expect(handler(makeSQSEvent({ receiveCount: '1' }))).rejects.toThrow('Retrying');

    expect(mockClassify).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: null, isTimeout: true }),
    );
  });
});

describe('worker/handler — idempotency key', () => {
  it('genera key con formato {id_registro}#{batchDate}', async () => {
    mockFetch.mockResolvedValue({ status: 200, json: async () => ({}) });
    mockClassify.mockResolvedValue({ classification: 'SUCCESS' });

    const { handler } = await import('./index');
    await handler(makeSQSEvent({}));

    const fetchCall = mockFetch.mock.calls[0];
    const headers = fetchCall[1].headers as Record<string, string>;
    expect(headers['X-Idempotency-Key']).toBe('rec-1#2024-01-15');
  });
});
