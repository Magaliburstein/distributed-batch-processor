import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SQSClient } from '@aws-sdk/client-sqs';

vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: vi.fn(),
  SendMessageBatchCommand: vi.fn((input) => input),
}));

vi.mock('pg', () => {
  const queryMock = vi.fn();
  const Pool = vi.fn(() => ({ query: queryMock }));
  return { Pool, __queryMock: queryMock };
});

const mockSend = vi.fn();
(SQSClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
  send: mockSend,
}));

describe('paginator/handler', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.DATABASE_URL = 'postgres://test';
    process.env.SOURCE_TABLE = 'registros';
    mockSend.mockResolvedValue({ Failed: [] });
  });

  it('termina sin encolar si no hay registros', async () => {
    const pg = await import('pg');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pg as any).__queryMock.mockResolvedValue({ rows: [] });

    const { handler } = await import('./index');
    await handler({ proveedor: 'p1', sqsQueueUrl: 'https://sqs/queue', batchDate: '2024-01-01' });

    expect(mockSend).not.toHaveBeenCalled();
  });

  it('envía todos los registros de una página completa a SQS', async () => {
    const records = Array.from({ length: 15 }, (_, i) => ({
      id_registro: `rec-${i}`,
      proveedor: 'p1',
      data: 'x',
    }));

    const pg = await import('pg');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pg as any).__queryMock
      .mockResolvedValueOnce({ rows: records })
      .mockResolvedValueOnce({ rows: [] });

    const { handler } = await import('./index');
    await handler({ proveedor: 'p1', sqsQueueUrl: 'https://sqs/queue', batchDate: '2024-01-01' });

    // 15 registros → 2 llamadas SQS (10 + 5)
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('pagina correctamente usando keyset sobre id_registro', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => ({
      id_registro: `${String(i).padStart(6, '0')}`,
      proveedor: 'p1',
    }));

    const pg = await import('pg');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pg as any).__queryMock
      .mockResolvedValueOnce({ rows: page1 })
      .mockResolvedValueOnce({ rows: [] });

    const { handler } = await import('./index');
    await handler({ proveedor: 'p1', sqsQueueUrl: 'https://sqs/queue', batchDate: '2024-01-01' });

    // Segunda query debe incluir lastId = '000999'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const secondCallArgs = (pg as any).__queryMock.mock.calls[1];
    expect(secondCallArgs[1]).toContain('000999');
  });

  it('lanza error si SQS falla en algunos mensajes', async () => {
    const pg = await import('pg');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pg as any).__queryMock.mockResolvedValueOnce({
      rows: [{ id_registro: 'r1', proveedor: 'p1' }],
    });

    mockSend.mockResolvedValueOnce({ Failed: [{ Id: '0', Code: 'ServiceUnavailable' }] });

    const { handler } = await import('./index');
    await expect(
      handler({ proveedor: 'p1', sqsQueueUrl: 'https://sqs/queue', batchDate: '2024-01-01' }),
    ).rejects.toThrow('SQS batch send failed');
  });
});
