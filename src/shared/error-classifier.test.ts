import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { classifyHttpResult, applyClassification, fetchProviderConfig } from './error-classifier';
import type { ProviderConfig } from './types';

vi.mock('@aws-sdk/client-dynamodb', () => {
  return {
    DynamoDBClient: vi.fn(),
    GetItemCommand: vi.fn(),
  };
});

vi.mock('@aws-sdk/util-dynamodb', () => ({
  marshall: vi.fn((obj) => obj),
  unmarshall: vi.fn((obj) => obj),
}));

const mockSend = vi.fn();
const mockDynamo = { send: mockSend } as unknown as DynamoDBClient;

beforeEach(() => {
  vi.clearAllMocks();
  mockSend.mockResolvedValue({ Item: null });
});

describe('applyClassification — sin config de proveedor', () => {
  it('clasifica 200 como SUCCESS', () => {
    expect(applyClassification(200, null)).toEqual({ classification: 'SUCCESS' });
  });

  it('clasifica 204 como SUCCESS', () => {
    expect(applyClassification(204, null)).toEqual({ classification: 'SUCCESS' });
  });

  it('clasifica 500 como RETRY', () => {
    expect(applyClassification(500, null)).toEqual({ classification: 'RETRY', cooldownSeconds: undefined });
  });

  it('clasifica 502, 503, 504 como RETRY', () => {
    for (const code of [502, 503, 504]) {
      expect(applyClassification(code, null).classification).toBe('RETRY');
    }
  });

  it('clasifica 429 como RETRY con cooldown de 60s', () => {
    expect(applyClassification(429, null)).toEqual({
      classification: 'RETRY',
      cooldownSeconds: 60,
    });
  });

  it('clasifica 400 como FATAL', () => {
    expect(applyClassification(400, null)).toEqual({ classification: 'FATAL' });
  });

  it('clasifica 401, 403, 404, 422 como FATAL', () => {
    for (const code of [401, 403, 404, 422]) {
      expect(applyClassification(code, null).classification).toBe('FATAL');
    }
  });

  it('clasifica status codes desconocidos como RETRY', () => {
    expect(applyClassification(418, null).classification).toBe('RETRY');
    expect(applyClassification(507, null).classification).toBe('RETRY');
  });
});

describe('applyClassification — con config de proveedor', () => {
  const config: ProviderConfig = {
    proveedor: 'providerX',
    retriable_status_codes: [400, 404],
    fatal_status_codes: [503],
    cooldown_seconds: 120,
  };

  it('sobreescribe 400 de FATAL a RETRY por config del proveedor', () => {
    expect(applyClassification(400, config).classification).toBe('RETRY');
  });

  it('sobreescribe 503 de RETRY a FATAL por config del proveedor', () => {
    expect(applyClassification(503, config).classification).toBe('FATAL');
  });

  it('usa cooldown_seconds del proveedor para 429', () => {
    const configWith429: ProviderConfig = {
      proveedor: 'providerX',
      retriable_status_codes: [429],
      cooldown_seconds: 120,
    };
    expect(applyClassification(429, configWith429)).toEqual({
      classification: 'RETRY',
      cooldownSeconds: 120,
    });
  });

  it('no agrega cooldown para retriables que no son 429', () => {
    const result = applyClassification(400, config);
    expect(result.cooldownSeconds).toBeUndefined();
  });
});

describe('classifyHttpResult', () => {
  it('clasifica timeout como RETRY independientemente del status code', async () => {
    const result = await classifyHttpResult({
      statusCode: 200,
      isTimeout: true,
      proveedor: 'p1',
      configTableName: 'config',
      dynamoClient: mockDynamo,
    });
    expect(result.classification).toBe('RETRY');
  });

  it('clasifica statusCode null como RETRY (connection refused)', async () => {
    const result = await classifyHttpResult({
      statusCode: null,
      isTimeout: false,
      proveedor: 'p1',
      configTableName: 'config',
      dynamoClient: mockDynamo,
    });
    expect(result.classification).toBe('RETRY');
  });

  it('clasifica 200 como SUCCESS sin consultar DynamoDB', async () => {
    const result = await classifyHttpResult({
      statusCode: 200,
      isTimeout: false,
      proveedor: 'p1',
      configTableName: 'config',
      dynamoClient: mockDynamo,
    });
    expect(result.classification).toBe('SUCCESS');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('consulta DynamoDB para status codes fuera del rango 2xx', async () => {
    await classifyHttpResult({
      statusCode: 500,
      isTimeout: false,
      proveedor: 'p1',
      configTableName: 'config',
      dynamoClient: mockDynamo,
    });
    expect(mockSend).toHaveBeenCalledOnce();
  });
});

describe('fetchProviderConfig', () => {
  it('retorna null cuando el proveedor no tiene config', async () => {
    mockSend.mockResolvedValueOnce({ Item: null });
    const result = await fetchProviderConfig('p1', 'config', mockDynamo);
    expect(result).toBeNull();
  });

  it('retorna null silenciosamente si DynamoDB falla', async () => {
    mockSend.mockRejectedValueOnce(new Error('DynamoDB unavailable'));
    const result = await fetchProviderConfig('p1', 'config', mockDynamo);
    expect(result).toBeNull();
  });
});
