import got from 'got';

/**
 * A single token quota window from TOKENS_LIMIT
 */
export interface TokenQuota {
  windowName: string; // e.g. "5-Hour", "1-Week", "1-Month"
  unit: number; // 3=hour(s), 5=month(s), 6=week(s)
  number: number; // quantity of the time unit
  percentage: number; // usage percentage 0–100
  nextResetTime?: number; // unix ms when quota resets
}

/**
 * MCP tool usage limits from TIME_LIMIT
 */
export interface TimeLimit {
  windowName: string; // e.g. "1-Month MCP Tools"
  unit: number;
  number: number;
  percentage: number;
  usage: number; // total quota allowed
  currentValue: number; // current usage count
  remaining: number;
  nextResetTime?: number;
}

/**
 * Aggregated usage data for the status bar
 */
export interface UsageData {
  /** Dynamic token quota windows from API */
  tokenQuotas: TokenQuota[];
  /** MCP tool limits from API */
  timeLimits: TimeLimit[];
  /** Plan level auto-detected from API (e.g. "free", "pro", "enterprise") */
  planLevel?: string;
  /** Today's stats */
  todayPrompts: number;
  todayTokens: number;
  /** 7-day stats */
  sevenDayPrompts: number;
  sevenDayTokens: number;
  /** 30-day stats */
  thirtyDayPrompts: number;
  thirtyDayTokens: number;
  /** Metadata */
  lastUpdated: Date;
  connectionStatus: 'connected' | 'disconnected' | 'error';
}

export interface FetchResult {
  success: boolean;
  data?: UsageData;
  error?: string;
}

// ── API response shapes ────────────────────────────────────────────────────

interface QuotaLimitResponse {
  limits?: Array<{
    type: 'TOKENS_LIMIT' | 'TIME_LIMIT';
    unit: number;
    number: number;
    percentage: number;
    nextResetTime?: number;
    // TIME_LIMIT specific
    usage?: number;
    currentValue?: number;
    remaining?: number;
    usageDetails?: Array<{ modelCode: string; usage: number }>;
  }>;
  level?: string;
}

interface ModelUsageResponse {
  totalUsage?: {
    totalModelCallCount?: number;
    totalTokensUsage?: number;
  };
}

// ── Service ────────────────────────────────────────────────────────────────

export class UsageService {
  private readonly baseUrl = 'https://api.z.ai';

  constructor(private apiKey: string) {}

  updateApiKey(apiKey: string): void {
    (this as any).apiKey = apiKey;
  }

  async fetchUsage(): Promise<FetchResult> {
    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    try {
      const now = new Date();
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
      const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
      const start7d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7, 0, 0, 0, 0);
      const start30d = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate(), 0, 0, 0, 0);

      const [quotaLimitResult, todayResult, weekResult, monthResult] = await Promise.allSettled([
        this.fetchEndpoint(`${this.baseUrl}/api/monitor/usage/quota/limit`),
        this.fetchEndpoint(
          `${this.baseUrl}/api/monitor/usage/model-usage?startTime=${encodeURIComponent(fmt(startToday))}&endTime=${encodeURIComponent(fmt(end))}`,
        ),
        this.fetchEndpoint(
          `${this.baseUrl}/api/monitor/usage/model-usage?startTime=${encodeURIComponent(fmt(start7d))}&endTime=${encodeURIComponent(fmt(end))}`,
        ),
        this.fetchEndpoint(
          `${this.baseUrl}/api/monitor/usage/model-usage?startTime=${encodeURIComponent(fmt(start30d))}&endTime=${encodeURIComponent(fmt(end))}`,
        ),
      ]);

      // Parse quota limits
      const tokenQuotas: TokenQuota[] = [];
      const timeLimits: TimeLimit[] = [];
      let planLevel: string | undefined;

      const quotaResp =
        quotaLimitResult.status === 'fulfilled'
          ? (quotaLimitResult.value as QuotaLimitResponse)
          : null;

      if (quotaResp) {
        planLevel = quotaResp.level;
        if (quotaResp.limits) {
          for (const lim of quotaResp.limits) {
            if (lim.type === 'TOKENS_LIMIT') {
              tokenQuotas.push({
                windowName: formatWindowName(lim.unit, lim.number),
                unit: lim.unit,
                number: lim.number,
                percentage: lim.percentage ?? 0,
                nextResetTime: lim.nextResetTime,
              });
            } else if (lim.type === 'TIME_LIMIT') {
              timeLimits.push({
                windowName: formatWindowName(lim.unit, lim.number) + ' MCP Tools',
                unit: lim.unit,
                number: lim.number,
                percentage: lim.percentage ?? 0,
                usage: lim.usage ?? 0,
                currentValue: lim.currentValue ?? 0,
                remaining: lim.remaining ?? 0,
                nextResetTime: lim.nextResetTime,
              });
            }
          }
        }
      }

      // Parse model usage
      const todayStats = extractModelUsage(todayResult);
      const weekStats = extractModelUsage(weekResult);
      const monthStats = extractModelUsage(monthResult);

      return {
        success: true,
        data: {
          tokenQuotas,
          timeLimits,
          planLevel,
          todayPrompts: todayStats.prompts,
          todayTokens: todayStats.tokens,
          sevenDayPrompts: weekStats.prompts,
          sevenDayTokens: weekStats.tokens,
          thirtyDayPrompts: monthStats.prompts,
          thirtyDayTokens: monthStats.tokens,
          lastUpdated: new Date(),
          connectionStatus: 'connected',
        },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: msg };
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────

  /**
   * Fetch from an endpoint, trying both direct-token and Bearer auth formats.
   */
  private async fetchEndpoint(url: string): Promise<any> {
    const headers: Record<string, string> = {
      'Accept-Language': 'en-US,en',
      'Content-Type': 'application/json',
    };

    // Try direct token first, then Bearer format
    const authFormats = [this.apiKey, `Bearer ${this.apiKey}`];

    for (const auth of authFormats) {
      try {
        const body = await got(url, {
          method: 'GET',
          headers: { ...headers, Authorization: auth },
          timeout: { request: 15000 },
          retry: { limit: 1 },
        }).text();

        const parsed = JSON.parse(body);
        return parsed.data ?? parsed;
      } catch (err: any) {
        const status = err?.response?.statusCode;
        if (status === 401) continue; // try next auth format
        throw err;
      }
    }

    throw new Error('Authentication failed with both token formats');
  }
}

// ── Pure helpers ───────────────────────────────────────────────────────────

function fmt(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function formatWindowName(unit: number, number: number): string {
  const names: Record<number, string> = { 3: 'Hour', 5: 'Month', 6: 'Week' };
  const name = names[unit] ?? 'Unknown';
  return `${number}-${name}${number > 1 ? 's' : ''}`;
}

function extractModelUsage(
  result: PromiseSettledResult<unknown>,
): { prompts: number; tokens: number } {
  if (result.status !== 'fulfilled' || !result.value) return { prompts: 0, tokens: 0 };
  const resp = result.value as ModelUsageResponse;
  return {
    prompts: resp.totalUsage?.totalModelCallCount ?? 0,
    tokens: resp.totalUsage?.totalTokensUsage ?? 0,
  };
}
