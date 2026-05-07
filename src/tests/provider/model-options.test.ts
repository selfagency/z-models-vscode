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

describe('ZChatModelProvider — model options helper', () => {
  let provider: ZChatModelProvider;

  const baseModel = {
    id: 'glm-5.1',
    name: 'GLM 5.1',
    maxInputTokens: 128000,
    maxOutputTokens: 16384,
    defaultCompletionTokens: 65536,
    toolCalling: true,
    supportsParallelToolCalls: true,
    supportsVision: true,
    temperature: 0.7,
  };

  beforeEach(() => {
    provider = new ZChatModelProvider(mockContext, undefined, false);
  });

  it('parses supported modelOptions into normalized request options', () => {
    const nonCompulsoryModel = { ...baseModel, id: 'glm-4.6' };
    const parsed = (provider as any).parseModelOptions(
      {
        temperature: 0.2,
        topP: 0.9,
        safePrompt: true,
        doSample: false,
        stop: ['first-stop', 'second-stop'],
        userId: 'user-123',
        thinkingType: 'disabled',
        clearThinking: false,
        jsonMode: true,
        webSearch: true,
      },
      nonCompulsoryModel,
    );

    expect(parsed.temperature).toBe(0.2);
    expect(parsed.topP).toBe(0.9);
    expect(parsed.safePrompt).toBe(true);
    expect(parsed.doSample).toBe(false);
    expect(parsed.stop).toEqual(['first-stop']);
    expect(parsed.userId).toBe('user-123');
    expect(parsed.thinking).toEqual({ type: 'disabled', clear_thinking: false });
    expect(parsed.responseFormat).toEqual({ type: 'json_object' });
    expect(parsed.webSearchTool).toBeDefined();
    expect(parsed.webSearchTool.type).toBe('web_search');
  });

  it('uses correct Z.ai search_engine enum value when web search enabled', () => {
    const parsed = (provider as any).parseModelOptions({ webSearch: true }, baseModel);

    expect(parsed.webSearchTool).toBeDefined();
    expect(parsed.webSearchTool.web_search).toBeDefined();
    expect(parsed.webSearchTool.web_search.search_engine).toBe('search_pro_jina');
  });

  it('ignores explicit thinking disabled for compulsory-thinking models', () => {
    const logWarnSpy = vi.spyOn((provider as any).log, 'warn');

    const parsed = (provider as any).parseModelOptions({ thinkingType: 'disabled' }, baseModel);

    expect(parsed.thinking).toBeUndefined();
    expect(logWarnSpy).toHaveBeenCalledWith('[Z] Model glm-5.1 thinks compulsorily; ignoring thinking=disabled.');
  });
});
