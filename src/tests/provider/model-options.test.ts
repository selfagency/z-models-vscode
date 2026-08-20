import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZChatModelProvider } from '../../provider.js';

type ProviderWithParse = {
  parseModelOptions: (raw: unknown, model: unknown) => {
    temperature?: number;
    topP?: number;
    safePrompt?: boolean;
    doSample?: boolean;
    stop?: string[];
    userId?: string;
    thinking?: unknown;
    responseFormat?: unknown;
    webSearchTool?: { type: 'web_search'; web_search: Record<string, unknown> };
    reasoningEffort?: string;
  };
  log: { warn: ReturnType<typeof vi.fn> };
};

const mockContext = {
  secrets: {
    get: vi.fn().mockResolvedValue(undefined),
    store: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    onDidChange: vi.fn(),
  },
  subscriptions: [],
} as unknown as import('vscode').ExtensionContext;

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

  const parse = (raw: unknown, model: unknown) =>
    (provider as unknown as ProviderWithParse).parseModelOptions(raw, model);

  it('parses supported modelOptions into normalized request options', () => {
    const nonCompulsoryModel = { ...baseModel, id: 'glm-4.6' };
    const parsed = parse(
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
    expect(parsed.webSearchTool?.type).toBe('web_search');
  });

  it('uses correct Z.ai search_engine enum value when web search enabled', () => {
    const parsed = parse({ webSearch: true }, baseModel);

    expect(parsed.webSearchTool).toBeDefined();
    expect(parsed.webSearchTool?.web_search).toBeDefined();
    expect(parsed.webSearchTool?.web_search.search_engine).toBe('search_pro_jina');
  });

  it('ignores explicit thinking disabled for compulsory-thinking models', () => {
    const logWarnSpy = vi.spyOn((provider as unknown as ProviderWithParse).log, 'warn');

    const parsed = parse({ thinkingType: 'disabled' }, baseModel);

    expect(parsed.thinking).toBeUndefined();
    expect(logWarnSpy).toHaveBeenCalledWith('[Z] Model glm-5.1 thinks compulsorily; ignoring thinking=disabled.');
  });

  it('passes reasoning_effort into request body for glm-5.2 when thinking enabled', async () => {
    const glm52 = { ...baseModel, id: 'glm-5.2' };
    const parsed = parse({ thinkingType: 'enabled', reasoning_effort: 'low' }, glm52);
    expect(parsed.thinking).toEqual({ type: 'enabled', clear_thinking: false });
    expect(parsed.reasoningEffort).toBe('low');
  });

  it('accepts reasoning_effort low for glm-5.3', () => {
    const glm53 = { ...baseModel, id: 'glm-5.3' };
    const parsed = parse({ thinkingType: 'enabled', reasoning_effort: 'low' }, glm53);
    expect(parsed.reasoningEffort).toBe('low');
  });

  it('rejects xhigh for glm-5.3 and omits reasoning_effort', () => {
    const logWarnSpy = vi.spyOn((provider as unknown as ProviderWithParse).log, 'warn');
    const glm53 = { ...baseModel, id: 'glm-5.3' };
    const parsed = parse({ thinkingType: 'enabled', reasoning_effort: 'xhigh' }, glm53);
    expect(parsed.reasoningEffort).toBeUndefined();
    expect(logWarnSpy).toHaveBeenCalledWith(
      "[Z] Model glm-5.3 does not support reasoning_effort='xhigh'; ignoring.",
    );
  });

  it('omits reasoning_effort when thinking is disabled', () => {
    const nonCompulsory = { ...baseModel, id: 'glm-4.6' };
    const parsed = parse({ thinkingType: 'disabled', reasoning_effort: 'low' }, nonCompulsory);
    expect(parsed.thinking).toEqual({ type: 'disabled', clear_thinking: false });
    expect(parsed.reasoningEffort).toBeUndefined();
  });
});
