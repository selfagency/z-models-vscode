// biome-ignore lint/suspicious/noExplicitAny: Necessary for testing private methods.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { window } from 'vscode';
import { ZChatModelProvider } from '../../provider.js';

const mockContext = {
  secrets: {
    get: vi.fn().mockResolvedValue(undefined),
    store: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    onDidChange: vi.fn(),
  },
  subscriptions: [],
} as any;

describe('ZChatModelProvider — Initialization Logic', () => {
  it('should initialize client with stored API key', async () => {
    const mockApiKey = 'test-api-key';
    vi.spyOn(mockContext.secrets, 'get').mockResolvedValue(mockApiKey);

    const provider = new ZChatModelProvider(mockContext, undefined, false);
    const result = await provider['initClient'](true);
    expect(result).toBe(true);
  });

  it('should prompt for API key if not stored', async () => {
    vi.spyOn(mockContext.secrets, 'get').mockResolvedValue(undefined);
    const mockApiKey = 'test-api-key';
    vi.spyOn(window, 'showInputBox').mockResolvedValue(mockApiKey);
    vi.spyOn(mockContext.secrets, 'store').mockResolvedValue(undefined);

    const provider = new ZChatModelProvider(mockContext, undefined, false);
    const result = await provider['initClient'](false);
    expect(result).toBe(true);
    expect(window.showInputBox).toHaveBeenCalled();
  });
});

describe('ZChatModelProvider — Initialization Edge Cases', () => {
  let provider: ZChatModelProvider;

  beforeEach(() => {
    provider = new ZChatModelProvider(mockContext);
  });

  it('should handle initialization with stored API key', async () => {
    const mockApiKey = 'test-api-key';
    vi.spyOn(mockContext.secrets, 'get').mockResolvedValue(mockApiKey);

    const result = await provider['initClient'](true);
    expect(result).toBe(true);
  });

  it('should handle initialization without stored API key and silent mode', async () => {
    vi.spyOn(mockContext.secrets, 'get').mockResolvedValue(undefined);

    const result = await provider['initClient'](true);
    expect(result).toBe(false);
  });

  it('should handle initialization with user cancellation', async () => {
    vi.spyOn(mockContext.secrets, 'get').mockResolvedValue(undefined);
    vi.spyOn(window, 'showInputBox').mockResolvedValue(undefined);

    const result = await provider['initClient'](false);
    expect(result).toBe(false);
  });

  it('should handle initialization with user-provided API key', async () => {
    vi.spyOn(mockContext.secrets, 'get').mockResolvedValue(undefined);
    const mockApiKey = 'test-api-key';
    vi.spyOn(window, 'showInputBox').mockResolvedValue(mockApiKey);
    vi.spyOn(mockContext.secrets, 'store').mockResolvedValue(undefined);

    const result = await provider['initClient'](false);
    expect(result).toBe(true);
    expect(mockContext.secrets.store).toHaveBeenCalledWith('Z_API_KEY', mockApiKey);
  });
});
