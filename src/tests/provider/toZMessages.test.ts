// biome-ignore lint/suspicious/noExplicitAny: Necessary for testing private methods.

// biome-ignore lint/suspicious/noExplicitAny: Necessary for testing private methods.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LanguageModelChatMessageRole,
  LanguageModelDataPart,
  LanguageModelTextPart,
  LanguageModelToolCallPart,
  LanguageModelToolResultPart,
} from 'vscode';
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

  it('handles unknown data parts as text placeholder', () => {
    // Data parts that don't match known MIME types should be stringified as text
    const dataPart = new LanguageModelDataPart(new Uint8Array([0]), 'application/unknown-type');
    const msgs = provider.toZMessages([userMsg(dataPart)]);

    expect(msgs).toHaveLength(1);
    expect((msgs[0] as { content: unknown }).content).toBe('[data:application/unknown-type]');
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

  it('includes reasoning_content in assistant message when accumulated from streaming', () => {
    // Set accumulatedReasoningContent to simulate streaming response
    (provider as any).setAccumulatedReasoningContent = (content: string) => {
      (provider as any).accumulatedReasoningContent = content;
    };
    (provider as any).setAccumulatedReasoningContent('Model is thinking about the problem...');

    const msgs = provider.toZMessages([assistantMsg(new LanguageModelTextPart('Here is my answer'))]);

    expect(msgs).toHaveLength(1);
    const msg = msgs[0] as { role: string; content: string; reasoning_content?: string };
    expect(msg.role).toBe('assistant');
    expect(msg.content).toBe('Here is my answer');
    expect(msg.reasoning_content).toBe('Model is thinking about the problem...');
  });

  it('omits reasoning_content when not accumulated', () => {
    // Ensure accumulatedReasoningContent is empty
    (provider as any).setAccumulatedReasoningContent = (content: string) => {
      (provider as any).accumulatedReasoningContent = content;
    };
    (provider as any).setAccumulatedReasoningContent('');

    const msgs = provider.toZMessages([assistantMsg(new LanguageModelTextPart('Answer'))]);

    expect(msgs).toHaveLength(1);
    const msg = msgs[0] as any;
    expect(msg.reasoning_content).toBeUndefined();
  });
});
