import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { commands, window } from 'vscode';
import {
  ApiKeyManager,
  calculateRetryDelay,
  cancellationTokenToAbortSignal,
  createMcpServerDefinitionProvider,
  createProviderError,
  createVSCodeAgentLoop,
  errorToProviderCode,
  httpStatusToErrorCode,
  isRetryableError,
  McpServerRegistry,
  ProviderErrorCode,
  UsageStatusBar,
  withRetry,
} from './agentsy-native.js';

describe('error mapping', () => {
  it('maps HTTP status codes to provider error codes', () => {
    expect(httpStatusToErrorCode(401)).toBe(ProviderErrorCode.InvalidApiKey);
    expect(httpStatusToErrorCode(403)).toBe(ProviderErrorCode.InvalidApiKey);
    expect(httpStatusToErrorCode(429)).toBe(ProviderErrorCode.RateLimited);
    expect(httpStatusToErrorCode(404)).toBe(ProviderErrorCode.ModelNotFound);
    expect(httpStatusToErrorCode(408)).toBe(ProviderErrorCode.Timeout);
    expect(httpStatusToErrorCode(504)).toBe(ProviderErrorCode.Timeout);
    expect(httpStatusToErrorCode(418)).toBe(ProviderErrorCode.InternalError);
  });

  it('maps error objects to provider codes by status and message', () => {
    expect(errorToProviderCode({ status: 401 })).toBe(ProviderErrorCode.InvalidApiKey);
    expect(errorToProviderCode(new Error('too many requests'))).toBe(ProviderErrorCode.RateLimited);
    expect(errorToProviderCode(new Error('model not found'))).toBe(ProviderErrorCode.ModelNotFound);
    expect(errorToProviderCode('connection refused')).toBe(ProviderErrorCode.ConnectionError);
    expect(errorToProviderCode(new Error('timed out'))).toBe(ProviderErrorCode.Timeout);
    expect(errorToProviderCode(new Error('unrelated failure'))).toBe(ProviderErrorCode.InternalError);
    expect(errorToProviderCode(null)).toBe(ProviderErrorCode.InternalError);
  });

  it('builds standardized errors with user-friendly messages', () => {
    const err = createProviderError(ProviderErrorCode.InvalidApiKey, new Error('boom'));
    expect(err.message).toContain('Invalid API key');
    expect(err.name).toBe('ProviderError[invalid_api_key]');
    expect(err.cause).toBeInstanceOf(Error);
  });
});

describe('retry helpers', () => {
  it('calculates exponential backoff delays capped at max', () => {
    const opts = { initialDelayMs: 1000, backoffMultiplier: 2, maxDelayMs: 5000 };
    expect(calculateRetryDelay(0, opts)).toBe(1000);
    expect(calculateRetryDelay(1, opts)).toBe(2000);
    expect(calculateRetryDelay(3, opts)).toBe(5000);
  });

  it('detects retryable errors', () => {
    expect(isRetryableError(new Error('rate limit exceeded'))).toBe(true);
    expect(isRetryableError(new Error('connection refused'))).toBe(true);
    expect(isRetryableError(new Error('model not found'))).toBe(false);
  });

  it('retries on retryable failures then succeeds', async () => {
    const op = vi
      .fn()
      .mockRejectedValueOnce(new Error('too many requests'))
      .mockRejectedValueOnce(new Error('too many requests'))
      .mockResolvedValueOnce('ok');
    const result = await withRetry(op, { maxAttempts: 3, initialDelayMs: 1, backoffMultiplier: 1, maxDelayMs: 2 });
    expect(result).toBe('ok');
    expect(op).toHaveBeenCalledTimes(3);
  });

  it('gives up after max attempts', async () => {
    const op = vi.fn().mockRejectedValue(new Error('internal error'));
    await expect(withRetry(op, { maxAttempts: 2, initialDelayMs: 1, backoffMultiplier: 1, maxDelayMs: 2 })).rejects.toThrow(
      'internal error',
    );
    expect(op).toHaveBeenCalledTimes(2);
  });
});

describe('cancellationTokenToAbortSignal', () => {
  it('returns an already-aborted signal when the token is cancelled', () => {
    const signal = cancellationTokenToAbortSignal({ isCancellationRequested: true });
    expect(signal.aborted).toBe(true);
  });

  it('returns a non-aborted signal for an uncancelled token', () => {
    const signal = cancellationTokenToAbortSignal({ isCancellationRequested: false, onCancellationRequested: () => ({ dispose: vi.fn() }) });
    expect(signal.aborted).toBe(false);
  });

  it('aborts the signal when the token requests cancellation', () => {
    const listeners: Array<() => void> = [];
    const signal = cancellationTokenToAbortSignal({
      isCancellationRequested: false,
      onCancellationRequested: (listener: () => void) => {
        listeners.push(listener);
        return { dispose: vi.fn() };
      },
    });
    expect(signal.aborted).toBe(false);
    listeners[0]();
    expect(signal.aborted).toBe(true);
  });

  it('handles tokens without onCancellationRequested', () => {
    const signal = cancellationTokenToAbortSignal({ isCancellationRequested: false });
    expect(signal.aborted).toBe(false);
  });
});

describe('ApiKeyManager', () => {
  let secrets: { get: ReturnType<typeof vi.fn>; store: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
  let context: vscode.ExtensionContext;

  beforeEach(() => {
    secrets = {
      get: vi.fn().mockResolvedValue(undefined),
      store: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    context = { secrets } as unknown as vscode.ExtensionContext;
    (commands.executeCommand as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  });

  it('initializes and loads a stored key', async () => {
    secrets.get.mockResolvedValue('stored-key');
    const mgr = new ApiKeyManager(context, { secretKey: 'Z_API_KEY', contextKey: 'zModels.hasApiKey', displayName: 'Z.ai API Key' });
    await mgr.initialize();
    expect(await mgr.getApiKey()).toBe('stored-key');
    expect(await mgr.hasApiKey()).toBe(true);
  });

  it('reports no key when none is stored', async () => {
    const mgr = new ApiKeyManager(context, { secretKey: 'Z_API_KEY', contextKey: 'zModels.hasApiKey', displayName: 'Z.ai API Key' });
    expect(await mgr.hasApiKey()).toBe(false);
  });

  it('stores a key and fires listeners', async () => {
    const mgr = new ApiKeyManager(context, { secretKey: 'Z_API_KEY', contextKey: 'zModels.hasApiKey', displayName: 'Z.ai API Key' });
    const listener = vi.fn();
    mgr.onDidChangeApiKey(listener);
    await mgr.setApiKey('new-key');
    expect(secrets.store).toHaveBeenCalledWith('Z_API_KEY', 'new-key');
    expect(listener).toHaveBeenCalledWith('updated', 'new-key');
    expect(commands.executeCommand).toHaveBeenCalledWith('setContext', 'zModels.hasApiKey', true);
  });

  it('prompts for a key when none is provided', async () => {
    (window.showInputBox as ReturnType<typeof vi.fn>).mockResolvedValue('prompted-key');
    const mgr = new ApiKeyManager(context, {
      secretKey: 'Z_API_KEY',
      contextKey: 'zModels.hasApiKey',
      displayName: 'Z.ai API Key',
      promptMessage: 'Enter your key',
    });
    await mgr.setApiKey();
    expect(window.showInputBox).toHaveBeenCalledWith({ prompt: 'Enter your key', password: true, ignoreFocusOut: true });
    expect(secrets.store).toHaveBeenCalledWith('Z_API_KEY', 'prompted-key');
  });

  it('deletes the key and fires listeners', async () => {
    secrets.get.mockResolvedValue('existing');
    const mgr = new ApiKeyManager(context, { secretKey: 'Z_API_KEY', contextKey: 'zModels.hasApiKey', displayName: 'Z.ai API Key' });
    const listener = vi.fn();
    mgr.onDidChangeApiKey(listener);
    await mgr.deleteApiKey();
    expect(secrets.delete).toHaveBeenCalledWith('Z_API_KEY');
    expect(listener).toHaveBeenCalledWith('deleted', undefined);
    expect(commands.executeCommand).toHaveBeenCalledWith('setContext', 'zModels.hasApiKey', false);
  });
});

describe('UsageStatusBar', () => {
  it('shows, updates display, and hides', async () => {
    const item = window.createStatusBarItem() as unknown as vscode.StatusBarItem;
    const dataSource = {
      refreshQuota: vi.fn().mockResolvedValue({
        used: 80,
        total: 100,
        unit: 'tokens',
        window: 'hourly',
        percentUsed: 0.8,
      }),
      getQuota: vi.fn(),
    };
    const bar = new UsageStatusBar({ displayName: 'Z.ai Usage', quotaDataSource: dataSource, refreshIntervalMs: 1000 });
    await bar.show();
    expect(item.text).toContain('Z.ai Usage');
    expect(item.show).toHaveBeenCalled();
    const quota = await bar.refresh();
    expect(quota?.percentUsed).toBe(0.8);
    bar.updateDisplay({ used: 10, total: 10, unit: 'tokens', window: 'hourly', percentUsed: 1 });
    expect(item.tooltip).toContain('100%');
    bar.hide();
    expect(item.hide).toHaveBeenCalled();
    bar.dispose();
  });
});

describe('createVSCodeAgentLoop', () => {
  it('streams markdown content and thinking via write/writeChunk/end', async () => {
    const markdown = vi.fn();
    const progress = vi.fn();
    const loop = createVSCodeAgentLoop({
      stream: { markdown, progress },
      showThinking: true,
      thinkingStyle: 'progress',
    });
    await loop.write('hello');
    await loop.writeChunk({ thinking: 'reasoning', content: ' world' });
    await loop.end();
    expect(markdown).toHaveBeenCalled();
    expect(progress).toHaveBeenCalledWith('reasoning');
  });
});

describe('MCP helpers', () => {
  it('creates server definitions with auth headers and env', async () => {
    const provider = createMcpServerDefinitionProvider({
      servers: [
        { name: 'a', command: 'https://x/mcp', enabledSettingKey: 'a.enabled', apiKeyHeader: 'Authorization' },
        { name: 'b', command: 'cmd', args: ['-y'], apiKeyEnvVar: 'KEY' },
      ],
      settings: { get: vi.fn().mockReturnValue(true) },
      getApiKey: async () => 'secret',
      defaultApiKeyHeader: 'Authorization',
      formatApiKeyHeaderValue: (k: string) => `Bearer ${k}`,
    });
    const defs = await provider.provide();
    expect(defs[0].headers?.Authorization).toBe('Bearer secret');
    expect(defs[1].env?.KEY).toBe('secret');
    expect(defs[1].args).toEqual(['-y']);
  });

  it('disables servers when the setting is false', async () => {
    const provider = createMcpServerDefinitionProvider({
      servers: [{ name: 'a', command: 'cmd', enabledSettingKey: 'a.enabled' }],
      settings: { get: vi.fn().mockReturnValue(false) },
      defaultEnabled: true,
    });
    const defs = await provider.provide();
    expect(defs[0].disabled).toBe(true);
  });

  it('registry registers, unregisters, and loads from providers', async () => {
    const registry = new McpServerRegistry({
      namespace: 'zModels.mcpServers',
      providers: [
        {
          provide: async () => [{ name: 'one', command: 'cmd' }, { name: 'two', command: 'cmd2' }],
        },
      ],
    });
    await registry.loadFromProviders();
    expect(registry.has('one')).toBe(true);
    expect(registry.has('two')).toBe(true);
    expect(registry.get('one')?.command).toBe('cmd');
    expect(registry.getAll()).toHaveLength(2);
    expect(registry.unregister('one')).toBe(true);
    expect(registry.has('one')).toBe(false);
    registry.dispose();
  });
});
