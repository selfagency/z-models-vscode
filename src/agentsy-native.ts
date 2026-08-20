import { LLMStreamProcessor, type ProcessorOptions, type ProcessedOutput, type OutputPart } from '@agentsy/core';
import type { FinishReason, StreamChunk, UsageInfo } from '@agentsy/types';
import * as vscode from 'vscode';

// ── Provider error codes ──────────────────────────────────────────────────
// Standardized error codes mapped to VS Code LanguageModelError subtypes.
// Replicates the surface previously provided by @agentsy/vscode.
export enum ProviderErrorCode {
  InvalidApiKey = 'invalid_api_key',
  RateLimited = 'rate_limited',
  ModelNotFound = 'model_not_found',
  ContextLengthExceeded = 'context_length_exceeded',
  ConnectionError = 'connection_error',
  Timeout = 'timeout',
  InvalidRequest = 'invalid_request',
  InternalError = 'internal_error',
  NotImplemented = 'not_implemented',
  Cancelled = 'cancelled',
}

export const ErrorCodeToMessage: Record<ProviderErrorCode, string> = {
  [ProviderErrorCode.InvalidApiKey]: 'Invalid API key. Please check your credentials in settings.',
  [ProviderErrorCode.RateLimited]: 'Rate limited. Please wait a moment and try again.',
  [ProviderErrorCode.ModelNotFound]: 'Model not found. Please check your model configuration.',
  [ProviderErrorCode.ContextLengthExceeded]:
    'Context length exceeded. Please reduce your message length or use a model with more context.',
  [ProviderErrorCode.ConnectionError]: 'Connection failed. Please check your network and provider URL.',
  [ProviderErrorCode.Timeout]: 'Request timed out. Please try again.',
  [ProviderErrorCode.InvalidRequest]: 'Invalid request. Please check your input format.',
  [ProviderErrorCode.InternalError]: 'Internal server error. Please try again.',
  [ProviderErrorCode.NotImplemented]: 'Feature not implemented by this provider.',
  [ProviderErrorCode.Cancelled]: 'Request was cancelled.',
};

const STATUS_TO_ERROR_CODE = new Map<number, ProviderErrorCode>([
  [401, ProviderErrorCode.InvalidApiKey],
  [403, ProviderErrorCode.InvalidApiKey],
  [429, ProviderErrorCode.RateLimited],
  [404, ProviderErrorCode.ModelNotFound],
  [408, ProviderErrorCode.Timeout],
  [504, ProviderErrorCode.Timeout],
  [400, ProviderErrorCode.InvalidRequest],
]);

/** Maps an HTTP status code to a ProviderErrorCode. */
export function httpStatusToErrorCode(status: number): ProviderErrorCode {
  return STATUS_TO_ERROR_CODE.get(status) ?? ProviderErrorCode.InternalError;
}

function extractErrorString(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null && 'message' in error) return String(error.message);
  if (error && typeof error === 'object') {
    try {
      return JSON.stringify(error);
    } catch {
      return 'Unknown error';
    }
  }
  return String(error);
}

/** Maps a generic unknown error to a ProviderErrorCode by inspecting status/message patterns. */
export function errorToProviderCode(error: unknown): ProviderErrorCode {
  if (error == null) return ProviderErrorCode.InternalError;
  if (typeof error === 'object' && 'status' in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'number') return httpStatusToErrorCode(status);
  }
  const message = extractErrorString(error).toLowerCase();
  const patterns: Array<[string[], ProviderErrorCode]> = [
    [['invalid api key', 'unauthorized', 'authentication'], ProviderErrorCode.InvalidApiKey],
    [['rate limit', 'too many requests', '429'], ProviderErrorCode.RateLimited],
    [['model not found', 'no such model'], ProviderErrorCode.ModelNotFound],
    [['context length', 'token limit', 'too long'], ProviderErrorCode.ContextLengthExceeded],
    [['econnrefused', 'connection refused', 'network', 'fetch failed'], ProviderErrorCode.ConnectionError],
    [['timeout', 'timed out', 'etimedout'], ProviderErrorCode.Timeout],
    [['cancelled', 'aborted'], ProviderErrorCode.Cancelled],
    [['invalid request', 'bad request'], ProviderErrorCode.InvalidRequest],
  ];
  for (const [keywords, code] of patterns) {
    if (keywords.some(kw => message.includes(kw))) return code;
  }
  return ProviderErrorCode.InternalError;
}

/** Get the user-friendly message for an error code. */
export function errorCodeToMessage(code: ProviderErrorCode): string {
  return ErrorCodeToMessage[code] ?? ErrorCodeToMessage[ProviderErrorCode.InternalError];
}

/** Build a standardized Error from a provider error code and optional original error. */
export function createProviderError(code: ProviderErrorCode, originalError?: unknown): Error {
  const message = errorCodeToMessage(code);
  const error = new Error(message);
  error.name = `ProviderError[${code}]`;
  if (originalError instanceof Error) {
    error.cause = originalError;
  }
  return error;
}

// ── Retry helpers ─────────────────────────────────────────────────────────
export interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  backoffMultiplier?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
}

const RETRYABLE_CODES = new Set<ProviderErrorCode>([
  ProviderErrorCode.RateLimited,
  ProviderErrorCode.Timeout,
  ProviderErrorCode.ConnectionError,
  ProviderErrorCode.InternalError,
]);

/** Checks if an error is retryable based on its provider error code. */
export function isRetryableError(error: unknown): boolean {
  return RETRYABLE_CODES.has(errorToProviderCode(error));
}

/** Calculates the delay for a given retry attempt using exponential backoff. */
export function calculateRetryDelay(
  attempt: number,
  options: Required<Pick<RetryOptions, 'initialDelayMs' | 'backoffMultiplier' | 'maxDelayMs'>>,
): number {
  const delay = options.initialDelayMs * options.backoffMultiplier ** attempt;
  return Math.min(delay, options.maxDelayMs);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new Error('Operation aborted'));
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error('Operation aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/** Executes an operation with automatic retry on retryable errors. */
export async function withRetry<T>(operation: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { maxAttempts = 3, initialDelayMs = 1000, backoffMultiplier = 2, maxDelayMs = 30000, signal } = options;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) {
      throw new Error('Operation aborted');
    }
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const isLast = attempt === maxAttempts - 1;
      if (isLast || !isRetryableError(error)) {
        throw error;
      }
      const delay = calculateRetryDelay(attempt, { initialDelayMs, backoffMultiplier, maxDelayMs });
      await sleep(delay, signal);
    }
  }
  throw lastError;
}

// ── CancellationToken → AbortSignal ───────────────────────────────────────
type CancellationListener = () => void;
interface CancellationTokenLike {
  isCancellationRequested?: boolean;
  onCancellationRequested?: (listener: CancellationListener) => { dispose(): void };
}

/** Converts a VS Code CancellationToken to an AbortSignal. */
export function cancellationTokenToAbortSignal(token: CancellationTokenLike): AbortSignal {
  if (token.isCancellationRequested === true) {
    const controller = new AbortController();
    controller.abort();
    return controller.signal;
  }
  const controller = new AbortController();
  if (typeof token.onCancellationRequested !== 'function') {
    return controller.signal;
  }
  try {
    let cancellationListener: { dispose(): void } | undefined;
    cancellationListener = token.onCancellationRequested(() => {
      controller.abort();
      cancellationListener?.dispose();
    });
    if (controller.signal.aborted) {
      cancellationListener?.dispose();
    }
  } catch {
    // Ignore cancellation-listener registration errors.
  }
  return controller.signal;
}

// ── VS Code agent loop renderer ──────────────────────────────────────────
interface MinimalChatResponseStream {
  markdown(content: string): void;
  progress?(content: string): void;
  thinkingProgress?(delta: { text?: string | string[]; id?: string; metadata?: Record<string, unknown> }): void;
  beginToolInvocation?(toolCallId: string, toolName: string, streamData?: unknown): void;
  updateToolInvocation?(toolCallId: string, streamData: unknown): void;
  usage?(usage: { promptTokens: number; completionTokens: number; outputBuffer?: number }): void;
}

type ThinkingStyle = 'blockquote' | 'progress' | 'suppress';

interface VSCodeAgentLoopOptions extends ProcessorOptions {
  stream: MinimalChatResponseStream;
  showThinking?: boolean;
  thinkingStyle?: ThinkingStyle;
  abortSignal?: AbortSignal;
  processor?: LLMStreamProcessor;
  onError?: (error: Error) => void;
  onToolCall?: (part: Extract<OutputPart, { type: 'tool_call' }>) => void | Promise<void>;
  onToolCallDelta?: (delta: Extract<OutputPart, { type: 'tool_call_delta' }>) => void | Promise<void>;
  onFinish?: (finishReason: FinishReason | undefined, usage: UsageInfo | undefined) => void | Promise<void>;
  onStep?: (stepIndex: number, usage: UsageInfo | undefined) => void | Promise<void>;
}

function appendToBlockquote(text: string, atLineStart: boolean): string {
  if (!text) return '';
  return `${atLineStart ? '> ' : ''}${text.replaceAll('\n', '\n> ')}`;
}

interface RendererHandle {
  write(chunk: string): Promise<void>;
  writeChunk(chunk: StreamChunk): Promise<void>;
  end(): Promise<void>;
}

/**
 * Replicates @agentsy/renderers createSharedRendererHandle: drives an LLMStreamProcessor
 * and dispatches output parts to per-type handlers.
 */
function createSharedRendererHandle(
  options: VSCodeAgentLoopOptions,
  handlers: {
    onText(text: string): Promise<void>;
    onThinking(text: string): Promise<void>;
    onToolCall?(part: Extract<OutputPart, { type: 'tool_call' }>): Promise<void>;
    onToolCallDelta?(part: Extract<OutputPart, { type: 'tool_call_delta' }>): Promise<void>;
    onEnd?(): Promise<void>;
  },
  onError?: (error: Error) => void,
): RendererHandle {
  const llmProcessor = options.processor ?? new LLMStreamProcessor();
  let finished = false;
  let lastReportedStepIndex: number | undefined;

  async function emitStepChange(result: ProcessedOutput): Promise<void> {
    if (options.onStep === undefined || result.stepIndex === undefined || result.stepIndex === lastReportedStepIndex) {
      return;
    }
    lastReportedStepIndex = result.stepIndex;
    await options.onStep(result.stepIndex, result.stepUsage ?? result.usage);
  }

  async function processParts(result: ProcessedOutput): Promise<void> {
    for (const part of result.parts) {
      switch (part.type) {
        case 'text':
          await handlers.onText(part.text);
          break;
        case 'thinking':
          await handlers.onThinking(part.text);
          break;
        case 'tool_call':
          if (handlers.onToolCall) await handlers.onToolCall(part);
          break;
        case 'tool_call_delta':
          if (handlers.onToolCallDelta) await handlers.onToolCallDelta(part);
          break;
      }
    }
  }

  return {
    async write(chunk) {
      try {
        const result = llmProcessor.process({ content: chunk });
        await processParts(result);
      } catch (error) {
        if (onError && error instanceof Error) onError(error);
        else throw error;
      }
    },
    async writeChunk(chunk) {
      try {
        const result = llmProcessor.process(chunk);
        await processParts(result);
        await emitStepChange(result);
        if (chunk.done === true && !finished && options.onFinish) {
          finished = true;
          await options.onFinish(chunk.finishReason, chunk.usage);
        }
      } catch (error) {
        if (onError && error instanceof Error) onError(error);
        else throw error;
      }
    },
    async end() {
      try {
        const result = llmProcessor.flush();
        await processParts(result);
        await emitStepChange(result);
        if (!finished && options.onFinish) {
          finished = true;
          await options.onFinish(result.finishReason, result.usage);
        }
        if (handlers.onEnd) await handlers.onEnd();
      } catch (error) {
        if (onError && error instanceof Error) onError(error);
        else throw error;
      }
    },
  };
}

function createVSCodeChatRenderer(options: VSCodeAgentLoopOptions): RendererHandle {
  const { stream, showThinking = false, thinkingStyle = 'blockquote', onError, onToolCall, onToolCallDelta, onFinish } =
    options;
  if (!stream) {
    throw new Error('ChatResponseStream is required for VS Code chat renderer');
  }
  let blockquoteThinkingStarted = false;
  let blockquoteNeedsPrefix = true;

  function handleThinkingPart(text: string): void {
    if (!showThinking || thinkingStyle === 'suppress') return;
    if (stream.thinkingProgress) {
      stream.thinkingProgress({ text, id: 'thinking' });
    } else if (thinkingStyle === 'progress') {
      stream.progress?.(text);
    } else {
      if (!blockquoteThinkingStarted) {
        stream.markdown('\n\n> 💭 **Thinking**\n>\n');
        blockquoteThinkingStarted = true;
        blockquoteNeedsPrefix = true;
      }
      const blockquoteContent = appendToBlockquote(text, blockquoteNeedsPrefix);
      stream.markdown(blockquoteContent);
      blockquoteNeedsPrefix = text.endsWith('\n');
    }
  }

  const sharedOnFinish = async (finishReason: FinishReason | undefined, usage: UsageInfo | undefined) => {
    if (usage && stream.usage) {
      stream.usage({
        promptTokens: usage.inputTokens ?? 0,
        completionTokens: usage.outputTokens ?? 0,
      });
    }
    if (blockquoteThinkingStarted && thinkingStyle === 'blockquote') {
      stream.markdown('\n\n');
      blockquoteThinkingStarted = false;
    }
    if (onFinish) await onFinish(finishReason, usage);
  };

  const sharedOptions: VSCodeAgentLoopOptions = { ...options, onFinish: sharedOnFinish };

  return createSharedRendererHandle(
    sharedOptions,
    {
      onText: async text => {
        stream.markdown(text);
      },
      onThinking: async text => {
        handleThinkingPart(text);
      },
      onToolCall: async part => {
        if (onToolCall) await onToolCall(part);
      },
      onToolCallDelta: async part => {
        if (onToolCallDelta) await onToolCallDelta(part);
      },
    },
    onError,
  );
}

/**
 * Creates a VS Code renderer optimized for multi-step agent loops.
 * Defaults `showThinking: true` and supports an optional abort signal.
 */
export function createVSCodeAgentLoop(options: VSCodeAgentLoopOptions): {
  write(chunk: string): Promise<void>;
  writeChunk(chunk: StreamChunk): Promise<void>;
  end(): Promise<void>;
} {
  const mergedOptions = { ...options, showThinking: options.showThinking !== false };
  const renderer = createVSCodeChatRenderer(mergedOptions);
  let endPromise: Promise<void> | null = null;
  let detachAbortListener: (() => void) | undefined;

  const endOnce = async () => {
    if (endPromise) return endPromise;
    detachAbortListener?.();
    detachAbortListener = undefined;
    endPromise = renderer.end().finally(() => {
      detachAbortListener?.();
      detachAbortListener = undefined;
    });
    return endPromise;
  };

  const abortSignal = options.abortSignal;
  if (abortSignal) {
    const onAbort = () => {
      endOnce().catch(err => {
        console.warn('[VS Code Agent Loop] Error during cancellation cleanup:', err);
      });
    };
    if (abortSignal.aborted) {
      onAbort();
    } else {
      abortSignal.addEventListener('abort', onAbort, { once: true });
      detachAbortListener = () => {
        abortSignal.removeEventListener('abort', onAbort);
      };
    }
  }

  return {
    write: renderer.write,
    writeChunk: renderer.writeChunk,
    end: endOnce,
  };
}

// ── ApiKeyManager ─────────────────────────────────────────────────────────
type ApiKeyEvent = 'changed' | 'deleted' | 'updated';
type ApiKeyChangeListener = (event: ApiKeyEvent, newKey: string | undefined) => void;

export interface ApiKeyManagerConfig {
  secretKey: string;
  contextKey: string;
  displayName: string;
  promptMessage?: string;
  validateBeforeStore?: (key: string) => boolean | Promise<boolean>;
  onError?: (error: Error) => void;
}

/** Manages a VS Code API key stored in ExtensionContext.secrets. */
export class ApiKeyManager {
  private readonly listeners = new Set<ApiKeyChangeListener>();
  private apiKey: string | undefined;
  private isInitialized = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly config: ApiKeyManagerConfig,
  ) {}

  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    this.apiKey = await this.context.secrets.get(this.config.secretKey);
    this.isInitialized = true;
    await this.setupContextVariable();
  }

  async getApiKey(): Promise<string | undefined> {
    if (!this.isInitialized) {
      await this.initialize();
    }
    return this.apiKey;
  }

  async hasApiKey(): Promise<boolean> {
    const key = await this.getApiKey();
    return Boolean(key);
  }

  async setApiKey(key?: string): Promise<void> {
    let newKey = key;
    if (!newKey) {
      newKey = await this.promptForApiKey();
      if (!newKey) return;
    }
    if (this.config.validateBeforeStore) {
      try {
        const isValid = await this.config.validateBeforeStore(newKey);
        if (!isValid) {
          const error = new Error('API key validation failed');
          this.config.onError?.(error);
          throw error;
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.config.onError?.(err);
        throw err;
      }
    }
    await this.context.secrets.store(this.config.secretKey, newKey);
    this.apiKey = newKey;
    await this.setupContextVariable();
    await this.setupHasKeyContext();
    this.notifyListeners('updated', newKey);
  }

  async deleteApiKey(): Promise<void> {
    await this.context.secrets.delete(this.config.secretKey);
    this.apiKey = undefined;
    await this.setupContextVariable();
    await this.setupHasKeyContext();
    this.notifyListeners('deleted', undefined);
  }

  async setupHasKeyContext(): Promise<void> {
    const hasKey = await this.hasApiKey();
    try {
      await vscode.commands.executeCommand('setContext', this.config.contextKey, hasKey);
    } catch {
      // Ignore setContext failures (e.g. tests without command host).
    }
  }

  async setupContextVariable(): Promise<void> {
    await this.setupHasKeyContext();
  }

  onDidChangeApiKey(listener: ApiKeyChangeListener): { dispose(): void } {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  offDidChangeApiKey(listener: ApiKeyChangeListener): void {
    this.listeners.delete(listener);
  }

  async _debugShowStoredKey(): Promise<string | undefined> {
    const key = await this.getApiKey();
    if (key) {
      return key.substring(0, 4) + '*'.repeat(Math.max(0, key.length - 8)) + key.substring(key.length - 4);
    }
    return undefined;
  }

  private async promptForApiKey(): Promise<string | undefined> {
    return this.promptForInput(this.config.displayName, this.config.promptMessage || `Enter your ${this.config.displayName}:`, true);
  }

  private async promptForInput(_title: string, prompt: string, password: boolean): Promise<string | undefined> {
    try {
      return await vscode.window.showInputBox({ prompt, password, ignoreFocusOut: true });
    } catch {
      return undefined;
    }
  }

  private notifyListeners(event: ApiKeyEvent, newKey: string | undefined): void {
    for (const listener of this.listeners) {
      try {
        listener(event, newKey);
      } catch (error) {
        console.error('Error in ApiKeyManager listener:', error);
      }
    }
  }

  dispose(): void {
    this.listeners.clear();
    this.apiKey = undefined;
  }
}

// ── Usage quota + status bar ──────────────────────────────────────────────
export interface UsageQuota {
  used: number;
  total: number;
  unit: 'tokens' | 'credits' | 'requests';
  window: 'hourly' | 'daily' | 'weekly' | 'monthly';
  percentUsed: number;
  expiresAt?: Date;
}

export interface IQuotaDataSource {
  getQuota(): Promise<UsageQuota>;
  refreshQuota(): Promise<UsageQuota>;
  dispose?(): void;
}

export interface UsageStatusBarConfig {
  displayName: string;
  tooltipTemplate?: string;
  warningThreshold?: number;
  errorThreshold?: number;
  refreshIntervalMs?: number;
  onClickRefresh?: () => Promise<void>;
  quotaDataSource: IQuotaDataSource;
  colorScheme?: { normal: string; warning: string; error: string };
}

const DEFAULT_REFRESH_INTERVAL = 60_000;
const DEFAULT_TOOLTIP = '{{used}} / {{total}} {{unit}} used ({{percent}}%)';
const DEFAULT_WARNING_THRESHOLD = 0.8;
const DEFAULT_ERROR_THRESHOLD = 0.95;

/** Displays quota usage in the VS Code status bar with configurable thresholds. */
export class UsageStatusBar {
  private statusBarItem: vscode.StatusBarItem | undefined;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly config: UsageStatusBarConfig) {}

  async show(): Promise<void> {
    try {
      const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
      if (!item) return;
      this.statusBarItem = item;
      if (this.config.onClickRefresh) {
        item.command = 'agentsy.refreshUsage';
      }
      this.disposables.push(item);
      await this.refresh();
      item.show();
      this.startAutoRefresh();
    } catch {
      // No-op if VS Code is unavailable.
    }
  }

  async refresh(): Promise<UsageQuota | undefined> {
    try {
      const quota = await this.config.quotaDataSource.refreshQuota();
      this.updateDisplay(quota);
      return quota;
    } catch {
      return undefined;
    }
  }

  updateDisplay(quota: UsageQuota): void {
    if (!this.statusBarItem) return;
    const item = this.statusBarItem;
    const percent = Math.round(quota.percentUsed * 100);
    item.text = `$(pulse) ${this.config.displayName}: ${quota.used.toLocaleString()} / ${quota.total.toLocaleString()} ${quota.unit}`;
    const template = this.config.tooltipTemplate ?? DEFAULT_TOOLTIP;
    item.tooltip = template
      .replace('{{used}}', quota.used.toLocaleString())
      .replace('{{total}}', quota.total.toLocaleString())
      .replace('{{unit}}', quota.unit)
      .replace('{{percent}}', String(percent));
    item.color = this.pickColor(quota.percentUsed);
  }

  private pickColor(percentUsed: number): string | undefined {
    const colorScheme = this.config.colorScheme;
    if (!colorScheme) return undefined;
    const warning = this.config.warningThreshold ?? DEFAULT_WARNING_THRESHOLD;
    const error = this.config.errorThreshold ?? DEFAULT_ERROR_THRESHOLD;
    if (percentUsed >= error) return colorScheme.error;
    if (percentUsed >= warning) return colorScheme.warning;
    return colorScheme.normal;
  }

  hide(): void {
    if (this.statusBarItem) {
      this.statusBarItem.hide();
    }
  }

  dispose(): void {
    this.stopAutoRefresh();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.config.quotaDataSource.dispose?.();
  }

  private startAutoRefresh(): void {
    const interval = this.config.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL;
    this.refreshTimer = setInterval(() => {
      void this.refresh();
    }, interval);
  }

  private stopAutoRefresh(): void {
    if (this.refreshTimer !== undefined) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }
}

// ── MCP server definition provider + registry ────────────────────────────
export interface McpServerDefinition {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  disabled?: boolean;
  alwaysAllow?: boolean;
}

export interface McpServerProvider {
  provide(): Promise<McpServerDefinition[]>;
}

export interface McpServerRegistryConfig {
  namespace: string;
  providers?: McpServerProvider[];
  autoRegister?: boolean;
}

interface McpProviderSettingsReader {
  get<T>(key: string, fallback?: T): T | undefined;
}

interface McpProviderServerDefinition extends McpServerDefinition {
  enabledSettingKey?: string;
  apiKeyEnvVar?: string;
  apiKeyHeader?: string;
}

export interface CreateMcpServerDefinitionProviderOptions {
  servers: McpProviderServerDefinition[] | (() => Promise<McpProviderServerDefinition[]> | McpProviderServerDefinition[]);
  settings?: McpProviderSettingsReader;
  getApiKey?: () => Promise<string | undefined>;
  defaultEnabled?: boolean;
  defaultApiKeyEnvVar?: string;
  defaultApiKeyHeader?: string;
  formatApiKeyHeaderValue?: (apiKey: string) => string;
}

function resolveEnabled(
  server: McpProviderServerDefinition,
  settings: McpProviderSettingsReader | undefined,
  defaultEnabled: boolean,
): boolean {
  if (server.enabledSettingKey === undefined || settings === undefined) {
    return server.disabled !== true;
  }
  const settingValue = settings.get(server.enabledSettingKey, defaultEnabled);
  if (typeof settingValue === 'boolean') return settingValue;
  return defaultEnabled;
}

function injectAuthIntoEnv(
  env: Record<string, string>,
  server: McpProviderServerDefinition,
  apiKey: string | undefined,
  options: CreateMcpServerDefinitionProviderOptions,
): void {
  if (typeof apiKey !== 'string' || apiKey.length === 0) return;
  const envKey = server.apiKeyEnvVar ?? options.defaultApiKeyEnvVar;
  if (typeof envKey === 'string' && envKey.length > 0) {
    env[envKey] = apiKey;
  }
}

function injectAuthHeader(
  headers: Record<string, string>,
  server: McpProviderServerDefinition,
  apiKey: string | undefined,
  options: CreateMcpServerDefinitionProviderOptions,
): void {
  if (typeof apiKey !== 'string' || apiKey.length === 0) return;
  const headerKey = server.apiKeyHeader ?? options.defaultApiKeyHeader;
  if (typeof headerKey === 'string' && headerKey.length > 0) {
    headers[headerKey] = (options.formatApiKeyHeaderValue ?? ((k: string) => k))(apiKey);
  }
}

function toServerDefinition(
  server: McpProviderServerDefinition,
  env: Record<string, string>,
  headers: Record<string, string>,
  enabled: boolean,
): McpServerDefinition {
  return {
    name: server.name,
    command: server.command,
    ...(server.args === undefined ? {} : { args: server.args }),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(server.alwaysAllow ? { alwaysAllow: true } : {}),
    ...(enabled ? {} : { disabled: true }),
  };
}

function enrichServer(
  server: McpProviderServerDefinition,
  apiKey: string | undefined,
  options: CreateMcpServerDefinitionProviderOptions,
  defaultEnabled: boolean,
): McpServerDefinition {
  const enabled = resolveEnabled(server, options.settings, defaultEnabled);
  const env = { ...server.env };
  const headers = { ...server.headers };
  injectAuthIntoEnv(env, server, apiKey, options);
  injectAuthHeader(headers, server, apiKey, options);
  return toServerDefinition(server, env, headers, enabled);
}

/** Creates an MCP server-definition provider with built-in auth and settings enrichment. */
export function createMcpServerDefinitionProvider(options: CreateMcpServerDefinitionProviderOptions): McpServerProvider {
  const defaultEnabled = options.defaultEnabled ?? true;
  return {
    async provide() {
      const rawServers = typeof options.servers === 'function' ? await options.servers() : options.servers;
      const apiKey = await options.getApiKey?.();
      return rawServers.map(server => enrichServer(server, apiKey, options, defaultEnabled));
    },
  };
}

/** Manages registration and lifecycle of MCP servers. */
export class McpServerRegistry {
  private readonly servers = new Map<string, McpServerDefinition>();

  constructor(private readonly config: McpServerRegistryConfig) {}

  register(server: McpServerDefinition): boolean {
    if (this.servers.has(server.name)) return false;
    this.servers.set(server.name, server);
    return true;
  }

  unregister(name: string): boolean {
    return this.servers.delete(name);
  }

  has(name: string): boolean {
    return this.servers.has(name);
  }

  get(name: string): McpServerDefinition | undefined {
    return this.servers.get(name);
  }

  getAll(): McpServerDefinition[] {
    return Array.from(this.servers.values());
  }

  async loadFromProviders(): Promise<void> {
    if (!this.config.providers) return;
    for (const provider of this.config.providers) {
      const definitions = await provider.provide();
      for (const def of definitions) {
        this.register(def);
      }
    }
  }

  async activate(): Promise<void> {
    await this.loadFromProviders();
    if (this.config.autoRegister) {
      await this.registerWithVscode();
    }
  }

  async registerWithVscode(): Promise<void> {
    try {
      const config = vscode.workspace.getConfiguration();
      const existing = config.get(this.config.namespace) as Record<string, unknown> | undefined;
      const merged: Record<string, unknown> = { ...existing };
      for (const server of this.servers.values()) {
        if (server.disabled) continue;
        merged[server.name] = this.toWorkspaceServerConfig(server);
      }
      await config.update(this.config.namespace, merged, vscode.ConfigurationTarget.Workspace);
    } catch {
      // No-op if VS Code is unavailable.
    }
  }

  private toWorkspaceServerConfig(server: McpServerDefinition): Record<string, unknown> {
    return {
      command: server.command,
      ...(server.args === undefined ? {} : { args: server.args }),
      ...(server.env === undefined ? {} : { env: server.env }),
      ...(server.headers === undefined ? {} : { headers: server.headers }),
    };
  }

  dispose(): void {
    this.servers.clear();
  }
}
