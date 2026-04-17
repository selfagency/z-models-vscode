import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chat,
  ChatRequestTurn,
  ChatResponseMarkdownPart,
  ChatResponseTurn,
  commands,
  LanguageModelTextPart,
  lm,
  MarkdownString,
  window,
  workspace,
} from 'vscode';
import { activate, deactivate } from './extension.js';
import {
  l10n,
  LanguageModelError,
  LanguageModelToolCallPart,
  LanguageModelToolResultPart,
} from './test/vscode.mock.js';

vi.mock('./provider', () => ({
  ZChatModelProvider: vi.fn().mockImplementation(function () {
    return { setApiKey: vi.fn(), dispose: vi.fn() };
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

    it('handles missing secret change event API gracefully', () => {
      const ctx = {
        ...mockContext,
        secrets: {
          get: vi.fn().mockResolvedValue(undefined),
        },
      } as any;

      expect(() => activate(ctx)).not.toThrow();
    });

    it('logs warning when LM provider API is unavailable', () => {
      const old = (lm as any).registerLanguageModelChatProvider;
      (lm as any).registerLanguageModelChatProvider = undefined;

      activate(mockContext);

      const log = (window.createOutputChannel as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value;
      expect(log.warn).toHaveBeenCalled();
      (lm as any).registerLanguageModelChatProvider = old;
    });

    it('logs warning when MCP provider API is unavailable', () => {
      const old = (lm as any).registerMcpServerDefinitionProvider;
      (lm as any).registerMcpServerDefinitionProvider = undefined;

      activate(mockContext);

      const log = (window.createOutputChannel as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value;
      expect(log.warn).toHaveBeenCalled();
      (lm as any).registerMcpServerDefinitionProvider = old;
    });

    it('executes manageSettings command and shows coding endpoint info', async () => {
      activate(mockContext);
      const call = (commands.registerCommand as ReturnType<typeof vi.fn>).mock.calls.find(
        ([name]) => name === 'z-chat.manageSettings',
      );
      const handler = call?.[1] as () => Promise<void>;

      await handler();

      expect(window.showInformationMessage).toHaveBeenCalledWith(
        'Z.ai for Copilot uses the dedicated coding endpoint: https://api.z.ai/api/coding/paas/v4',
      );
    });

    it('executes manageSettings command without mutating endpoint configuration', async () => {
      activate(mockContext);
      const call = (commands.registerCommand as ReturnType<typeof vi.fn>).mock.calls.find(
        ([name]) => name === 'z-chat.manageSettings',
      );
      const handler = call?.[1] as () => Promise<void>;
      const config = {
        get: vi.fn().mockReturnValue('zaiCoding'),
        update: vi.fn().mockResolvedValue(undefined),
      };
      vi.spyOn(workspace, 'getConfiguration').mockReturnValue(config as any);

      await handler();

      expect(config.update).not.toHaveBeenCalled();
    });

    it('logs command registration errors', () => {
      (commands.registerCommand as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
        throw new Error('register failed');
      });

      activate(mockContext);

      const log = (window.createOutputChannel as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value;
      expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Failed to register manageApiKey command'));
    });

    it('executes manageApiKey command and refreshes context', async () => {
      activate(mockContext);
      const call = (commands.registerCommand as ReturnType<typeof vi.fn>).mock.calls.find(
        ([name]) => name === 'z-chat.manageApiKey',
      );
      const handler = call?.[1] as () => Promise<void>;

      await handler();

      expect(commands.executeCommand).toHaveBeenCalledWith('setContext', 'zModels.hasApiKey', false);
    });

    it('reacts to secret-change events for Z_API_KEY', async () => {
      activate(mockContext);
      const listener = (mockContext.secrets.onDidChange as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      expect(typeof listener).toBe('function');

      listener({ key: 'Z_API_KEY' });
      await Promise.resolve();

      expect(commands.executeCommand).toHaveBeenCalledWith('setContext', 'zModels.hasApiKey', false);
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

    it('handles /vision slash command without model invocation', async () => {
      const handler = await getHandler();
      const mockStream = { markdown: vi.fn() };
      const mockSendRequest = vi.fn();

      await handler(
        { prompt: 'ignored', command: 'vision', model: { sendRequest: mockSendRequest } },
        { history: [] },
        mockStream,
        { isCancellationRequested: false },
      );

      expect(mockSendRequest).not.toHaveBeenCalled();
      expect(mockStream.markdown).toHaveBeenCalledWith(expect.stringContaining('Vision MCP server'));
    });

    it('renders streamed tool calls and tool results as markdown', async () => {
      const handler = await getHandler();

      const mockStream = { markdown: vi.fn() };
      const mockResponse = {
        stream: (async function* () {
          yield new LanguageModelToolCallPart('id1', 'search', { query: 'abc' });
          yield new LanguageModelToolResultPart('id1', [new LanguageModelTextPart('result text')]);
        })(),
      };
      const mockSendRequest = vi.fn().mockResolvedValue(mockResponse);

      await handler({ prompt: 'test', model: { sendRequest: mockSendRequest } }, { history: [] }, mockStream, {
        isCancellationRequested: false,
      });

      expect(mockStream.markdown).toHaveBeenCalledWith(expect.stringContaining('Calling tool `search`'));
      expect(mockStream.markdown).toHaveBeenCalledWith('result text');
    });

    it('formats LanguageModelError via l10n', async () => {
      const handler = await getHandler();
      const mockStream = { markdown: vi.fn() };
      const lmError = new LanguageModelError('blocked');
      (lmError as any).code = 'off_topic';
      const mockSendRequest = vi.fn().mockRejectedValue(lmError);

      await handler({ prompt: 'hi', model: { sendRequest: mockSendRequest } }, { history: [] }, mockStream, {
        isCancellationRequested: false,
      });

      expect(l10n.t).toHaveBeenCalled();
      // New behavior: shows the message from LanguageModelError instead of the code
      expect(mockStream.markdown).toHaveBeenCalledWith(expect.stringContaining('blocked'));
    });

    it('formats unknown thrown values with fallback message', async () => {
      const handler = await getHandler();
      const mockStream = { markdown: vi.fn() };
      const mockSendRequest = vi.fn().mockRejectedValue('plain-string-error');

      await handler({ prompt: 'hi', model: { sendRequest: mockSendRequest } }, { history: [] }, mockStream, {
        isCancellationRequested: false,
      });

      expect(mockStream.markdown).toHaveBeenCalledWith(expect.stringContaining('Unknown error'));
    });
  });

  describe('deactivate', () => {
    it('returns undefined', () => {
      expect(deactivate()).toBeUndefined();
    });
  });
});
