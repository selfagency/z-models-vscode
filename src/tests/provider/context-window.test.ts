import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getKnownTokenLimits, modelThinksCompulsorily, ZChatModelProvider } from '../../provider.js';

vi.mock('got', () => ({
  default: {
    get: vi.fn(),
  },
}));

type GotGetMock = { get: { mockReturnValue: (v: unknown) => void } };

type ProviderWithPrivates = {
  userAgent: string;
  client: unknown;
  fetchModelTokenLimits: (model: string) => Promise<{ maxInputTokens: number; maxOutputTokens: number }>;
};

const mockContext = {
  secrets: {
    get: vi.fn().mockResolvedValue('test-key'),
    store: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    onDidChange: vi.fn(),
  },
  subscriptions: [],
} as unknown as import('vscode').ExtensionContext;

describe('context-window correctness (issue #12)', () => {
  let provider: ZChatModelProvider;

  beforeEach(() => {
    provider = new ZChatModelProvider(mockContext, undefined, false);
    const priv = provider as unknown as ProviderWithPrivates;
    priv.userAgent = 'z-models-vscode/test';
    priv.client = {}; // non-null so fetchModelTokenLimits proceeds
    vi.clearAllMocks();
  });

  it('getKnownTokenLimits returns hardcoded limits for glm-5.3', () => {
    expect(getKnownTokenLimits('glm-5.3')).toEqual({ maxInputTokens: 1000000, maxOutputTokens: 128000 });
  });

  it('getKnownTokenLimits returns hardcoded limits for glm-5.3-flash', () => {
    expect(getKnownTokenLimits('glm-5.3-flash')).toEqual({ maxInputTokens: 1000000, maxOutputTokens: 128000 });
  });

  it('getKnownTokenLimits returns hardcoded limits for glm-5.3-flashx', () => {
    expect(getKnownTokenLimits('glm-5.3-flashx')).toEqual({ maxInputTokens: 1000000, maxOutputTokens: 128000 });
  });

  it('modelThinksCompulsorily is true for glm-5.3-flash', () => {
    expect(modelThinksCompulsorily('glm-5.3-flash')).toBe(true);
  });

  it('modelThinksCompulsorily does not match future patch releases by prefix accident', () => {
    expect(modelThinksCompulsorily('glm-5.10')).toBe(false);
    expect(modelThinksCompulsorily('glm-5.4')).toBe(false);
  });

  it('modelThinksCompulsorily is true for glm-5.3 and glm-5.2', () => {
    expect(modelThinksCompulsorily('glm-5.3')).toBe(true);
    expect(modelThinksCompulsorily('glm-5.2')).toBe(true);
  });

  it('maps max_tokens to maxOutputTokens and falls back for maxInputTokens', async () => {
    const { default: got } = await import('got');
    (got as unknown as GotGetMock).get.mockReturnValue({ json: vi.fn().mockResolvedValue({ max_tokens: 65536 }) });
    const limits = await (provider as unknown as ProviderWithPrivates).fetchModelTokenLimits('glm-5.3');
    expect(limits.maxInputTokens).toBe(1000000); // hardcoded fallback, NOT 65536
    expect(limits.maxOutputTokens).toBe(65536);
  });

  it('uses context_window for input and max_completion_tokens for output', async () => {
    const { default: got } = await import('got');
    (got as unknown as GotGetMock).get.mockReturnValue({ json: vi.fn().mockResolvedValue({ context_window: 1000000, max_completion_tokens: 131072 }) });
    const limits = await (provider as unknown as ProviderWithPrivates).fetchModelTokenLimits('glm-5.2');
    expect(limits.maxInputTokens).toBe(1000000);
    expect(limits.maxOutputTokens).toBe(131072);
  });

  it('does not let an under-reported context_window shrink glm-5.3-flash below the documented 1M window', async () => {
    const { default: got } = await import('got');
    (got as unknown as GotGetMock).get.mockReturnValue({ json: vi.fn().mockResolvedValue({ context_window: 32768 }) });
    const limits = await (provider as unknown as ProviderWithPrivates).fetchModelTokenLimits('glm-5.3-flash');
    expect(limits.maxInputTokens).toBe(1000000);
  });

  it('keeps a larger API context_window when the API exceeds the documented value', async () => {
    const { default: got } = await import('got');
    (got as unknown as GotGetMock).get.mockReturnValue({ json: vi.fn().mockResolvedValue({ context_window: 2000000 }) });
    const limits = await (provider as unknown as ProviderWithPrivates).fetchModelTokenLimits('glm-5.3-flashx');
    expect(limits.maxInputTokens).toBe(2000000);
  });
});
