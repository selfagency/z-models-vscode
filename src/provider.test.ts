import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    LanguageModelChatMessageRole,
    LanguageModelDataPart,
    LanguageModelTextPart,
    LanguageModelToolCallPart,
    LanguageModelToolResultPart,
    window,
} from 'vscode';
import { formatModelName, getChatModelInfo, toZRole, ZChatModelProvider } from './provider.js';

// ── Shared mock context ───────────────────────────────────────────────────────

const mockContext = {
  secrets: {
    get: vi.fn().mockResolvedValue(undefined),
    store: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    onDidChange: vi.fn(),
  },
  subscriptions: [],
} as any;

// ── formatModelName ───────────────────────────────────────────────────────────

describe('formatModelName', () => {
  it('capitalises a single segment', () => {
    expect(formatModelName('z')).toBe('Z');
  });

  it('capitalises each hyphen-separated segment', () => {
    expect(formatModelName('z-large-latest')).toBe('Z Large Latest');
  });

  it('handles numeric segments without error', () => {
    expect(formatModelName('devstral-small-2505')).toBe('Devstral Small 2505');
  });
});

// ── getChatModelInfo ──────────────────────────────────────────────────────────

describe('getChatModelInfo', () => {
  const base = {
    id: 'z-large-latest',
    name: 'Z Large',
    maxInputTokens: 128000,
    maxOutputTokens: 16384,
    defaultCompletionTokens: 65536,
    toolCalling: true,
    supportsParallelToolCalls: true,
    supportsVision: true,
  };

  it('maps all fields correctly', () => {
    const info = getChatModelInfo(base);
    expect(info.id).toBe('z-large-latest');
    expect(info.name).toBe('Z Large');
    expect(info.family).toBe('z-large');
    expect(info.version).toBe('z-large-latest');
    expect(info.maxInputTokens).toBe(128000);
    expect(info.maxOutputTokens).toBe(16384);
    expect(info.capabilities?.toolCalling).toBe(true);
    expect(info.capabilities?.imageInput).toBe(true);
  });

  it('tooltip is omitted so detail field is shown in the chat picker', () => {
    const info = getChatModelInfo({ ...base, detail: 'Latest flagship' });
    expect(info.tooltip).toBeUndefined();
  });

  it('imageInput is false when supportsVision is false', () => {
    const info = getChatModelInfo({ ...base, supportsVision: false });
    expect(info.capabilities?.imageInput).toBe(false);
  });

  it('imageInput is false when supportsVision is undefined', () => {
    const { supportsVision: _, ...noVision } = base;
    const info = getChatModelInfo(noVision as any);
    expect(info.capabilities?.imageInput).toBe(false);
  });
});

// ── toZRole ─────────────────────────────────────────────────────────────

describe('toZRole', () => {
  it('maps User to "user"', () => {
    expect(toZRole(LanguageModelChatMessageRole.User)).toBe('user');
  });

  it('maps Assistant to "assistant"', () => {
    expect(toZRole(LanguageModelChatMessageRole.Assistant)).toBe('assistant');
  });

  it('maps unknown values to "user"', () => {
    expect(toZRole(99 as any)).toBe('user');
  });
});

// ── Tool call ID mapping ──────────────────────────────────────────────────────

describe('ZChatModelProvider — tool call ID mapping', () => {
  let provider: ZChatModelProvider;

  beforeEach(() => {
    provider = new ZChatModelProvider(mockContext);
  });

  describe('generateToolCallId', () => {
    it('returns a 9-character string', () => {
      expect(provider.generateToolCallId()).toHaveLength(9);
    });

    it('returns only alphanumeric characters', () => {
      const id = provider.generateToolCallId();
      expect(id).toMatch(/^[a-zA-Z0-9]{9}$/);
    });

    it('produces unique IDs across calls', () => {
      const ids = new Set(Array.from({ length: 20 }, () => provider.generateToolCallId()));
      expect(ids.size).toBeGreaterThan(1);
    });
  });

  describe('getOrCreateVsCodeToolCallId', () => {
    it('returns a 9-character alphanumeric ID for a new Z ID', () => {
      const id = provider.getOrCreateVsCodeToolCallId('z-abc');
      expect(id).toMatch(/^[a-zA-Z0-9]{9}$/);
    });

    it('returns the same VS Code ID for the same Z ID (idempotent)', () => {
      const first = provider.getOrCreateVsCodeToolCallId('z-abc');
      const second = provider.getOrCreateVsCodeToolCallId('z-abc');
      expect(first).toBe(second);
    });

    it('creates distinct VS Code IDs for different Z IDs', () => {
      const a = provider.getOrCreateVsCodeToolCallId('z-aaa');
      const b = provider.getOrCreateVsCodeToolCallId('z-bbb');
      expect(a).not.toBe(b);
    });

    it('registers the bidirectional mapping so getZToolCallId resolves back', () => {
      const vsCodeId = provider.getOrCreateVsCodeToolCallId('z-xyz');
      expect(provider.getZToolCallId(vsCodeId)).toBe('z-xyz');
    });
  });

  describe('getZToolCallId', () => {
    it('returns the Z ID for a known VS Code ID', () => {
      const vsCodeId = provider.getOrCreateVsCodeToolCallId('z-known');
      expect(provider.getZToolCallId(vsCodeId)).toBe('z-known');
    });

    it('returns undefined for an unknown VS Code ID', () => {
      expect(provider.getZToolCallId('unknown-id')).toBeUndefined();
    });

    it('returns the Z ID for a known VS Code ID', () => {
      const zId = 'z-id-1';
      const vsCodeId = provider.getOrCreateVsCodeToolCallId(zId);

      const result = provider.getZToolCallId(vsCodeId);
      expect(result).toBe(zId);
    });

    it('returns undefined for an unknown VS Code ID', () => {
      const result = provider.getZToolCallId('unknown-id');
      expect(result).toBeUndefined();
    });

    it('handles empty VS Code ID', () => {
      const result = provider.getZToolCallId('');
      expect(result).toBeUndefined();
    });

    it('handles VS Code ID with special characters', () => {
      const result = provider.getZToolCallId('vs-code-id-!@#$%^&*()');
      expect(result).toBeUndefined();
    });
  });

  describe('clearToolCallIdMappings', () => {
    it('makes previously mapped IDs no longer resolvable', () => {
      const vsCodeId = provider.getOrCreateVsCodeToolCallId('z-to-clear');
      provider.clearToolCallIdMappings();
      expect(provider.getZToolCallId(vsCodeId)).toBeUndefined();
    });

    it('subsequent getOrCreate after clear creates a fresh (possibly different) ID', () => {
      const before = provider.getOrCreateVsCodeToolCallId('z-refresh');
      provider.clearToolCallIdMappings();
      const after = provider.getOrCreateVsCodeToolCallId('z-refresh');
      expect(after).toMatch(/^[a-zA-Z0-9]{9}$/);
      expect(provider.getZToolCallId(before)).toBeUndefined();
    });

    it('handles many mappings without losing round-trip consistency', () => {
      const pairs: Array<{ z: string; vs: string }> = [];
      for (let i = 0; i < 200; i++) {
        const z = `z-${i}`;
        const vs = provider.getOrCreateVsCodeToolCallId(z);
        pairs.push({ z, vs });
      }

      for (const pair of pairs) {
        expect(provider.getZToolCallId(pair.vs)).toBe(pair.z);
      }
    });

    it('keeps same VS Code id when repeated z id is requested many times', () => {
      const first = provider.getOrCreateVsCodeToolCallId('z-collision');
      for (let i = 0; i < 50; i++) {
        expect(provider.getOrCreateVsCodeToolCallId('z-collision')).toBe(first);
      }
    });
  });
});

// ── fetchModels ───────────────────────────────────────────────────────────────

describe('ZChatModelProvider — fetchModels', () => {
  let provider: ZChatModelProvider;

  const chatModel = {
    id: 'z-large-latest',
    name: 'Z Large',
    description: 'Flagship model',
    maxContextLength: 128000,
    defaultModelTemperature: 0.7,
    capabilities: { completionChat: true, functionCalling: true, vision: true },
  };

  const embedModel = {
    id: 'z-embed',
    name: null,
    description: null,
    maxContextLength: 8192,
    defaultModelTemperature: null,
    capabilities: { completionChat: false, functionCalling: false, vision: false },
  };

  beforeEach(() => {
    provider = new ZChatModelProvider(mockContext);
  });

  it('returns empty array when no client is set', async () => {
    const models = await provider.fetchModels();
    expect(models).toEqual([]);
  });

  it('filters out models without completionChat capability', async () => {
    const mockList = vi.fn().mockResolvedValue({ data: [chatModel, embedModel] });
    (provider as any).client = { models: { list: mockList } };

    const models = await provider.fetchModels();
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('z-large-latest');
  });

  it('maps API fields to ZModel correctly', async () => {
    const mockList = vi.fn().mockResolvedValue({ data: [chatModel] });
    (provider as any).client = { models: { list: mockList } };

    const [model] = await provider.fetchModels();
    expect(model.name).toBe('Z Large');
    expect(model.detail).toBe('Flagship model');
    expect(model.maxInputTokens).toBe(128000);
    expect(model.toolCalling).toBe(true);
    expect(model.supportsParallelToolCalls).toBe(true);
    expect(model.supportsVision).toBe(true);
    expect(model.temperature).toBe(0.7);
  });

  it('infers tool calling for bare GLM models when the API only returns ids', async () => {
    const mockList = vi.fn().mockResolvedValue({
      data: [{ id: 'glm-5.1', object: 'model', created: 1, owned_by: 'z-ai' }],
    });
    (provider as any).client = { models: { list: mockList } };

    const [model] = await provider.fetchModels();
    expect(model.id).toBe('glm-5.1');
    expect(model.toolCalling).toBe(true);
    expect(model.supportsParallelToolCalls).toBe(true);
    expect(model.supportsVision).toBe(false);
    expect(model.maxInputTokens).toBe(200000);
    expect(model.maxOutputTokens).toBe(128000);
  });

  it('infers vision support for vision-flavored model ids when metadata is missing', async () => {
    const mockList = vi.fn().mockResolvedValue({
      data: [{ id: 'glm-4.5v', object: 'model', created: 1, owned_by: 'z-ai' }],
    });
    (provider as any).client = { models: { list: mockList } };

    const [model] = await provider.fetchModels();
    expect(model.id).toBe('glm-4.5v');
    expect(model.toolCalling).toBe(true);
    expect(model.supportsVision).toBe(true);
  });

  it('uses documented 128k context fallback for glm-4.6v bare ids', async () => {
    const mockList = vi.fn().mockResolvedValue({
      data: [{ id: 'glm-4.6v', object: 'model', created: 1, owned_by: 'z-ai' }],
    });
    (provider as any).client = { models: { list: mockList } };

    const [model] = await provider.fetchModels();
    expect(model.id).toBe('glm-4.6v');
    expect(model.maxInputTokens).toBe(128000);
  });

  it('falls back to formatModelName when name is null', async () => {
    const noName = { ...chatModel, name: null };
    const mockList = vi.fn().mockResolvedValue({ data: [noName] });
    (provider as any).client = { models: { list: mockList } };

    const [model] = await provider.fetchModels();
    expect(model.name).toBe('Z Large Latest');
  });

  it('caches the result — second call does not hit the API', async () => {
    const mockList = vi.fn().mockResolvedValue({ data: [chatModel] });
    (provider as any).client = { models: { list: mockList } };

    await provider.fetchModels();
    await provider.fetchModels();
    expect(mockList).toHaveBeenCalledTimes(1);
  });

  it('returns empty array and does not throw on API error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const mockList = vi.fn().mockRejectedValue(new Error('network error'));
    (provider as any).client = { models: { list: mockList } };

    const models = await provider.fetchModels();
    expect(models).toEqual([]);
  });

  it('fires onDidChangeLanguageModelChatInformation after a successful fetch', async () => {
    const mockList = vi.fn().mockResolvedValue({ data: [chatModel] });
    (provider as any).client = { models: { list: mockList } };

    const listener = vi.fn();
    provider.onDidChangeLanguageModelChatInformation(listener);

    await provider.fetchModels();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not fire onDidChangeLanguageModelChatInformation when serving from cache', async () => {
    const mockList = vi.fn().mockResolvedValue({ data: [chatModel] });
    (provider as any).client = { models: { list: mockList } };

    const listener = vi.fn();
    provider.onDidChangeLanguageModelChatInformation(listener);

    await provider.fetchModels();
    await provider.fetchModels();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not fire onDidChangeLanguageModelChatInformation on API error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const mockList = vi.fn().mockRejectedValue(new Error('network error'));
    (provider as any).client = { models: { list: mockList } };

    const listener = vi.fn();
    provider.onDidChangeLanguageModelChatInformation(listener);

    await provider.fetchModels();
    expect(listener).not.toHaveBeenCalled();
  });

  it('cache is cleared when fetchedModels is reset to null', async () => {
    const mockList = vi.fn().mockResolvedValue({ data: [chatModel] });
    (provider as any).client = { models: { list: mockList } };
    await provider.fetchModels();

    (provider as any).fetchedModels = null;
    (provider as any).client = { models: { list: mockList } };

    await provider.fetchModels();
    expect(mockList).toHaveBeenCalledTimes(2);
  });
});

// ── Fetch Models Edge Cases ──────────────────────────────────────────────

describe('Fetch Models Edge Cases', () => {
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

  it('should handle models without completionChat capability', async () => {
    const mockList = vi.fn().mockResolvedValue({
      data: [
        {
          id: 'test-model',
          name: 'Test Model',
          description: 'Test Description',
          maxContextLength: 1000,
          defaultModelTemperature: 0.7,
          capabilities: { completionChat: false, functionCalling: false, vision: false },
        },
      ],
    });
    (provider as any).client = { models: { list: mockList } };

    const models = await provider.fetchModels();
    expect(models).toEqual([]);
  });

  it('should handle models with missing fields', async () => {
    const mockList = vi.fn().mockResolvedValue({
      data: [
        {
          id: 'test-model',
          name: null,
          description: null,
          maxContextLength: null,
          defaultModelTemperature: null,
          capabilities: { completionChat: true, functionCalling: false, vision: false },
        },
      ],
    });
    (provider as any).client = { models: { list: mockList } };

    const models = await provider.fetchModels();
    expect(models).toHaveLength(1);
    expect(models[0].name).toBe('Test Model');
  });
});

// ── toZMessages ─────────────────────────────────────────────────────────

describe('ZChatModelProvider — toZMessages', () => {
  let provider: ZChatModelProvider;

  function userMsg(...parts: any[]) {
    return { role: LanguageModelChatMessageRole.User, content: parts, name: undefined };
  }
  function assistantMsg(...parts: any[]) {
    return { role: LanguageModelChatMessageRole.Assistant, content: parts, name: undefined };
  }

  beforeEach(() => {
    provider = new ZChatModelProvider(mockContext);
  });

  it('converts a plain text user message', () => {
    const msgs = provider.toZMessages([userMsg(new LanguageModelTextPart('Hello'))]);
    expect(msgs).toEqual([{ role: 'user', content: 'Hello' }]);
  });

  it('concatenates multiple text parts into one string', () => {
    const msgs = provider.toZMessages([
      userMsg(new LanguageModelTextPart('Hello'), new LanguageModelTextPart(' world')),
    ]);
    expect(msgs).toEqual([{ role: 'user', content: 'Hello world' }]);
  });

  it('converts a plain text assistant message', () => {
    const msgs = provider.toZMessages([assistantMsg(new LanguageModelTextPart('Hi'))]);
    expect(msgs).toEqual([{ role: 'assistant', content: 'Hi', tool_calls: undefined }]);
  });

  it('skips empty user messages', () => {
    const msgs = provider.toZMessages([userMsg()]);
    expect(msgs).toHaveLength(0);
  });

  it('skips empty assistant messages (no content, no tool calls)', () => {
    const msgs = provider.toZMessages([assistantMsg()]);
    expect(msgs).toHaveLength(0);
  });

  it('converts an assistant message with a tool call', () => {
    const toolCall = new LanguageModelToolCallPart('vsCode-id-1', 'search_files', { query: 'foo' });
    const msgs = provider.toZMessages([assistantMsg(toolCall)]);

    expect(msgs).toHaveLength(1);
    const msg = msgs[0] as any;
    expect(msg.role).toBe('assistant');
    expect(msg.content).toBeNull();
    expect(msg.tool_calls).toHaveLength(1);
    expect(msg.tool_calls[0].type).toBe('function');
    expect(msg.tool_calls[0].function.name).toBe('search_files');
    expect(JSON.parse(msg.tool_calls[0].function.arguments)).toEqual({ query: 'foo' });
  });

  it('converts a tool result message into role="tool"', () => {
    const toolCall = new LanguageModelToolCallPart('vsCode-id-2', 'read_file', { path: '/foo' });
    const toolResult = new LanguageModelToolResultPart('vsCode-id-2', [new LanguageModelTextPart('file contents')]);

    const msgs = provider.toZMessages([assistantMsg(toolCall), userMsg(toolResult)]);

    const toolMsg = msgs.find((m: any) => m.role === 'tool') as any;
    expect(toolMsg).toBeDefined();
    expect(toolMsg.content).toBe('file contents');
    expect(typeof toolMsg.tool_call_id).toBe('string');
  });

  it('uses text content for tool result when available', () => {
    const toolCall = new LanguageModelToolCallPart('id-3', 'fn', {});
    const toolResult = new LanguageModelToolResultPart('id-3', [new LanguageModelTextPart('result text')]);

    const msgs = provider.toZMessages([assistantMsg(toolCall), userMsg(toolResult)]);
    const toolMsg = msgs.find((m: any) => m.role === 'tool') as any;
    expect(toolMsg.content).toBe('result text');
  });

  it('encodes image data parts as base64 imageUrl chunks', () => {
    const imageData = new Uint8Array([1, 2, 3]);
    const imgPart = new LanguageModelDataPart(imageData, 'image/png');
    const msgs = provider.toZMessages([userMsg(imgPart)]);

    expect(msgs).toHaveLength(1);
    const content = (msgs[0] as any).content as any[];
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe('image_url');
    expect(content[0].imageUrl).toMatch(/^data:image\/png;base64,/);
  });

  it('stringifies non-image data parts as text placeholder', () => {
    const dataPart = new LanguageModelDataPart(new Uint8Array([0]), 'application/pdf');
    const msgs = provider.toZMessages([userMsg(dataPart)]);

    expect(msgs).toHaveLength(1);
    expect((msgs[0] as any).content).toBe('[data:application/pdf]');
  });

  it('includes both text and image in a multimodal message', () => {
    const imageData = new Uint8Array([9, 8, 7]);
    const msgs = provider.toZMessages([
      userMsg(new LanguageModelTextPart('Look at this:'), new LanguageModelDataPart(imageData, 'image/jpeg')),
    ]);

    const content = (msgs[0] as any).content as any[];
    expect(content[0]).toEqual({ type: 'text', text: 'Look at this:' });
    expect(content[1].type).toBe('image_url');
  });

  it('assistant message with both text and tool calls includes both', () => {
    const toolCall = new LanguageModelToolCallPart('id-4', 'fn', {});
    const msgs = provider.toZMessages([assistantMsg(new LanguageModelTextPart('thinking...'), toolCall)]);

    const msg = msgs[0] as any;
    expect(msg.content).toBe('thinking...');
    expect(msg.tool_calls).toHaveLength(1);
  });
});

// ── toZMessages Edge Cases ────────────────────────────────────────────

describe('toZMessages Edge Cases', () => {
  let provider: ZChatModelProvider;

  function userMsg(...parts: any[]) {
    return { role: LanguageModelChatMessageRole.User, content: parts, name: undefined };
  }
  function assistantMsg(...parts: any[]) {
    return { role: LanguageModelChatMessageRole.Assistant, content: parts, name: undefined };
  }

  beforeEach(() => {
    provider = new ZChatModelProvider(mockContext, undefined, false);
  });

  it('should handle messages with mixed content types', () => {
    const textPart = new LanguageModelTextPart('Hello');
    const toolCall = new LanguageModelToolCallPart('test-id', 'test-function', { key: 'value' });
    const msgs = provider['toZMessages']([assistantMsg(textPart, toolCall)]);

    expect(msgs).toHaveLength(1);
    const msg = msgs[0] as any;
    expect(msg.role).toBe('assistant');
    expect(msg.content).toBe('Hello');
    expect(msg.tool_calls).toHaveLength(1);
  });

  it('should handle messages with multiple tool results', () => {
    const toolCall1 = new LanguageModelToolCallPart('test-id-1', 'test-function-1', { key: 'value' });
    const toolResult1 = new LanguageModelToolResultPart('test-id-1', [new LanguageModelTextPart('result1')]);
    const toolCall2 = new LanguageModelToolCallPart('test-id-2', 'test-function-2', { key: 'value' });
    const toolResult2 = new LanguageModelToolResultPart('test-id-2', [new LanguageModelTextPart('result2')]);

    const msgs = provider['toZMessages']([assistantMsg(toolCall1, toolCall2), userMsg(toolResult1, toolResult2)]);

    const toolMsgs = msgs.filter((m: any) => m.role === 'tool');
    expect(toolMsgs).toHaveLength(2);
  });

  it('should handle messages with image and text content', () => {
    const imageData = new Uint8Array([1, 2, 3]);
    const imgPart = new LanguageModelDataPart(imageData, 'image/png');
    const textPart = new LanguageModelTextPart('Look at this:');
    const msgs = provider['toZMessages']([userMsg(textPart, imgPart)]);

    expect(msgs).toHaveLength(1);
    const content = (msgs[0] as any).content as any[];
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: 'text', text: 'Look at this:' });
    expect(content[1].type).toBe('image_url');
  });

  it('should handle messages with non-image data parts', () => {
    const dataPart = new LanguageModelDataPart(new Uint8Array([0]), 'application/pdf');
    const msgs = provider['toZMessages']([userMsg(dataPart)]);

    expect(msgs).toHaveLength(1);
    expect((msgs[0] as any).content).toBe('[data:application/pdf]');
  });
});

// ── setApiKey ──────────────────────────────────────────────────────────────

describe('setApiKey', () => {
  it('should prompt for API key and store it', async () => {
    const mockApiKey = 'test-api-key';
    vi.spyOn(window, 'showInputBox').mockResolvedValue(mockApiKey);
    vi.spyOn(mockContext.secrets, 'store').mockResolvedValue(undefined);

    const provider = new ZChatModelProvider(mockContext, undefined, false);
    const result = await provider.setApiKey();
    expect(result).toBe(mockApiKey);
    expect(window.showInputBox).toHaveBeenCalled();
    expect(mockContext.secrets.store).toHaveBeenCalledWith('Z_API_KEY', mockApiKey);
  });

  it('should handle cancellation by user', async () => {
    vi.spyOn(window, 'showInputBox').mockResolvedValue(undefined);

    const provider = new ZChatModelProvider(mockContext, undefined, false);
    const result = await provider.setApiKey();
    expect(result).toBeUndefined();
  });

  it('should accept API key even if it is short', async () => {
    const shortApiKey = 'short';
    vi.spyOn(window, 'showInputBox').mockResolvedValue(shortApiKey);
    vi.spyOn(mockContext.secrets, 'store').mockResolvedValue(undefined);

    const provider = new ZChatModelProvider(mockContext, undefined, false);
    const result = await provider.setApiKey();
    expect(result).toBe(shortApiKey);
  });

  it('fires model-information change event after API key update', async () => {
    const mockApiKey = 'test-api-key-1234567890';
    vi.spyOn(window, 'showInputBox').mockResolvedValue(mockApiKey);
    vi.spyOn(mockContext.secrets, 'store').mockResolvedValue(undefined);

    const provider = new ZChatModelProvider(mockContext, undefined, false);
    const listener = vi.fn();
    provider.onDidChangeLanguageModelChatInformation(listener);

    await provider.setApiKey();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

// ── Set API Key Edge Cases ──────────────────────────────────────────────

describe('Set API Key Edge Cases', () => {
  let provider: ZChatModelProvider;

  beforeEach(() => {
    provider = new ZChatModelProvider(mockContext, undefined, false);
  });

  it('should handle API key storage failure', async () => {
    const mockApiKey = 'test-api-key';
    vi.spyOn(window, 'showInputBox').mockResolvedValue(mockApiKey);
    vi.spyOn(mockContext.secrets, 'store').mockRejectedValue(new Error('Storage error'));

    const result = await provider.setApiKey();
    expect(result).toBe(mockApiKey);
  });

  it('should handle empty API key input', async () => {
    vi.spyOn(window, 'showInputBox').mockResolvedValue('');

    const result = await provider.setApiKey();
    expect(result).toBeUndefined();
  });

  it('should handle API key with leading and trailing spaces', async () => {
    const mockApiKey = '  test-api-key  ';
    vi.spyOn(window, 'showInputBox').mockResolvedValue(mockApiKey);
    vi.spyOn(mockContext.secrets, 'store').mockResolvedValue(undefined);

    const result = await provider.setApiKey();
    expect(result).toBe(mockApiKey);
  });

  it('should handle API key with special characters', async () => {
    const mockApiKey = 'test-api-key-!@#$%^&*()';
    vi.spyOn(window, 'showInputBox').mockResolvedValue(mockApiKey);
    vi.spyOn(mockContext.secrets, 'store').mockResolvedValue(undefined);

    const result = await provider.setApiKey();
    expect(result).toBe(mockApiKey);
  });
});

// ── Model Selection Logic ──────────────────────────────────────────────────

describe('Model Selection Logic', () => {
  it('should select the model with the largest context size', () => {
    const models = [
      { id: 'model1', maxInputTokens: 1000 },
      { id: 'model2', maxInputTokens: 2000 },
      { id: 'model3', maxInputTokens: 1500 },
    ];
    const bestModel = models.reduce((best, current) => {
      return (current.maxInputTokens ?? 0) > (best.maxInputTokens ?? 0) ? current : best;
    });
    expect(bestModel.id).toBe('model2');
  });
});

// ── Initialization Logic ──────────────────────────────────────────────────

describe('Initialization Logic', () => {
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

// ── Initialization Edge Cases ────────────────────────────────────────────

describe('Initialization Edge Cases', () => {
  let provider: ZChatModelProvider;

  beforeEach(() => {
    provider = new ZChatModelProvider(mockContext, undefined, false);
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

// ── Model Information Provision ────────────────────────────────────────────

describe('Model Information Provision', () => {
  it('should provide model information', async () => {
    const mockApiKey = 'test-api-key';
    vi.spyOn(mockContext.secrets, 'get').mockResolvedValue(mockApiKey);

    const provider = new ZChatModelProvider(mockContext, undefined, false);
    await provider['initClient'](true);

    const mockCancellationToken = { isCancellationRequested: false, onCancellationRequested: vi.fn() };
    const models = await provider.provideLanguageModelChatInformation({ silent: true }, mockCancellationToken as any);
    expect(models).toBeDefined();
  });

  it('forces image input capability in picker when vision MCP is enabled', async () => {
    const mockApiKey = 'test-api-key';
    vi.spyOn(mockContext.secrets, 'get').mockResolvedValue(mockApiKey);

    const provider = new ZChatModelProvider(mockContext, undefined, false);
    await provider['initClient'](true);

    (provider as any).client = {
      models: {
        list: vi.fn().mockResolvedValue({
          data: [
            {
              id: 'glm-4.7',
              name: 'GLM 4.7',
              capabilities: { completionChat: true, functionCalling: true, vision: false },
            },
          ],
        }),
      },
    };

    const infos = await provider.provideLanguageModelChatInformation(
      { silent: true },
      { isCancellationRequested: false, onCancellationRequested: vi.fn() } as any,
    );

    expect(infos).toHaveLength(1);
    expect(infos[0].capabilities?.imageInput).toBe(true);
  });
});

// ── Model Information Edge Cases ──────────────────────────────────────────

describe('Model Information Edge Cases', () => {
  let provider: ZChatModelProvider;

  beforeEach(() => {
    provider = new ZChatModelProvider(mockContext, undefined, false);
  });

  it('should handle initialization failure silently', async () => {
    vi.spyOn(mockContext.secrets, 'get').mockResolvedValue(undefined);
    vi.spyOn(window, 'showInputBox').mockResolvedValue(undefined);

    const mockCancellationToken = { isCancellationRequested: false, onCancellationRequested: vi.fn() };
    const models = await provider.provideLanguageModelChatInformation({ silent: true }, mockCancellationToken as any);

    expect(models).toEqual([]);
  });

  it('should handle API failure during model fetch', async () => {
    const mockApiKey = 'test-api-key';
    vi.spyOn(mockContext.secrets, 'get').mockResolvedValue(mockApiKey);

    await provider['initClient'](true);

    // Mock the client to throw an error
    (provider as any).client = {
      models: {
        list: vi.fn().mockRejectedValue(new Error('API error')),
      },
    };

    const mockCancellationToken = { isCancellationRequested: false, onCancellationRequested: vi.fn() };
    const models = await provider.provideLanguageModelChatInformation({ silent: true }, mockCancellationToken as any);

    expect(models).toEqual([]);
  });

  it('should handle empty model list from API', async () => {
    const mockApiKey = 'test-api-key';
    vi.spyOn(mockContext.secrets, 'get').mockResolvedValue(mockApiKey);

    await provider['initClient'](true);

    // Mock the client to return an empty list
    (provider as any).client = {
      models: {
        list: vi.fn().mockResolvedValue({ data: [] }),
      },
    };

    const mockCancellationToken = { isCancellationRequested: false, onCancellationRequested: vi.fn() };
    const models = await provider.provideLanguageModelChatInformation({ silent: true }, mockCancellationToken as any);

    expect(models).toEqual([]);
  });
});

// ── Chat Response Provision ───────────────────────────────────────────────

describe('Chat Response Provision', () => {
  it('should throw NoPermissions when API key is missing', async () => {
    const provider = new ZChatModelProvider(mockContext, undefined, false);

    const mockModel = {
      id: 'test-model',
      name: 'Test Model',
      maxInputTokens: 1000,
      maxOutputTokens: 1000,
      defaultCompletionTokens: 1000,
      toolCalling: false,
      supportsParallelToolCalls: false,
      supportsVision: false,
    };

    const mockMessages = [
      {
        role: LanguageModelChatMessageRole.User,
        content: 'Hello',
      },
    ];

    const mockProgress = {
      report: vi.fn(),
    };

    const mockToken = {
      isCancellationRequested: false,
    };

    await expect(
      provider.provideLanguageModelChatResponse(
        mockModel as any,
        mockMessages as any,
        {} as any,
        mockProgress as any,
        mockToken as any,
      ),
    ).rejects.toThrow('API key');
  });
});

// ── Chat Response Edge Cases ───────────────────────────────────────────────

describe('Chat Response Edge Cases', () => {
  let provider: ZChatModelProvider;

  beforeEach(() => {
    provider = new ZChatModelProvider(mockContext, undefined, false);
  });

  it('should handle cancellation during chat response', async () => {
    const mockApiKey = 'test-api-key';
    vi.spyOn(mockContext.secrets, 'get').mockResolvedValue(mockApiKey);

    await provider['initClient'](true);

    const mockModel = {
      id: 'test-model',
      name: 'Test Model',
      maxInputTokens: 1000,
      maxOutputTokens: 1000,
      defaultCompletionTokens: 1000,
      toolCalling: false,
      supportsParallelToolCalls: false,
      supportsVision: false,
    };

    const mockMessages = [
      {
        role: LanguageModelChatMessageRole.User,
        content: 'Hello',
      },
    ];

    const mockProgress = {
      report: vi.fn(),
    };

    const mockToken = {
      isCancellationRequested: true,
    };

    await expect(
      provider.provideLanguageModelChatResponse(
        mockModel as any,
        mockMessages as any,
        {} as any,
        mockProgress as any,
        mockToken as any,
      ),
    ).rejects.toThrow('cancelled');
  });

  it('should handle error during chat response', async () => {
    const mockApiKey = 'test-api-key';
    vi.spyOn(mockContext.secrets, 'get').mockResolvedValue(mockApiKey);

    await provider['initClient'](true);

    const mockModel = {
      id: 'test-model',
      name: 'Test Model',
      maxInputTokens: 1000,
      maxOutputTokens: 1000,
      defaultCompletionTokens: 1000,
      toolCalling: false,
      supportsParallelToolCalls: false,
      supportsVision: false,
    };

    const mockMessages = [
      {
        role: LanguageModelChatMessageRole.User,
        content: 'Hello',
      },
    ];

    const mockProgress = {
      report: vi.fn(),
    };

    const mockToken = {
      isCancellationRequested: false,
    };

    // Mock the client to throw an error
    (provider as any).client = {
      chat: {
        stream: vi.fn().mockRejectedValue(new Error('Network error')),
      },
    };

    await expect(
      provider.provideLanguageModelChatResponse(
        mockModel as any,
        mockMessages as any,
        {} as any,
        mockProgress as any,
        mockToken as any,
      ),
    ).rejects.toThrow('Network error');
  });
});

// ── Model Options Helper ───────────────────────────────────────────────────

describe('Model Options Helper', () => {
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
    const parsed = (provider as any).parseModelOptions(
      {
        temperature: 0.2,
        topP: 0.9,
        safePrompt: true,
        thinkingType: 'disabled',
        clearThinking: false,
        jsonMode: true,
        webSearch: true,
      },
      baseModel,
    );

    expect(parsed.temperature).toBe(0.2);
    expect(parsed.topP).toBe(0.9);
    expect(parsed.safePrompt).toBe(true);
    expect(parsed.thinking).toEqual({ type: 'disabled', clear_thinking: false });
    expect(parsed.responseFormat).toEqual({ type: 'json_object' });
    expect(parsed.webSearchTool).toBeDefined();
    expect(parsed.webSearchTool.type).toBe('web_search');
  });

  it('is used by provideLanguageModelChatResponse and feeds payload fields', async () => {
    const mockApiKey = 'test-api-key';
    vi.spyOn(mockContext.secrets, 'get').mockResolvedValue(mockApiKey);

    await (provider as any).initClient(true);

    const parseSpy = vi.spyOn(provider as any, 'parseModelOptions');
    const streamSpy = vi.fn().mockResolvedValue(
      (async function* () {
        yield {
          data: {
            choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }],
          },
        };
      })(),
    );

    (provider as any).client = {
      models: { list: vi.fn().mockResolvedValue({ data: [baseModel] }) },
      chat: { stream: streamSpy },
    };
    (provider as any).mcpConfig = { vision: true, search: true, reader: true, zread: true };

    await provider.provideLanguageModelChatResponse(
      baseModel as any,
      [{ role: LanguageModelChatMessageRole.User, content: [new LanguageModelTextPart('hi')], name: undefined }] as any,
      {
        modelOptions: {
          thinkingType: 'disabled',
          clearThinking: false,
          jsonMode: true,
          webSearch: true,
        },
      } as any,
      { report: vi.fn() } as any,
      { isCancellationRequested: false, onCancellationRequested: vi.fn() } as any,
    );

    expect(parseSpy).toHaveBeenCalled();
    const payload = streamSpy.mock.calls[0][0];
    expect(payload.thinking).toEqual({ type: 'disabled', clear_thinking: false });
    expect(payload.responseFormat).toEqual({ type: 'json_object' });
    expect(payload.toolStream).toBe(true);
    expect(Array.isArray(payload.tools)).toBe(true);
    expect(payload.tools.some((t: any) => t.type === 'web_search')).toBe(true);
  });

  it('adds MCP-first image routing guidance when image is attached', async () => {
    const mockApiKey = 'test-api-key';
    vi.spyOn(mockContext.secrets, 'get').mockResolvedValue(mockApiKey);

    await (provider as any).initClient(true);

    const streamSpy = vi.fn().mockResolvedValue(
      (async function* () {
        yield {
          data: {
            choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }],
          },
        };
      })(),
    );

    (provider as any).client = {
      models: { list: vi.fn().mockResolvedValue({ data: [baseModel] }) },
      chat: { stream: streamSpy },
    };

    await provider.provideLanguageModelChatResponse(
      baseModel as any,
      [
        {
          role: LanguageModelChatMessageRole.User,
          content: [new LanguageModelTextPart('What is in this image?'), new LanguageModelDataPart(new Uint8Array([1, 2, 3]), 'image/png')],
          name: undefined,
        },
      ] as any,
      {
        tools: [
          {
            name: 'mcp_zvision_analyze_image',
            description: 'Analyze image',
            inputSchema: {
              type: 'object',
              properties: {
                image_source: { type: 'string' },
                prompt: { type: 'string' },
              },
            },
          },
        ],
      } as any,
      { report: vi.fn() } as any,
      { isCancellationRequested: false, onCancellationRequested: vi.fn() } as any,
    );

    const payload = streamSpy.mock.calls[0][0];
    const serializedMessages = JSON.stringify(payload.messages);
    expect(serializedMessages).toContain('mcp_zvision_analyze_image');
    expect(serializedMessages).toContain('An image is attached');
  });

  it('omits thinking when not explicitly configured', () => {
    const parsed = (provider as any).parseModelOptions({}, baseModel);
    expect(parsed.thinking).toBeUndefined();
  });
});

describe('ZChatModelProvider — coding endpoint model discovery', () => {
  let provider: ZChatModelProvider;

  beforeEach(() => {
    provider = new ZChatModelProvider(mockContext);
  });

  it('uses the client model list as-is without cross-endpoint fan-out', async () => {
    const mockList = vi.fn().mockResolvedValue({
      data: [
        { id: 'glm-5.1', capabilities: { completionChat: true, functionCalling: true, vision: false } },
        { id: 'glm-4.7', capabilities: { completionChat: true, functionCalling: true, vision: false } },
      ],
    });

    (provider as any).client = { models: { list: mockList } };

    const models = await provider.fetchModels();

    expect(mockList).toHaveBeenCalledTimes(1);
    expect(models.map(m => m.id)).toEqual(expect.arrayContaining(['glm-5.1', 'glm-4.7']));
  });
});

// ── Tool Call Handling ────────────────────────────────────────────────────

describe('Tool Call Handling', () => {
  it('should generate a tool call ID', () => {
    const provider = new ZChatModelProvider(mockContext, undefined, false);
    const toolCallId = provider['generateToolCallId']();
    expect(toolCallId).toBeDefined();
    expect(toolCallId).toHaveLength(9);
    expect(toolCallId).toMatch(/^[a-zA-Z0-9]+$/);
  });

  it('should get Z tool call ID', () => {
    const provider = new ZChatModelProvider(mockContext, undefined, false);
    const vsCodeId = 'test-call-id';
    const zId = 'test-z-id';
    provider['toolCallIdMapping'].set(vsCodeId, zId);

    const result = provider['getZToolCallId'](vsCodeId);
    expect(result).toBe(zId);
  });

  it('should return undefined for unknown tool call ID', () => {
    const provider = new ZChatModelProvider(mockContext, undefined, false);
    const vsCodeId = 'unknown-call-id';

    const result = provider['getZToolCallId'](vsCodeId);
    expect(result).toBeUndefined();
  });
});

// ── Edge Cases ────────────────────────────────────────────────────────────

describe('Edge Cases', () => {
  it('should handle empty messages in toZMessages', () => {
    const provider = new ZChatModelProvider(mockContext, undefined, false);
    const messages: any[] = [];
    const zMessages = provider['toZMessages'](messages);
    expect(zMessages).toBeDefined();
    expect(zMessages.length).toBe(0);
  });

  it('should handle messages with no content', () => {
    const provider = new ZChatModelProvider(mockContext, undefined, false);
    const messages = [
      {
        role: LanguageModelChatMessageRole.User,
        content: [],
      },
    ];
    const zMessages = provider['toZMessages'](messages as any);
    expect(zMessages).toBeDefined();
    expect(zMessages.length).toBe(0);
  });
});

// ── Token Count Provision ──────────────────────────────────────────────────

describe('Token Count Provision', () => {
  let provider: ZChatModelProvider;

  beforeEach(() => {
    provider = new ZChatModelProvider(mockContext, undefined, false);
  });

  it('should count tokens for plain text', async () => {
    const text = 'Hello, world! This is a test.';
    const tokenCount = await provider.provideTokenCount({} as any, text, {} as any);
    expect(tokenCount).toBeGreaterThan(0);
  });

  it('should count tokens for a message with text parts', async () => {
    const message = {
      role: LanguageModelChatMessageRole.User,
      content: [new LanguageModelTextPart('Hello, world!')],
      name: undefined,
    };
    const tokenCount = await provider.provideTokenCount({} as any, message, {} as any);
    expect(tokenCount).toBeGreaterThan(0);
  });

  it('should count tokens for a message with string content', async () => {
    const message = {
      role: LanguageModelChatMessageRole.User,
      content: 'Hello, world!',
      name: undefined,
    };
    const tokenCount = await provider.provideTokenCount({} as any, message as any, {} as any);
    expect(tokenCount).toBeGreaterThan(0);
  });

  it('should count tokens for a message with tool calls', async () => {
    const message = {
      role: LanguageModelChatMessageRole.Assistant,
      content: [new LanguageModelToolCallPart('test-id', 'test-function', { key: 'value' })],
      name: undefined,
    };
    const tokenCount = await provider.provideTokenCount({} as any, message, {} as any);
    expect(tokenCount).toBeGreaterThan(0);
  });

  it('should count tokens for a message with tool results', async () => {
    const message = {
      role: LanguageModelChatMessageRole.User,
      content: [new LanguageModelToolResultPart('test-id', [new LanguageModelTextPart('result')])],
      name: undefined,
    };
    const tokenCount = await provider.provideTokenCount({} as any, message, {} as any);
    expect(tokenCount).toBeGreaterThan(0);
  });

  it('should return 0 for empty text', async () => {
    const text = '';
    const tokenCount = await provider.provideTokenCount({} as any, text, {} as any);
    expect(tokenCount).toBe(0);
  });

  it('should return 0 for a message with no content', async () => {
    const message = {
      role: LanguageModelChatMessageRole.User,
      content: [],
      name: undefined,
    };
    const tokenCount = await provider.provideTokenCount({} as any, message, {} as any);
    expect(tokenCount).toBe(0);
  });

  it('ignores unknown message parts in token counting', async () => {
    const message = {
      role: LanguageModelChatMessageRole.User,
      content: [{ unexpected: true }],
      name: undefined,
    };
    const tokenCount = await provider.provideTokenCount({} as any, message as any, {} as any);
    expect(tokenCount).toBe(0);
  });
});

// ── Clear Tool Call ID Mappings Edge Cases ────────────────────────────────

describe('Clear Tool Call ID Mappings Edge Cases', () => {
  let provider: ZChatModelProvider;

  beforeEach(() => {
    provider = new ZChatModelProvider(mockContext, undefined, false);
  });

  it('should clear all tool call ID mappings', () => {
    const _vsCodeId1 = provider.getOrCreateVsCodeToolCallId('z-id-1');
    const vsCodeId2 = provider.getOrCreateVsCodeToolCallId('z-id-2');

    provider.clearToolCallIdMappings();

    expect(provider.getZToolCallId(_vsCodeId1)).toBeUndefined();
    expect(provider.getZToolCallId(vsCodeId2)).toBeUndefined();
  });

  it('should allow new mappings after clearing', () => {
    const _vsCodeId1 = provider.getOrCreateVsCodeToolCallId('z-id-1');
    provider.clearToolCallIdMappings();

    const vsCodeId2 = provider.getOrCreateVsCodeToolCallId('z-id-1');
    expect(vsCodeId2).toMatch(/^[a-zA-Z0-9]{9}$/);
    expect(provider.getZToolCallId(vsCodeId2)).toBe('z-id-1');
  });

  it('should handle clearing when no mappings exist', () => {
    provider.clearToolCallIdMappings();

    const vsCodeId = provider.getOrCreateVsCodeToolCallId('z-id-1');
    expect(vsCodeId).toMatch(/^[a-zA-Z0-9]{9}$/);
    expect(provider.getZToolCallId(vsCodeId)).toBe('z-id-1');
  });
});

describe('Provider dispose', () => {
  it('cleans up tokenizer and model cache safely', async () => {
    const provider = new ZChatModelProvider(mockContext, undefined, false);
    await provider.provideTokenCount({} as any, 'hello world', {} as any);
    (provider as any).fetchedModels = [
      {
        id: 'glm-5',
        name: 'GLM 5',
        maxInputTokens: 1,
        maxOutputTokens: 1,
        defaultCompletionTokens: 1,
        toolCalling: false,
        supportsParallelToolCalls: false,
      },
    ];

    provider.dispose();

    expect((provider as any).tokenizer).toBeNull();
    expect((provider as any).fetchedModels).toBeNull();
    expect((provider as any).client).toBeNull();
  });
});

// ── Generate Tool Call ID Edge Cases ──────────────────────────────────────

describe('Generate Tool Call ID Edge Cases', () => {
  let provider: ZChatModelProvider;

  beforeEach(() => {
    provider = new ZChatModelProvider(mockContext, undefined, false);
  });

  it('should generate unique tool call IDs', () => {
    const ids = new Set();
    for (let i = 0; i < 100; i++) {
      const id = provider.generateToolCallId();
      expect(id).toMatch(/^[a-zA-Z0-9]{9}$/);
      ids.add(id);
    }
    expect(ids.size).toBe(100);
  });

  it('should generate tool call IDs with only alphanumeric characters', () => {
    for (let i = 0; i < 100; i++) {
      const id = provider.generateToolCallId();
      expect(id).toMatch(/^[a-zA-Z0-9]{9}$/);
    }
  });

  it('should generate tool call IDs of exactly 9 characters', () => {
    for (let i = 0; i < 100; i++) {
      const id = provider.generateToolCallId();
      expect(id).toHaveLength(9);
    }
  });
});

// ── Get or Create VS Code Tool Call ID Edge Cases ────────────────────────

describe('Get or Create VS Code Tool Call ID Edge Cases', () => {
  let provider: ZChatModelProvider;

  beforeEach(() => {
    provider = new ZChatModelProvider(mockContext, undefined, false);
  });

  it('should return the same VS Code ID for the same Z ID', () => {
    const zId = 'z-id-1';
    const vsCodeId1 = provider.getOrCreateVsCodeToolCallId(zId);
    const vsCodeId2 = provider.getOrCreateVsCodeToolCallId(zId);

    expect(vsCodeId1).toBe(vsCodeId2);
  });

  it('should return different VS Code IDs for different Z IDs', () => {
    const _vsCodeId1 = provider.getOrCreateVsCodeToolCallId('z-id-1');
    const vsCodeId2 = provider.getOrCreateVsCodeToolCallId('z-id-2');

    expect(_vsCodeId1).not.toBe(vsCodeId2);
  });

  it('should register bidirectional mapping', () => {
    const zId = 'z-id-1';
    const vsCodeId = provider.getOrCreateVsCodeToolCallId(zId);

    expect(provider.getZToolCallId(vsCodeId)).toBe(zId);
  });

  it('should handle empty Z ID', () => {
    const vsCodeId = provider.getOrCreateVsCodeToolCallId('');
    expect(vsCodeId).toMatch(/^[a-zA-Z0-9]{9}$/);
  });

  it('should handle Z ID with special characters', () => {
    const zId = 'z-id-!@#$%^&*()';
    const vsCodeId = provider.getOrCreateVsCodeToolCallId(zId);
    expect(vsCodeId).toMatch(/^[a-zA-Z0-9]{9}$/);
  });
});

// ── Get Z Tool Call ID Edge Cases ──────────────────────────────────

describe('Get Z Tool Call ID Edge Cases', () => {
  let provider: ZChatModelProvider;

  beforeEach(() => {
    provider = new ZChatModelProvider(mockContext, undefined, false);
  });

  it('should return the Z ID for a known VS Code ID', () => {
    const zId = 'z-id-1';
    const vsCodeId = provider.getOrCreateVsCodeToolCallId(zId);

    const result = provider.getZToolCallId(vsCodeId);
    expect(result).toBe(zId);
  });

  it('should return undefined for an unknown VS Code ID', () => {
    const result = provider.getZToolCallId('unknown-id');
    expect(result).toBeUndefined();
  });

  it('should handle empty VS Code ID', () => {
    const result = provider.getZToolCallId('');
    expect(result).toBeUndefined();
  });

  it('should handle VS Code ID with special characters', () => {
    const result = provider.getZToolCallId('vs-code-id-!@#$%^&*()');
    expect(result).toBeUndefined();
  });
});

// ── LLMStreamProcessor — thinking extraction ──────────────────────────────────

describe('provideLanguageModelChatResponse — thinking extraction', () => {
  let provider: ZChatModelProvider;

  const mockModel = {
    id: 'z-medium-latest',
    name: 'Z Medium',
    maxInputTokens: 128000,
    maxOutputTokens: 16384,
    defaultCompletionTokens: 16384,
    toolCalling: false,
    supportsParallelToolCalls: false,
    supportsVision: false,
  };

  const mockToken = { isCancellationRequested: false };

  function makeStream(...chunks: Array<{ content?: string; finishReason?: string }>) {
    return (async function* () {
      for (const c of chunks) {
        yield {
          data: {
            choices: [
              {
                delta: { content: c.content ?? '', toolCalls: undefined },
                finishReason: c.finishReason ?? null,
              },
            ],
          },
        };
      }
    })();
  }

  beforeEach(() => {
    provider = new ZChatModelProvider(mockContext, undefined, false);
    (provider as any).client = {
      models: { list: vi.fn().mockResolvedValue({ data: [] }) },
      chat: { stream: vi.fn() },
    };
  });

  it('strips <think> blocks — only clean content reaches progress.report', async () => {
    const rawChunks = [
      { content: '<think>Let me reason through this.</think>Hello' },
      { content: ' world', finishReason: 'stop' },
    ];
    (provider as any).client.chat.stream.mockResolvedValue(makeStream(...rawChunks));

    const reported: string[] = [];
    const mockProgress = { report: vi.fn(part => reported.push((part as any).value)) };

    await provider.provideLanguageModelChatResponse(
      mockModel as any,
      [{ role: LanguageModelChatMessageRole.User, content: [new LanguageModelTextPart('hi')], name: undefined }],
      {} as any,
      mockProgress as any,
      mockToken as any,
    );

    const combined = reported.join('');
    expect(combined).not.toContain('<think>');
    expect(combined).not.toContain('</think>');
    expect(combined).not.toContain('Let me reason through this.');
    expect(combined).toBe('Hello world');
  });

  it('passes regular content through unchanged when no think tags present', async () => {
    const rawChunks = [{ content: 'Here is' }, { content: ' the answer', finishReason: 'stop' }];
    (provider as any).client.chat.stream.mockResolvedValue(makeStream(...rawChunks));

    const reported: string[] = [];
    const mockProgress = { report: vi.fn(part => reported.push((part as any).value)) };

    await provider.provideLanguageModelChatResponse(
      mockModel as any,
      [{ role: LanguageModelChatMessageRole.User, content: [new LanguageModelTextPart('hi')], name: undefined }],
      {} as any,
      mockProgress as any,
      mockToken as any,
    );

    expect(reported.join('')).toBe('Here is the answer');
  });

  it('handles response that is entirely a think block with no output content', async () => {
    const rawChunks = [{ content: '<think>internal reasoning only</think>', finishReason: 'stop' }];
    (provider as any).client.chat.stream.mockResolvedValue(makeStream(...rawChunks));

    const textReports: string[] = [];
    const mockProgress = {
      report: vi.fn(part => {
        if ((part as any).value !== undefined) textReports.push((part as any).value);
      }),
    };

    await provider.provideLanguageModelChatResponse(
      mockModel as any,
      [{ role: LanguageModelChatMessageRole.User, content: [new LanguageModelTextPart('hi')], name: undefined }],
      {} as any,
      mockProgress as any,
      mockToken as any,
    );

    const combined = textReports.join('');
    expect(combined).not.toContain('<think>');
    expect(combined).not.toContain('internal reasoning only');
  });

  it('handles multi-chunk think block split across stream events', async () => {
    const rawChunks = [
      { content: '<think>step one' },
      { content: ' step two</think>Result' },
      { content: ' here', finishReason: 'stop' },
    ];
    (provider as any).client.chat.stream.mockResolvedValue(makeStream(...rawChunks));

    const reported: string[] = [];
    const mockProgress = { report: vi.fn(part => reported.push((part as any).value)) };

    await provider.provideLanguageModelChatResponse(
      mockModel as any,
      [{ role: LanguageModelChatMessageRole.User, content: [new LanguageModelTextPart('hi')], name: undefined }],
      {} as any,
      mockProgress as any,
      mockToken as any,
    );

    const combined = reported.join('');
    expect(combined).not.toContain('<think>');
    expect(combined).not.toContain('step one');
    expect(combined).not.toContain('step two');
    expect(combined).toContain('Result');
    expect(combined).toContain('here');
  });
});

// ── EventEmitter (vscode mock) ────────────────────────────────────────────────

describe('EventEmitter', () => {
  it('fires events to subscribed listeners', async () => {
    const { EventEmitter } = await import('./test/vscode.mock.js');
    const emitter = new EventEmitter<string>();
    const received: string[] = [];
    emitter.event(v => received.push(v));
    emitter.fire('hello');
    expect(received).toEqual(['hello']);
  });

  it('removes a listener when its subscription is disposed', async () => {
    const { EventEmitter } = await import('./test/vscode.mock.js');
    const emitter = new EventEmitter<number>();
    const received: number[] = [];
    const sub = emitter.event(v => received.push(v));
    emitter.fire(1);
    sub.dispose();
    emitter.fire(2);
    expect(received).toEqual([1]);
  });

  it('swallows errors thrown by listeners so other listeners still run', async () => {
    const { EventEmitter } = await import('./test/vscode.mock.js');
    const emitter = new EventEmitter<void>();
    const spy = vi.fn();
    emitter.event(() => {
      throw new Error('boom');
    });
    emitter.event(spy);
    expect(() => emitter.fire()).not.toThrow();
    expect(spy).toHaveBeenCalled();
  });

  it('clears all listeners on dispose', async () => {
    const { EventEmitter } = await import('./test/vscode.mock.js');
    const emitter = new EventEmitter<void>();
    const spy = vi.fn();
    emitter.event(spy);
    emitter.dispose();
    emitter.fire();
    expect(spy).not.toHaveBeenCalled();
  });
});
