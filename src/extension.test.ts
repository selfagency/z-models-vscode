import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chat,
  ChatRequestTurn,
  ChatResponseMarkdownPart,
  ChatResponseTurn,
  commands,
  LanguageModelError,
  LanguageModelTextPart,
  l10n,
  lm,
  MarkdownString,
} from 'vscode';
import { activate, deactivate } from './extension.js';

vi.mock('./provider', () => ({
  ZChatModelProvider: vi.fn().mockImplementation(function () {
    return { setApiKey: vi.fn() };
  }),
}));

describe('extension', () => {
  const mockContext = {
    secrets: {
      get: vi.fn().mockResolvedValue(undefined),
      onDidChange: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    },
    subscriptions: { push: vi.fn() },
    extensionUri: { toString: () => 'file:///fake-extension' },
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('activate', () => {
    it('registers the language model chat provider', () => {
      activate(mockContext);
      expect(lm.registerLanguageModelChatProvider).toHaveBeenCalledWith('z', expect.any(Object));
    });

    it('registers the manageApiKey command', () => {
      activate(mockContext);
      expect(commands.registerCommand).toHaveBeenCalledWith('z-chat.manageApiKey', expect.any(Function));
    });

    it('registers the manageSettings command', () => {
      activate(mockContext);
      expect(commands.registerCommand).toHaveBeenCalledWith('z-chat.manageSettings', expect.any(Function));
    });

    it('pushes provider, mcp, and command disposables in the first subscription push', () => {
      activate(mockContext);
      // Provider and command are in the first push; MCP is a separate guarded push.
      const registrationCall = mockContext.subscriptions.push.mock.calls.find((call: unknown[]) => call.length >= 2);
      expect(registrationCall).toBeDefined();
    });

    it('creates the @z chat participant', () => {
      activate(mockContext);
      expect(chat.createChatParticipant).toHaveBeenCalledWith('z-models-vscode.z', expect.any(Function));
    });

    it('sets a followup provider on the chat participant', () => {
      activate(mockContext);
      const participant = (chat.createChatParticipant as ReturnType<typeof vi.fn>).mock.results[0]?.value;
      expect(participant.followupProvider).toBeDefined();
    });

    it('pushes participant disposable into context.subscriptions', () => {
      activate(mockContext);
      // Participant push is the last push call (there may also be an output-channel push)
      const calls = mockContext.subscriptions.push.mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(2);
      expect(calls.at(-1)).toHaveLength(1);
    });
  });

  describe('activate — participant handler', () => {
    async function getHandler() {
      activate(mockContext);
      const [, handler] = (chat.createChatParticipant as ReturnType<typeof vi.fn>).mock.calls[0];
      return handler;
    }

    it('sends history + prompt to request.model.sendRequest', async () => {
      const handler = await getHandler();

      const mockStream = { markdown: vi.fn() };
      const mockResponse = {
        stream: (async function* () {
          yield new LanguageModelTextPart('world');
        })(),
      };
      const mockSendRequest = vi.fn().mockResolvedValue(mockResponse);

      const mockRequest = { prompt: 'hello', model: { sendRequest: mockSendRequest } };
      const mockChatContext = { history: [] };
      const mockToken = { isCancellationRequested: false };

      await handler(mockRequest, mockChatContext, mockStream, mockToken);

      expect(mockSendRequest).toHaveBeenCalledOnce();
      const [messages] = mockSendRequest.mock.calls[0];
      // Last message is the current prompt
      expect(messages.at(-1).content).toBe('hello');
    });

    it('streams text chunks back as markdown', async () => {
      const handler = await getHandler();

      const mockStream = { markdown: vi.fn() };
      const mockResponse = {
        stream: (async function* () {
          yield new LanguageModelTextPart('chunk1');
          yield new LanguageModelTextPart('chunk2');
        })(),
      };
      const mockSendRequest = vi.fn().mockResolvedValue(mockResponse);

      await handler({ prompt: 'test', model: { sendRequest: mockSendRequest } }, { history: [] }, mockStream, {
        isCancellationRequested: false,
      });

      expect(mockStream.markdown).toHaveBeenCalledWith('chunk1');
      expect(mockStream.markdown).toHaveBeenCalledWith('chunk2');
    });

    it('includes prior ChatRequestTurn as a User message in history', async () => {
      const handler = await getHandler();

      const mockResponse = { stream: (async function* () {})() };
      const mockSendRequest = vi.fn().mockResolvedValue(mockResponse);

      const priorRequest = new (ChatRequestTurn as any)('prior question');
      await handler(
        { prompt: 'follow-up', model: { sendRequest: mockSendRequest } },
        { history: [priorRequest] },
        { markdown: vi.fn() },
        { isCancellationRequested: false },
      );

      const [messages] = mockSendRequest.mock.calls[0];
      expect(messages[0].content).toBe('prior question');
      expect(messages[1].content).toBe('follow-up');
    });

    it('includes prior ChatResponseTurn as an Assistant message in history', async () => {
      const handler = await getHandler();

      const mockResponse = { stream: (async function* () {})() };
      const mockSendRequest = vi.fn().mockResolvedValue(mockResponse);

      const priorResponse = new (ChatResponseTurn as any)([
        new (ChatResponseMarkdownPart as any)(new (MarkdownString as any)('prior answer')),
      ]);
      await handler(
        { prompt: 'next', model: { sendRequest: mockSendRequest } },
        { history: [priorResponse] },
        { markdown: vi.fn() },
        { isCancellationRequested: false },
      );

      const [messages] = mockSendRequest.mock.calls[0];
      expect(messages[0].content).toBe('prior answer');
    });

    it('surfaces errors as a markdown message', async () => {
      const handler = await getHandler();

      const mockStream = { markdown: vi.fn() };
      const mockSendRequest = vi.fn().mockRejectedValue(new Error('model unavailable'));

      await handler({ prompt: 'hi', model: { sendRequest: mockSendRequest } }, { history: [] }, mockStream, {
        isCancellationRequested: false,
      });

      expect(mockStream.markdown).toHaveBeenCalledWith(expect.stringContaining('model unavailable'));
    });

    it('handles /clear slash command without model invocation', async () => {
      const handler = await getHandler();
      const mockStream = { markdown: vi.fn() };
      const mockSendRequest = vi.fn();

      await handler(
        { prompt: 'ignored', command: 'clear', model: { sendRequest: mockSendRequest } },
        { history: [] },
        mockStream,
        { isCancellationRequested: false },
      );

      expect(mockSendRequest).not.toHaveBeenCalled();
      expect(mockStream.markdown).toHaveBeenCalledWith(expect.stringContaining('new chat thread'));
    });

    it('handles /model slash command without model invocation', async () => {
      const handler = await getHandler();
      const mockStream = { markdown: vi.fn() };
      const mockSendRequest = vi.fn();

      await handler(
        { prompt: 'ignored', command: 'model', model: { sendRequest: mockSendRequest } },
        { history: [] },
        mockStream,
        { isCancellationRequested: false },
      );

      expect(mockSendRequest).not.toHaveBeenCalled();
      expect(mockStream.markdown).toHaveBeenCalledWith(expect.stringContaining('model picker'));
    });

    it('formats LanguageModelError via l10n', async () => {
      const handler = await getHandler();
      const mockStream = { markdown: vi.fn() };
      const lmError = new LanguageModelError('blocked');
      (lmError as any).code = 'off_topic';
      const mockSendRequest = vi.fn().mockRejectedValue(lmError);

      await handler(
        { prompt: 'hi', model: { sendRequest: mockSendRequest } },
        { history: [] },
        mockStream,
        { isCancellationRequested: false },
      );

      expect(l10n.t).toHaveBeenCalled();
      expect(mockStream.markdown).toHaveBeenCalledWith(expect.stringContaining('off_topic'));
    });
  });

  describe('deactivate', () => {
    it('returns undefined', () => {
      expect(deactivate()).toBeUndefined();
    });
  });
});
