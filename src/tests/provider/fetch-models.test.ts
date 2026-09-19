// biome-ignore lint/suspicious/noExplicitAny: Necessary for testing private methods.

// biome-ignore lint/suspicious/noExplicitAny: Necessary for testing private methods.

import { beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('ZChatModelProvider — fetchModels', () => {
  let provider: ZChatModelProvider;

  beforeEach(() => {
    provider = new ZChatModelProvider(mockContext, undefined, false);
  });

  it('maps API fields to ZModel correctly', async () => {
    const chatModel = {
      id: 'glm-large-latest',
      name: 'Z Large',
      detail: 'Flagship model',
      maxInputTokens: 128000,
      maxOutputTokens: 16384,
      toolCalling: true,
      supportsParallelToolCalls: true,
      supportsVision: true,
    };
    const mockList = vi.fn().mockResolvedValue({ data: [chatModel] });
    (provider as any).client = { models: { list: mockList } };

    const models = await provider.fetchModels();
    expect(models).toHaveLength(1);
    expect(models[0].name).toBe('Z Large');
    expect(models[0].detail).toBe('Flagship model');
  });

  it('infers tool calling for bare GLM models when the API only returns ids', async () => {
    const mockList = vi.fn().mockResolvedValue({
      data: [{ id: 'glm-5.1', object: 'model', created: 1, owned_by: 'z-ai' }],
    });
    (provider as any).client = { models: { list: mockList } };

    const [model] = await provider.fetchModels();
    expect(model.toolCalling).toBe(true);
  });

  it('reports the documented 1M window for glm-5.3-flash instead of the 32K default', async () => {
    const mockList = vi.fn().mockResolvedValue({
      data: [{ id: 'glm-5.3-flash', object: 'model', created: 1, owned_by: 'z-ai' }],
    });
    (provider as any).client = { models: { list: mockList } };

    const [model] = await provider.fetchModels();
    expect(model.maxInputTokens).toBe(1_000_000);
    expect(model.maxInputTokens).not.toBe(32768);
    expect(model.maxOutputTokens).toBe(128_000);
    expect(model.supportsVision).toBe(true);
  });

  it('reports the documented 1M window for glm-5.3-flashx', async () => {
    const mockList = vi.fn().mockResolvedValue({
      data: [{ id: 'glm-5.3-flashx', object: 'model', created: 1, owned_by: 'z-ai' }],
    });
    (provider as any).client = { models: { list: mockList } };

    const [model] = await provider.fetchModels();
    expect(model.maxInputTokens).toBe(1_000_000);
    expect(model.maxInputTokens).not.toBe(32768);
  });

  it('does not let an under-reported model-list window shrink glm-5.3-flash', async () => {
    const mockList = vi.fn().mockResolvedValue({
      data: [{ id: 'glm-5.3-flash', object: 'model', created: 1, owned_by: 'z-ai', maxInputTokens: 32768 }],
    });
    (provider as any).client = { models: { list: mockList } };

    const [model] = await provider.fetchModels();
    expect(model.maxInputTokens).toBe(1_000_000);
  });
});

describe('ZChatModelProvider — Fetch Models Edge Cases', () => {
  let provider: ZChatModelProvider;

  beforeEach(() => {
    provider = new ZChatModelProvider(mockContext, undefined, false);
  });

  it('should handle API failure during model fetch', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const mockList = vi.fn().mockRejectedValue(new Error('API error'));
    (provider as any).client = { models: { list: mockList } };

    const models = await provider.fetchModels();
    expect(models).toEqual([]);
  });

  it('should handle empty model list from API', async () => {
    const mockList = vi.fn().mockResolvedValue({ data: [] });
    (provider as any).client = { models: { list: mockList } };

    const models = await provider.fetchModels();
    expect(models).toEqual([]);
  });
});
