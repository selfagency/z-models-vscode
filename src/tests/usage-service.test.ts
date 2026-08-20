import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UsageService, type FetchResult } from '../usage-service.js';

vi.mock('got', () => ({
  default: vi.fn(),
}));

type GotMock = { mockImplementation: (fn: (url: string) => { text: () => Promise<string> }) => void };

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

const modelUsageBody = {
  data: {
    totalUsage: {
      totalModelCallCount: 10,
      totalTokensUsage: 5000,
    },
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

  it('returns a FetchResult with parsed UsageData on a successful fetch', async () => {
    const { default: got } = vi.mocked(await import('got'));
    (got as unknown as GotMock).mockImplementation((url: string) => {
      const body = String(url).includes('quota/limit') ? quotaBody : modelUsageBody;
      return { text: vi.fn().mockResolvedValue(JSON.stringify(body)) };
    });

    const service = new UsageService('secret-key');
    const result = await service.fetchUsage();

    expect(result.success).toBe(true);
    const data = requireData(result);
    expect(data.planLevel).toBe('pro');
    expect(data.tokenQuotas).toHaveLength(1);
    expect(data.tokenQuotas[0]).toMatchObject({
      windowName: '5-Hours',
      unit: 3,
      number: 5,
      percentage: 50,
      nextResetTime: 18000000,
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
    expect(data.todayPrompts).toBe(10);
    expect(data.todayTokens).toBe(5000);
    expect(data.sevenDayPrompts).toBe(10);
    expect(data.sevenDayTokens).toBe(5000);
    expect(data.thirtyDayPrompts).toBe(10);
    expect(data.thirtyDayTokens).toBe(5000);
    expect(data.lastUpdated).toBeInstanceOf(Date);
    expect(data.connectionStatus).toBe('connected');
  });

  it('degrades gracefully to empty data when the HTTP layer throws', async () => {
    const { default: got } = vi.mocked(await import('got'));
    (got as unknown as GotMock).mockImplementation(() => {
      throw new Error('network down');
    });

    const service = new UsageService('secret-key');
    const result = await service.fetchUsage();

    // Promise.allSettled swallows per-endpoint failures, so the fetch still
    // resolves with empty usage data rather than rejecting.
    expect(result.success).toBe(true);
    const data = requireData(result);
    expect(data.tokenQuotas).toEqual([]);
    expect(data.timeLimits).toEqual([]);
    expect(data.todayPrompts).toBe(0);
    expect(data.todayTokens).toBe(0);
  });
});
