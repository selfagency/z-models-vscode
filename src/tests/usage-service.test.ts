import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UsageService, type FetchResult } from '../usage-service.js';

vi.mock('got', () => ({
  default: vi.fn(),
}));

type GotMock = {
  mockImplementation: (fn: (url: string, options: unknown) => { text: () => Promise<string> }) => void;
  mock: { calls: unknown[][] };
};

type ServiceWithApiKey = { apiKey: string };

function requireData(result: FetchResult) {
  if (!result.data) throw new Error('expected data');
  return result.data;
}

const quotaBody = {
  data: {
    level: 'pro',
    limits: [
      {
        type: 'TOKENS_LIMIT',
        unit: 3,
        number: 5,
        percentage: 50,
        nextResetTime: 18000000,
      },
      {
        type: 'TOKENS_LIMIT',
        unit: 6,
        number: 1,
        percentage: 12,
        nextResetTime: 2592000000,
      },
      {
        type: 'TIME_LIMIT',
        unit: 5,
        number: 1,
        percentage: 25,
        usage: 100,
        currentValue: 25,
        remaining: 75,
        nextResetTime: 2592000000,
      },
    ],
  },
};

describe('UsageService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stores the apiKey and exposes fetchUsage/updateApiKey', () => {
    const service = new UsageService('secret-key');
    expect(service).toBeInstanceOf(UsageService);
    expect(typeof service.fetchUsage).toBe('function');
    expect((service as unknown as ServiceWithApiKey).apiKey).toBe('secret-key');
    service.updateApiKey('new-key');
    expect((service as unknown as ServiceWithApiKey).apiKey).toBe('new-key');
  });

  it('returns success:false when no apiKey is configured', async () => {
    const service = new UsageService('');
    const result = await service.fetchUsage();
    expect(result.success).toBe(false);
    expect(result.error).toBe('API key not configured');
  });

  it('parses quota windows, MCP time limits, and plan level on a successful fetch', async () => {
    const { default: got } = vi.mocked(await import('got'));
    (got as unknown as GotMock).mockImplementation(() => ({
      text: vi.fn().mockResolvedValue(JSON.stringify(quotaBody)),
    }));

    const service = new UsageService('secret-key');
    const result = await service.fetchUsage();

    expect(result.success).toBe(true);
    const data = requireData(result);
    expect(data.planLevel).toBe('pro');
    expect(data.tokenQuotas).toHaveLength(2);
    expect(data.tokenQuotas[0]).toMatchObject({
      windowName: '5-Hours',
      unit: 3,
      number: 5,
      percentage: 50,
      nextResetTime: 18000000,
    });
    expect(data.tokenQuotas[1]).toMatchObject({
      windowName: '1-Week',
      unit: 6,
      number: 1,
      percentage: 12,
    });
    expect(data.timeLimits).toHaveLength(1);
    expect(data.timeLimits[0]).toMatchObject({
      windowName: '1-Month MCP Tools',
      unit: 5,
      number: 1,
      percentage: 25,
      usage: 100,
      currentValue: 25,
      remaining: 75,
      nextResetTime: 2592000000,
    });
    expect(data.lastUpdated).toBeInstanceOf(Date);
    expect(data.connectionStatus).toBe('connected');
  });

  it('issues exactly one request with a Bearer Authorization header', async () => {
    const { default: got } = vi.mocked(await import('got'));
    const mock = got as unknown as GotMock;
    let capturedHeaders: Record<string, string> | undefined;
    mock.mockImplementation((_url, options) => {
      capturedHeaders = (options as { headers: Record<string, string> }).headers;
      return { text: vi.fn().mockResolvedValue(JSON.stringify(quotaBody)) };
    });

    await new UsageService('secret-key').fetchUsage();

    // Regression guard: the status bar auto-refreshes, so extra calls here
    // multiply against the poll timer.
    expect(mock.mock.calls).toHaveLength(1);
    expect(String(mock.mock.calls[0]![0])).toContain('quota/limit');
    expect(capturedHeaders?.Authorization).toBe('Bearer secret-key');
  });

  it('returns success:false when the HTTP layer throws', async () => {
    const { default: got } = vi.mocked(await import('got'));
    (got as unknown as GotMock).mockImplementation(() => {
      throw new Error('network down');
    });

    const result = await new UsageService('secret-key').fetchUsage();

    expect(result.success).toBe(false);
    expect(result.error).toContain('network down');
  });
});