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
  /** Plan level auto-detected from API (e.g. "lite", "pro", "max") */
  planLevel?: string;
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

// ── Service ────────────────────────────────────────────────────────────────

export class UsageService {
  private readonly baseUrl = 'https://api.z.ai';

  constructor(private apiKey: string) {}

  updateApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  /**
   * Fetch quota limits. This is the only Z.ai monitor call the extension makes:
   * the status bar renders token windows from `quota/limit`, and every additional
   * call multiplies against the auto-refresh timer.
   */
  async fetchUsage(): Promise<FetchResult> {
    if (!this.apiKey) {
      return { success: false, error: 'API key not configured' };
    }

    try {
      const quotaResp = await this.fetchEndpoint(`${this.baseUrl}/api/monitor/usage/quota/limit`);

      const tokenQuotas: TokenQuota[] = [];
      const timeLimits: TimeLimit[] = [];

      if (quotaResp) {
        for (const lim of quotaResp.limits ?? []) {
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
              windowName: `${formatWindowName(lim.unit, lim.number)} MCP Tools`,
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

      return {
        success: true,
        data: {
          tokenQuotas,
          timeLimits,
          planLevel: quotaResp?.level,
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
   * Fetch JSON from a monitor endpoint. Z.ai monitor APIs authenticate with an
   * HTTP Bearer header (verified against api.z.ai; a raw key is rejected).
   */
  private async fetchEndpoint(url: string): Promise<QuotaLimitResponse | null> {
    const body = await got(url, {
      method: 'GET',
      headers: {
        'Accept-Language': 'en-US,en',
        Authorization: `Bearer ${this.apiKey}`,
      },
      timeout: { request: 15_000 },
      retry: { limit: 1 },
    }).text();

    const parsed = JSON.parse(body);
    return (parsed.data ?? parsed) as QuotaLimitResponse;
  }
}

// ── Pure helpers ───────────────────────────────────────────────────────────

function formatWindowName(unit: number, number: number): string {
  const names: Record<number, string> = { 3: 'Hour', 5: 'Month', 6: 'Week' };
  const name = names[unit] ?? 'Unknown';
  return `${number}-${name}${number > 1 ? 's' : ''}`;
}
