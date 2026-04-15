import { LLMStreamProcessor } from '@selfagency/llm-stream-parser/processor';
import got from 'got';
import { randomBytes } from 'node:crypto';
import { get_encoding, Tiktoken } from 'tiktoken';
import {
  CancellationToken,
  Event,
  EventEmitter,
  ExtensionContext,
  LanguageModelChatInformation,
  LanguageModelChatMessage,
  LanguageModelChatProvider,
  LanguageModelDataPart,
  LanguageModelError,
  LanguageModelResponsePart,
  LanguageModelTextPart,
  LanguageModelToolCallPart,
  LanguageModelToolResultPart,
  LogOutputChannel,
  Progress,
  ProvideLanguageModelChatResponseOptions,
  window,
  workspace,
} from 'vscode';
import { formatModelName, getChatModelInfo, resolveModelCapabilities, type ZModel } from './model-info.js';
import { toZRole } from './role-utils.js';

// For deterministic unit tests, environment fallback can be explicitly enabled.
const allowEnvInTests = process.env.Z_MODELS_ALLOW_ENV_API_KEY_IN_TESTS === '1';

/**
 * MCP Server configuration
 */
export interface MCPServerConfig {
  vision: boolean;
  search: boolean;
  reader: boolean;
  zread: boolean;
}

type ApiEndpointMode = 'zaiCoding' | 'zaiGeneral' | 'bigmodel';

const DEFAULT_BASE_BY_MODE: Record<ApiEndpointMode, string> = {
  zaiCoding: 'https://api.z.ai/api/coding/paas/v4',
  zaiGeneral: 'https://api.z.ai/api/paas/v4',
  bigmodel: 'https://open.bigmodel.cn/api/paas/v4',
};

// Default completion tokens for rate limiting optimization
const DEFAULT_COMPLETION_TOKENS = 65536;
const DEFAULT_MAX_OUTPUT_TOKENS = 16384;

// Maximum characters per tool result to prevent context window overflow
const MAX_TOOL_RESULT_CHARS = 20000;

// Maximum number of tools per request
const MAX_TOOLS_PER_REQUEST = 128;

// Retry configuration for API requests
const MAX_RETRIES = 10;
const BASE_RETRY_DELAY_MS = 2000;
const RETRYABLE_STATUS_CODES = [429, 500, 502, 503, 504];

const KNOWN_MODEL_TOKEN_LIMITS: Record<string, { maxInputTokens: number; maxOutputTokens?: number }> = {
  'glm-4.6': { maxInputTokens: 200_000, maxOutputTokens: 128_000 },
  'glm-4.7': { maxInputTokens: 200_000, maxOutputTokens: 128_000 },
  'glm-5': { maxInputTokens: 200_000, maxOutputTokens: 128_000 },
  'glm-5.1': { maxInputTokens: 200_000, maxOutputTokens: 128_000 },
  'glm-5-turbo': { maxInputTokens: 200_000, maxOutputTokens: 128_000 },
  'glm-5v-turbo': { maxInputTokens: 200_000, maxOutputTokens: 128_000 },
  'glm-4.6v': { maxInputTokens: 128_000 },
};

function getKnownTokenLimits(id: string): { maxInputTokens?: number; maxOutputTokens?: number } {
  const normalized = id.toLowerCase();
  return KNOWN_MODEL_TOKEN_LIMITS[normalized] ?? {};
}

// ── Text-embedded tool call token parsing ──────────────────────────────────
// Z.ai sometimes emits tool calls as text tokens like:
//   <|tool_call_begin|>tool_name<|tool_call_argument_begin|>{"arg":"val"}<|tool_call_end|>
// These must be parsed and emitted as LanguageModelToolCallPart instead of raw text.
const TOOL_CALL_BEGIN = '<|tool_call_begin|>';
const TOOL_CALL_ARG_BEGIN = '<|tool_call_argument_begin|>';
const TOOL_CALL_END = '<|tool_call_end|>';

/**
 * Parse provider control tokens embedded in streamed text content and emit
 * tool calls and visible text appropriately.
 */
function parseTextEmbeddedToolCalls(
  input: string,
  buffer: string,
  active: { name?: string; index?: number; argBuffer: string; emitted?: boolean } | undefined,
  emittedKeys: Set<string>,
): {
  visibleText: string;
  newBuffer: string;
  newActive: typeof active;
  toolCalls: Array<{ name: string; arguments: string }>;
} {
  const toolCalls: Array<{ name: string; arguments: string }> = [];
  let data = buffer + input;
  let visibleOut = '';
  let currentActive = active;

  while (data.length > 0) {
    if (!currentActive) {
      const b = data.indexOf(TOOL_CALL_BEGIN);
      if (b === -1) {
        // Check for partial prefix at end
        let longestPartialPrefix = 0;
        for (let k = Math.min(TOOL_CALL_BEGIN.length - 1, data.length - 1); k > 0; k--) {
          if (data.endsWith(TOOL_CALL_BEGIN.slice(0, k))) {
            longestPartialPrefix = k;
            break;
          }
        }
        if (longestPartialPrefix > 0) {
          visibleOut += stripControlTokens(data.slice(0, data.length - longestPartialPrefix));
          data = '';
          break;
        }
        visibleOut += stripControlTokens(data);
        data = '';
        break;
      }

      // Emit any text before the token
      const pre = data.slice(0, b);
      if (pre) visibleOut += stripControlTokens(pre);
      data = data.slice(b + TOOL_CALL_BEGIN.length);

      // Find the argument begin or end token
      const a = data.indexOf(TOOL_CALL_ARG_BEGIN);
      const e = data.indexOf(TOOL_CALL_END);
      let delimIdx = -1;
      let delimKind: 'arg' | 'end' | undefined;
      if (a !== -1 && (e === -1 || a < e)) {
        delimIdx = a;
        delimKind = 'arg';
      } else if (e !== -1) {
        delimIdx = e;
        delimKind = 'end';
      } else {
        // No delimiter yet — buffer the whole thing
        data = TOOL_CALL_BEGIN + data;
        break;
      }

      const header = data.slice(0, delimIdx).trim();
      const m = header.match(/^([A-Za-z0-9_\-.]+)(?::(\d+))?/);
      const name = m?.[1];
      const index = m?.[2] ? Number(m[2]) : undefined;
      currentActive = { name, index, argBuffer: '', emitted: false };

      if (delimKind === 'arg') {
        data = data.slice(delimIdx + TOOL_CALL_ARG_BEGIN.length);
      } else {
        data = data.slice(delimIdx + TOOL_CALL_END.length);
        const key = `${currentActive.name ?? 'unknown'}:${currentActive.argBuffer}`;
        if (!emittedKeys.has(key)) {
          toolCalls.push({ name: currentActive.name ?? 'unknown_tool', arguments: '{}' });
          emittedKeys.add(key);
          currentActive.emitted = true;
        }
        currentActive = undefined;
      }
      continue;
    }

    // Active tool call — look for end token
    const e2 = data.indexOf(TOOL_CALL_END);
    if (e2 === -1) {
      currentActive.argBuffer += data;
      if (!currentActive.emitted) {
        const parsed = tryParseJson(currentActive.argBuffer);
        if (parsed) {
          const key = `${currentActive.name ?? 'unknown'}:${currentActive.argBuffer}`;
          if (!emittedKeys.has(key)) {
            toolCalls.push({ name: currentActive.name ?? 'unknown_tool', arguments: currentActive.argBuffer });
            emittedKeys.add(key);
            currentActive.emitted = true;
          }
        }
      }
      data = '';
      break;
    }

    currentActive.argBuffer += data.slice(0, e2);
    data = data.slice(e2 + TOOL_CALL_END.length);
    if (!currentActive.emitted) {
      const key = `${currentActive.name ?? 'unknown'}:${currentActive.argBuffer}`;
      if (!emittedKeys.has(key)) {
        toolCalls.push({ name: currentActive.name ?? 'unknown_tool', arguments: currentActive.argBuffer || '{}' });
        emittedKeys.add(key);
      }
    }
    currentActive = undefined;
  }

  return { visibleText: visibleOut, newBuffer: data, newActive: currentActive, toolCalls };
}

function stripControlTokens(text: string): string {
  return text
    .replace(/<\|[a-zA-Z0-9_-]+_section_(?:begin|end)\|>/g, '')
    .replace(/<\|tool_call_(?:argument_)?(?:begin|end)\|>/g, '');
}

function tryParseJson(text: string): Record<string, unknown> | undefined {
  if (!text || !text.trim()) return undefined;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Message types for Z API
 */
export type ZContent = string | Array<{ type: 'text'; text: string } | { type: 'image_url'; imageUrl: string }>;

export type ZToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

export type ZMessage =
  | { role: 'user'; content: ZContent }
  | { role: 'assistant'; content: ZContent | null; tool_calls?: ZToolCall[] }
  | { role: 'tool'; content: string | null; tool_call_id: string; name?: string };

/**
 * Supported `options.modelOptions` keys for Z.ai requests.
 *
 * This type intentionally mirrors user-facing knobs that we accept today.
 * Unknown keys are ignored.
 */
export interface ZSupportedModelOptions {
  temperature?: number;
  topP?: number;
  safePrompt?: boolean;

  // Thinking controls
  thinking?: boolean;
  thinkingType?: 'enabled' | 'disabled';
  clearThinking?: boolean;
  clear_thinking?: boolean;

  // Structured output / JSON mode
  jsonMode?: boolean;
  responseFormat?: 'json_object' | { type: 'json_object' };

  // Web search tool helper
  webSearch?: boolean | Record<string, unknown>;
  web_search?: boolean | Record<string, unknown>;
}

interface ZParsedRequestOptions {
  temperature: number;
  topP?: number;
  safePrompt?: boolean;
  thinking?: { type: 'enabled' | 'disabled'; clear_thinking?: boolean };
  responseFormat?: { type: 'json_object' };
  webSearchTool?: { type: 'web_search'; web_search: Record<string, unknown> };
}

/**
 * Z Chat Model Provider
 * Implements VS Code's LanguageModelChatProvider interface for GitHub Copilot Chat
 */
export class ZChatModelProvider implements LanguageModelChatProvider {
  private static readonly MODEL_CACHE_TTL_MS = 30 * 60 * 1000;

  private client: any | null = null;
  private tokenizer: Tiktoken | null = null;
  private fetchedModels: ZModel[] | null = null;
  private modelCacheTimestamp = 0;
  private initPromise?: Promise<boolean>;
  private mcpConfig: MCPServerConfig = {
    vision: true,
    search: true,
    reader: true,
    zread: true,
  };
  // Mapping from VS Code tool call IDs to Z tool call IDs
  private toolCallIdMapping = new Map<string, string>();
  // Mapping from Z tool call IDs to VS Code tool call IDs
  private reverseToolCallIdMapping = new Map<string, string>();
  private readonly log: LogOutputChannel;
  // Event emitter for notifying VS Code when models change
  private readonly _onDidChangeLanguageModelChatInformation = new EventEmitter<void>();
  // Track token usage from API responses
  private usageMetrics = { promptTokens: 0, completionTokens: 0 };
  private usageReported = false;
  private apiKeyForDiscovery?: string;
  // Text-embedded tool call parser state
  private textToolBuffer = '';
  private textToolActive: { name?: string; index?: number; argBuffer: string; emitted?: boolean } | undefined;
  private emittedTextToolCallKeys = new Set<string>();
  // User-Agent header for API requests
  private readonly userAgent: string;

  private getConfiguredBaseUrl(): string {
    try {
      const config = workspace.getConfiguration('zModels');
      const override = (config.get<string>('api.baseUrlOverride', '') || '').trim();
      if (override.length > 0) {
        return override;
      }

      const mode = config.get<ApiEndpointMode>('api.endpointMode', 'zaiCoding');
      return DEFAULT_BASE_BY_MODE[mode] ?? DEFAULT_BASE_BY_MODE.zaiCoding;
    } catch {
      // Fallback for tests or environments without workspace configuration support.
      return DEFAULT_BASE_BY_MODE.zaiCoding;
    }
  }

  private hasBaseUrlOverride(): boolean {
    try {
      const config = workspace.getConfiguration('zModels');
      const override = (config.get<string>('api.baseUrlOverride', '') || '').trim();
      return override.length > 0;
    } catch {
      return false;
    }
  }

  private async fetchModelsAcrossDefaultEndpoints(apiKey: string): Promise<any[]> {
    const configured = this.getConfiguredBaseUrl().replace(/\/$/, '');
    const baseUrls = [
      configured,
      DEFAULT_BASE_BY_MODE.zaiCoding,
      DEFAULT_BASE_BY_MODE.zaiGeneral,
      DEFAULT_BASE_BY_MODE.bigmodel,
    ].map(url => url.replace(/\/$/, ''));

    const uniqueBaseUrls = [...new Set(baseUrls)];

    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'User-Agent': this.userAgent,
    };

    const retry = {
      limit: 1,
      statusCodes: RETRYABLE_STATUS_CODES,
    };

    const responses = await Promise.all(
      uniqueBaseUrls.map(async baseUrl => {
        try {
          const data = await got
            .get(`${baseUrl}/models`, {
              headers,
              retry,
            })
            .json<any>();
          const models = Array.isArray(data?.data) ? data.data : [];
          this.log.info(`[Z] model discovery from ${baseUrl}: ${models.length} model(s)`);
          return models;
        } catch (error) {
          this.log.debug(`[Z] model discovery unavailable at ${baseUrl}: ${String(error)}`);
          return [];
        }
      }),
    );

    const merged = new Map<string, any>();
    for (const set of responses) {
      for (const model of set) {
        const id = typeof model?.id === 'string' ? model.id : undefined;
        if (!id) continue;
        if (!merged.has(id)) {
          merged.set(id, model);
          continue;
        }
        const existing = merged.get(id);
        merged.set(id, {
          ...existing,
          ...model,
          capabilities: {
            ...(existing?.capabilities ?? {}),
            ...(model?.capabilities ?? {}),
          },
        });
      }
    }

    return [...merged.values()];
  }

  /**
   * Convert HTTP status codes to proper VS Code LanguageModelError subtypes.
   */
  private toLanguageModelError(status: number, statusText: string, details: string): Error {
    const message = `Z.ai API error: ${status} ${statusText}${details ? `\n${details}` : ''}`;
    if (status === 401 || status === 403) {
      return LanguageModelError.NoPermissions(message);
    }
    if (status === 404) {
      return LanguageModelError.NotFound(message);
    }
    if (status === 429) {
      return LanguageModelError.Blocked(message);
    }
    return new Error(message);
  }

  /**
   * Check if a model supports vision natively.
   */
  private modelSupportsVision(modelId: string): boolean {
    if (this.fetchedModels) {
      const found = this.fetchedModels.find(m => m.id === modelId);
      return found?.supportsVision ?? false;
    }
    return /(?:\d+(?:\.\d+)?v(?:-|$)|5v(?:-|$)|vision|vl|-ocr)/i.test(modelId);
  }

  /**
   * Pick a fallback vision model for image input.
   */
  private getVisionFallbackModelId(): string | undefined {
    if (this.fetchedModels) {
      const preferred = this.fetchedModels.find(m => m.id === 'glm-4.6v' && m.supportsVision);
      if (preferred) return preferred.id;
      return this.fetchedModels.find(m => m.supportsVision)?.id;
    }
    return 'glm-4.6v';
  }

  /**
   * Check if any message contains image input parts.
   */
  private hasImageInput(messages: readonly LanguageModelChatMessage[]): boolean {
    for (const msg of messages) {
      for (const part of msg.content) {
        if (part instanceof LanguageModelDataPart && part.mimeType?.startsWith('image/')) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Truncate text to a maximum number of characters for tool results.
   */
  private static truncateText(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    const removed = text.length - maxChars;
    return `${text.slice(0, maxChars)}\n...[truncated ${removed} chars]`;
  }

  /**
   * Report token usage metrics to VS Code Chat UI via LanguageModelDataPart.
   */
  private reportUsageMetrics(progress: Progress<LanguageModelResponsePart>): void {
    if (this.usageReported) return;
    if (this.usageMetrics.promptTokens > 0 || this.usageMetrics.completionTokens > 0) {
      const totalTokens = this.usageMetrics.promptTokens + this.usageMetrics.completionTokens;
      this.log.info(`[Z] Token usage: prompt=${this.usageMetrics.promptTokens}, completion=${this.usageMetrics.completionTokens}, total=${totalTokens}`);
      try {
        progress.report(
          LanguageModelDataPart.json(
            {
              type: 'usage',
              prompt_tokens: this.usageMetrics.promptTokens,
              completion_tokens: this.usageMetrics.completionTokens,
              total_tokens: totalTokens,
            },
            'application/vnd.zai.usage+json',
          ),
        );
      } catch {
        // Best effort — progress may already be closed
      }
      this.usageReported = true;
    }
  }

  private async getApiKeyFromSecretsOrEnv(): Promise<string | undefined> {
    const fromSecrets = await this.context.secrets.get('Z_API_KEY');
    if (fromSecrets && fromSecrets.trim().length > 0) {
      return fromSecrets;
    }

    // Keep unit tests deterministic unless explicitly enabled.
    if (process.env.VITEST && !allowEnvInTests) {
      return undefined;
    }

    const fromEnv = (process.env.Z_API_KEY || process.env.ZHIPU_API_KEY || '').trim();
    return fromEnv.length > 0 ? fromEnv : undefined;
  }

  /* c8 ignore start */
  private createHttpClient(apiKey: string): {
    models: { list: () => Promise<{ data: any[] }> };
    chat: {
      stream: (payload: {
        model: string;
        messages: ZMessage[];
        maxTokens: number;
        tools?: Array<Record<string, unknown>>;
        toolChoice?: 'auto' | 'none';
        toolStream?: boolean;
        thinking?: { type: 'enabled' | 'disabled'; clear_thinking?: boolean };
        responseFormat?: { type: 'json_object' };
        temperature?: number;
        topP?: number;
        safePrompt?: boolean;
        abortSignal?: AbortSignal;
      }) => AsyncIterable<{
        data: {
          choices: Array<{
            delta: {
              content?: string;
              reasoning_content?: string;
              tool_calls?: Array<{
                index?: number;
                id?: string;
                type?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
            finish_reason?: string | null;
          }>;
          usage?: { prompt_tokens_details?: { cached_tokens?: number } };
        };
      }>;
    };
  } {
    const baseUrl = this.getConfiguredBaseUrl().replace(/\/$/, '');
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'User-Agent': this.userAgent,
    };

    const retry = {
      limit: MAX_RETRIES,
      statusCodes: RETRYABLE_STATUS_CODES,
      calculateDelay: ({ attemptCount, error, retryOptions }: any) => {
        if (attemptCount > retryOptions.limit) {
          return 0;
        }

        const statusCode = error?.response?.statusCode;
        if (statusCode && !retryOptions.statusCodes.includes(statusCode)) {
          return 0;
        }

        const base = BASE_RETRY_DELAY_MS;
        const cap = 60000;
        return Math.min(base * 2 ** (attemptCount - 1), cap);
      },
    };

    return {
      models: {
        list: async () => {
          try {
            const data = await got
              .get(`${baseUrl}/models`, {
                headers,
                retry,
              })
              .json<any>();
            return { data: Array.isArray(data?.data) ? data.data : [] };
          } catch {
            // Some endpoints don't expose model listing for this plan; fallback handled by caller.
            return { data: [] };
          }
        },
      },
      chat: {
        stream: async function* ({
          model,
          messages,
          maxTokens,
          tools,
          toolChoice,
          toolStream,
          thinking,
          responseFormat,
          temperature,
          topP,
          safePrompt,
          abortSignal,
        }) {
          const gotStream = got.stream.post(`${baseUrl}/chat/completions`, {
            headers,
            retry,
            signal: abortSignal,
            json: {
              model,
              messages,
              max_tokens: maxTokens,
              temperature,
              top_p: topP,
              safe_prompt: safePrompt,
              tools,
              tool_choice: toolChoice,
              tool_stream: toolStream,
              thinking,
              response_format: responseFormat,
              stream: true,
            },
          });

          let buffer = '';
          let hasSeenSseLine = false;

          for await (const chunk of gotStream) {
            buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk);
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const rawLine of lines) {
              const line = rawLine.trim();
              if (!line.startsWith('data:')) continue;
              hasSeenSseLine = true;
              const payload = line.slice('data:'.length).trim();
              if (!payload || payload === '[DONE]') continue;

              try {
                const parsed = JSON.parse(payload) as any;
                const choice = parsed?.choices?.[0];
                const delta = choice?.delta;
                const hasDelta =
                  delta !== undefined &&
                  (delta.content !== undefined ||
                    delta.reasoning_content !== undefined ||
                    delta.tool_calls !== undefined);
                if (hasDelta || choice?.finish_reason !== undefined || parsed?.usage !== undefined) {
                  yield {
                    data: {
                      choices: [
                        {
                          delta: {
                            content:
                              typeof delta?.content === 'string'
                                ? delta.content
                                : Array.isArray(delta?.content)
                                  ? delta.content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join('')
                                  : undefined,
                            reasoning_content:
                              typeof delta?.reasoning_content === 'string' ? delta.reasoning_content : undefined,
                            tool_calls: Array.isArray(delta?.tool_calls) ? delta.tool_calls : undefined,
                          },
                          finish_reason: choice?.finish_reason ?? null,
                        },
                      ],
                      usage: parsed?.usage,
                    },
                  };
                }
              } catch {
                // Ignore malformed SSE frames.
              }
            }
          }

          // Flush any remaining buffer content.
          const remaining = buffer.trim();
          if (remaining) {
            if (remaining.startsWith('data:')) {
              const payload = remaining.slice('data:'.length).trim();
              if (payload && payload !== '[DONE]') {
                try {
                  const parsed = JSON.parse(payload) as any;
                  const choice = parsed?.choices?.[0];
                  const delta = choice?.delta;
                  const hasDelta =
                    delta !== undefined &&
                    (delta.content !== undefined ||
                      delta.reasoning_content !== undefined ||
                      delta.tool_calls !== undefined);
                  if (hasDelta || choice?.finish_reason !== undefined || parsed?.usage !== undefined) {
                    yield {
                      data: {
                        choices: [
                          {
                            delta: {
                              content:
                                typeof delta?.content === 'string'
                                  ? delta.content
                                  : Array.isArray(delta?.content)
                                    ? delta.content
                                        .map((c: any) => (typeof c?.text === 'string' ? c.text : ''))
                                        .join('')
                                    : undefined,
                              reasoning_content:
                                typeof delta?.reasoning_content === 'string' ? delta.reasoning_content : undefined,
                              tool_calls: Array.isArray(delta?.tool_calls) ? delta.tool_calls : undefined,
                            },
                            finish_reason: choice?.finish_reason ?? null,
                          },
                        ],
                        usage: parsed?.usage,
                      },
                    };
                  }
                } catch {
                  // Ignore malformed SSE frames.
                }
              }
            } else if (!hasSeenSseLine) {
              // Non-SSE response: emit full body as a single chunk.
              yield { data: { choices: [{ delta: { content: remaining } }] } };
            }
          }
        },
      },
    };
  }
  /* c8 ignore stop */

  /**
   * Parse and normalize VS Code `modelOptions` into Z API request fields.
   *
   * Accepted keys are documented by `ZSupportedModelOptions`.
   */
  private parseModelOptions(modelOptionsRaw: unknown, foundModel: ZModel): ZParsedRequestOptions {
    const modelOptions = ((modelOptionsRaw as Record<string, unknown>) ?? {}) as ZSupportedModelOptions;

    const temperature =
      typeof modelOptions.temperature === 'number' ? modelOptions.temperature : (foundModel.temperature ?? 0.7);
    const topP = typeof modelOptions.topP === 'number' ? modelOptions.topP : (foundModel.top_p ?? undefined);
    const safePrompt = typeof modelOptions.safePrompt === 'boolean' ? modelOptions.safePrompt : undefined;

    const explicitThinking = modelOptions.thinking === true || modelOptions.thinkingType === 'enabled';
    const explicitDisabled = modelOptions.thinking === false || modelOptions.thinkingType === 'disabled';
    const clearThinking =
      typeof modelOptions.clearThinking === 'boolean'
        ? modelOptions.clearThinking
        : typeof modelOptions.clear_thinking === 'boolean'
          ? modelOptions.clear_thinking
          : undefined;
    const thinking: { type: 'enabled' | 'disabled'; clear_thinking?: boolean } | undefined = explicitThinking
      ? { type: 'enabled', ...(clearThinking !== undefined ? { clear_thinking: clearThinking } : {}) }
      : explicitDisabled
        ? { type: 'disabled', ...(clearThinking !== undefined ? { clear_thinking: clearThinking } : {}) }
        : undefined;

    const responseFormat =
      modelOptions.responseFormat === 'json_object' || modelOptions.jsonMode === true
        ? { type: 'json_object' as const }
        : typeof modelOptions.responseFormat === 'object' && modelOptions.responseFormat
          ? (modelOptions.responseFormat as { type: 'json_object' })
          : undefined;

    const webSearchEnabled =
      modelOptions.webSearch === true ||
      typeof modelOptions.webSearch === 'object' ||
      modelOptions.web_search === true ||
      typeof modelOptions.web_search === 'object';

    const webSearchConfig =
      typeof modelOptions.webSearch === 'object' && modelOptions.webSearch
        ? modelOptions.webSearch
        : typeof modelOptions.web_search === 'object' && modelOptions.web_search
          ? modelOptions.web_search
          : {
              enable: true,
              search_engine: 'search-prime',
              search_result: true,
            };

    const webSearchTool = webSearchEnabled
      ? {
          type: 'web_search' as const,
          web_search: webSearchConfig,
        }
      : undefined;

    return {
      temperature,
      topP,
      safePrompt,
      thinking,
      responseFormat,
      webSearchTool,
    };
  }

  /**
   * Event fired when the available set of language models changes.
   */
  readonly onDidChangeLanguageModelChatInformation: Event<void> = this._onDidChangeLanguageModelChatInformation.event;

  constructor(
    private readonly context: ExtensionContext,
    logOutputChannel?: LogOutputChannel,
    // When true, attempt interactive initialization on construction (activation).
    // Default is false to avoid prompting during unit tests which instantiate the provider.
    autoInit: boolean = false,
    userAgent?: string,
  ) {
    // Accept an optional logOutputChannel to keep tests simple. Provide a no-op fallback when not available.
    if (logOutputChannel) {
      this.log = logOutputChannel;
    } else {
      // Minimal no-op logger matching LogOutputChannel methods used here.
      // Cast via unknown to satisfy the LogOutputChannel type without using `any`.
      this.log = {
        info: () => {},
        debug: () => {},
        warn: () => {},
        error: () => {},
        appendLine: () => {},
        dispose: () => {},
      } as unknown as LogOutputChannel;
    }

    this.userAgent = userAgent ?? `z-models-vscode/unknown`;

    // Load MCP server configuration from settings
    this.loadMCPConfig();

    this.log.info('[Z] Provider constructed');
    if (autoInit) {
      this.log.info('[Z] Auto-initializing client on activation');
      // Start initialization and refresh model catalog immediately so the
      // model picker reflects latest availability on startup.
      this.initPromise = this.initClient(true)
        .then(async initialized => {
          if (!initialized) {
            return false;
          }

          // Force a fresh discovery pass on startup.
          this.fetchedModels = null;
          this.modelCacheTimestamp = 0;
          await this.fetchModels();
          this.log.info('[Z] Startup model catalog refresh complete');
          return true;
        })
        .catch(error => {
          this.log.warn('[Z] Startup model catalog refresh failed: ' + String(error));
          return false;
        });
      // Do not await here (activation should not be blocked); consumers will await initPromise.
    }
  }

  /**
   * Load MCP server configuration from VS Code settings
   */
  private loadMCPConfig(): void {
    try {
      const config = workspace.getConfiguration('zModels');
      this.mcpConfig = {
        vision: config.get('mcpServers.vision', true),
        search: config.get('mcpServers.search', true),
        reader: config.get('mcpServers.reader', true),
        zread: config.get('mcpServers.zread', true),
      };
    } catch {
      this.mcpConfig = {
        vision: true,
        search: true,
        reader: true,
        zread: true,
      };
    }
    this.log.info(`[Z] Loaded MCP configuration: ${JSON.stringify(this.mcpConfig)}`);
  }

  /**
   * Generate a valid VS Code tool call ID (alphanumeric, exactly 9 characters)
   */
  public generateToolCallId(): string {
    const bytes = randomBytes(8)
      .toString('base64url')
      .replace(/[^a-zA-Z0-9]/g, '');
    if (bytes.length >= 9) {
      return bytes.slice(0, 9);
    }
    return `${bytes}${randomBytes(8).toString('hex')}`.slice(0, 9);
  }

  /**
   * Get or create a VS Code-compatible tool call ID from a Z tool call ID
   */
  public getOrCreateVsCodeToolCallId(zId: string): string {
    // Check if we already have a mapping for this Z ID
    if (this.reverseToolCallIdMapping.has(zId)) {
      return this.reverseToolCallIdMapping.get(zId)!;
    }
    // Create a new mapping
    const vsCodeId = this.generateToolCallId();
    this.toolCallIdMapping.set(vsCodeId, zId);
    this.reverseToolCallIdMapping.set(zId, vsCodeId);
    return vsCodeId;
  }

  /**
   * Get the original Z tool call ID from a VS Code tool call ID
   */
  public getZToolCallId(vsCodeId: string): string | undefined {
    return this.toolCallIdMapping.get(vsCodeId);
  }

  /**
   * Fetch available chat models from the Z API and cache the result.
   * Returns an empty array if the client is not initialized or the request fails.
   */
  public async fetchModels(): Promise<ZModel[]> {
    if (this.fetchedModels !== null && Date.now() - this.modelCacheTimestamp < ZChatModelProvider.MODEL_CACHE_TTL_MS) {
      return this.fetchedModels;
    }

    if (!this.client) {
      return [];
    }

    try {
      let zModels: any[] = [];
      let usedClientList = false;

      // Compatibility path: tests and advanced users can inject a custom client with models.list().
      if (this.client?.models?.list) {
        usedClientList = true;
        const response = await this.client.models.list();
        zModels = Array.isArray(response?.data) ? response.data : [];

        if (this.apiKeyForDiscovery && !this.hasBaseUrlOverride()) {
          const merged = await this.fetchModelsAcrossDefaultEndpoints(this.apiKeyForDiscovery);
          if (merged.length > 0) {
            zModels = merged;
          }
        }
      }

      // Fallback curated set when API/model listing is unavailable.
      if ((!Array.isArray(zModels) || zModels.length === 0) && !usedClientList) {
        zModels = [
          {
            id: 'glm-5.1',
            name: 'GLM 5.1',
            description: 'Latest GLM model',
            maxContextLength: 128000,
            defaultModelTemperature: 0.7,
            capabilities: { completionChat: true, functionCalling: true, vision: true },
          },
        ];
      }

      if (!Array.isArray(zModels) || zModels.length === 0) {
        this.fetchedModels = [];
        this.modelCacheTimestamp = Date.now();
        return this.fetchedModels;
      }

      const chatModels = zModels.filter(m => resolveModelCapabilities(m).completionChat !== false);

      const rawModels = chatModels.map(m => ({
        capabilities: resolveModelCapabilities(m),
        id: m.id,
        originalName: m.name ?? formatModelName(m.id),
        detail: m.detail ?? m.description ?? undefined,
        maxInputTokens: m.maxInputTokens ?? m.maxContextLength ?? getKnownTokenLimits(m.id).maxInputTokens ?? 32768,
        maxOutputTokens: m.maxOutputTokens ?? getKnownTokenLimits(m.id).maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        defaultCompletionTokens:
          m.defaultCompletionTokens ?? getKnownTokenLimits(m.id).maxOutputTokens ?? DEFAULT_COMPLETION_TOKENS,
        toolCalling: resolveModelCapabilities(m).functionCalling,
        supportsParallelToolCalls: m.supportsParallelToolCalls ?? resolveModelCapabilities(m).functionCalling,
        supportsVision: resolveModelCapabilities(m).vision,
        temperature: m.temperature ?? m.defaultModelTemperature ?? undefined,
      }));

      const modelsToUse = rawModels;

      // Detect ambiguous (duplicate) display names and append the model id when needed.
      const nameCounts = new Map<string, number>();
      for (const rm of modelsToUse) {
        const n = rm.originalName;
        nameCounts.set(n, (nameCounts.get(n) ?? 0) + 1);
      }

      // Map API detail through as the model.detail — we will override the
      // UI-visible `detail` in getChatModelInfo to show a short label while
      // preserving the original description on the model object itself.
      this.fetchedModels = modelsToUse.map(rm => ({
        id: rm.id,
        name: nameCounts.get(rm.originalName)! > 1 ? `${rm.originalName} (${rm.id})` : rm.originalName,
        detail: rm.detail,
        maxInputTokens: rm.maxInputTokens,
        maxOutputTokens: rm.maxOutputTokens,
        defaultCompletionTokens: rm.defaultCompletionTokens,
        toolCalling: rm.toolCalling,
        supportsParallelToolCalls: rm.supportsParallelToolCalls,
        supportsVision: rm.supportsVision,
        temperature: rm.temperature,
      }));
      this.modelCacheTimestamp = Date.now();
      // Notify VS Code that models are available
      this._onDidChangeLanguageModelChatInformation.fire(undefined);
      return this.fetchedModels;
    } catch (error) {
      this.log.error('[Z] Failed to fetch models: ' + String(error));
      return [];
    }
  }

  /**
   * Clear tool call ID mappings (call at the start of each chat request)
   */
  public clearToolCallIdMappings(): void {
    this.toolCallIdMapping.clear();
    this.reverseToolCallIdMapping.clear();
    this.log.debug('[Z] Cleared tool call ID mappings');
  }

  /**
   * Prompts the user to enter their Z API key and stores it securely.
   * @returns A promise that resolves to the entered API key if valid, or undefined if cancelled
   */
  public async setApiKey(): Promise<string | undefined> {
    let apiKey: string | undefined = await this.getApiKeyFromSecretsOrEnv();
    this.log.debug('[Z] Prompting user for API key (existing present: ' + !!apiKey + ')');
    apiKey = await window.showInputBox({
      placeHolder: 'Z API Key',
      password: true,
      value: apiKey || '',
      prompt: 'Enter your Z API key (get one at https://z.ai/manage-apikey/apikey-list)',
      ignoreFocusOut: true,
      validateInput: value => {
        if (!value || value.trim().length === 0) {
          return 'API key is required';
        }
        // Basic key shape guard; don't leak or log value.
        if (value.length < 20 || !/^[A-Za-z0-9._-]+$/.test(value)) {
          return 'API key format appears invalid';
        }
        return undefined;
      },
    });

    if (!apiKey) {
      this.log.info('[Z] setApiKey canceled by user');
      return await this.getApiKeyFromSecretsOrEnv();
    }

    this.log.info('[Z] Storing API key and initializing client');
    try {
      await this.context.secrets.store('Z_API_KEY', apiKey);
      this.log.info('[Z] API key stored successfully');
    } catch (e) {
      this.log.warn('[Z] Failed to store API key in secret storage: ' + String(e));
    }
    this.client = this.createHttpClient(apiKey);
    this.apiKeyForDiscovery = apiKey;
    this.fetchedModels = null;
    this.modelCacheTimestamp = 0;
    this._onDidChangeLanguageModelChatInformation.fire(undefined);

    return apiKey;
  }

  /**
   * Initialize the Zhipu AI client.
   * @param silent Whether to initialize silently without prompting for API key
   * @returns Whether the initialization was successful
   */
  private async initClient(silent: boolean): Promise<boolean> {
    if (this.client) {
      return true;
    }

    let apiKey: string | undefined = await this.getApiKeyFromSecretsOrEnv();
    this.log.debug('[Z] initClient called (silent=' + silent + ', hasStoredKey=' + !!apiKey + ')');
    if (!silent && !apiKey) {
      apiKey = await this.setApiKey();
    } else if (apiKey) {
      this.client = this.createHttpClient(apiKey);
      this.apiKeyForDiscovery = apiKey;
    }

    this.log.debug('[Z] initClient result: ' + !!apiKey);
    return !!apiKey;
  }

  /**
   * Provide available chat model information
   */
  async provideLanguageModelChatInformation(
    options: { silent: boolean },
    token: CancellationToken,
  ): Promise<LanguageModelChatInformation[]> {
    this.log.info('[Z] provideLanguageModelChatInformation called (silent=' + options.silent + ')');
    // If an activation-triggered init is in-flight, wait for it to finish before proceeding.
    if (this.initPromise) {
      try {
        await this.initPromise;
      } catch {
        // ignore — initClient logs errors
      }
      this.initPromise = undefined;
    }

    const initialized = await this.initClient(options.silent);
    if (!initialized) {
      this.log.warn('[Z] client not initialized');
      return [];
    }

    if (token.isCancellationRequested) {
      this.log.debug('[Z] provideLanguageModelChatInformation cancelled before model fetch');
      return [];
    }

    const models = await this.fetchModels();
    if (token.isCancellationRequested) {
      this.log.debug('[Z] provideLanguageModelChatInformation cancelled after model fetch');
      return [];
    }
    this.log.info('[Z] Returning ' + models.length + ' models');
    return models.map(model => getChatModelInfo(model));
  }

  /**
   * Provide chat response from Z
   */
  async provideLanguageModelChatResponse(
    model: LanguageModelChatInformation,
    messages: Array<LanguageModelChatMessage>,
    options: ProvideLanguageModelChatResponseOptions,
    progress: Progress<LanguageModelResponsePart>,
    token: CancellationToken,
  ): Promise<void> {
    this.log.info(`[Z] provideLanguageModelChatResponse start for model=${model.id}, messages=${messages.length}`);
    // Clear tool call ID mappings and parser state for this new request
    this.clearToolCallIdMappings();
    this.textToolBuffer = '';
    this.textToolActive = undefined;
    this.emittedTextToolCallKeys.clear();
    this.usageMetrics = { promptTokens: 0, completionTokens: 0 };
    this.usageReported = false;

    // Check if client is initialized
    if (!this.client) {
      throw LanguageModelError.NoPermissions('Please add your Z.ai API key to use Z.ai for Copilot.');
    }

    // Enforce maximum tools per request
    if (options.tools && options.tools.length > MAX_TOOLS_PER_REQUEST) {
      throw new Error(`Cannot have more than ${MAX_TOOLS_PER_REQUEST} tools per request.`);
    }

    // Find the model in our fetched list to get capability details
    const models = await this.fetchModels();
    const foundModel = models.find(m => m.id === model.id) ?? {
      id: model.id,
      name: model.name,
      maxInputTokens: model.maxInputTokens,
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      defaultCompletionTokens: DEFAULT_COMPLETION_TOKENS,
      toolCalling: true,
      supportsParallelToolCalls: false,
      supportsVision: false,
    };

    // Handle vision fallback: if messages contain images but the model doesn't support vision,
    // switch to a vision model automatically.
    let effectiveModelId = model.id;
    const hasImages = this.hasImageInput(messages);
    if (hasImages && !this.modelSupportsVision(model.id)) {
      const visionFallback = this.getVisionFallbackModelId();
      if (visionFallback && visionFallback !== model.id) {
        this.log.warn(`[Z] Switching to vision model for image input: ${model.id} → ${visionFallback}`);
        effectiveModelId = visionFallback;
      }
    }

    // Convert VS Code messages to Z format.
    // Important: a single VS Code message can include multiple tool results. Those must become
    // separate `role:"tool"` messages instead of replacing the whole message.
    const _zMessages = this.toZMessages(messages);

    // Convert VS Code tools to Z format
    const zTools = options.tools?.map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema || {},
      },
    }));

    const shouldSendTools = zTools && zTools.length > 0;

    // Allow VS Code modelOptions to override some request parameters.
    const parsedOptions = this.parseModelOptions(options.modelOptions, foundModel);
    const { temperature, topP, safePrompt, thinking, responseFormat, webSearchTool } = parsedOptions;

    const requestTools: Array<Record<string, unknown>> = [
      ...(shouldSendTools ? zTools : []),
      ...(webSearchTool ? [webSearchTool] : []),
    ];

    const abortController = new AbortController();
    const cancellationSubscription =
      typeof token.onCancellationRequested === 'function'
        ? token.onCancellationRequested(() => {
            abortController.abort();
            this.log.info('[Z] chat request cancelled by user');
          })
        : { dispose: () => {} };

    try {
      const streamResult = await this.client.chat.stream({
        model: effectiveModelId,
        messages: _zMessages,
        maxTokens: Math.min(foundModel.defaultCompletionTokens, foundModel.maxOutputTokens),
        temperature,
        topP,
        safePrompt,
        tools: requestTools.length > 0 ? requestTools : undefined,
        toolChoice: requestTools.length > 0 ? 'auto' : undefined,
        toolStream: requestTools.length > 0 ? true : undefined,
        thinking,
        responseFormat,
        abortSignal: abortController.signal,
      });

      const streamProcessor = new LLMStreamProcessor({
        parseThinkTags: true,
        scrubContextTags: true,
        enforcePrivacyTags: true,
        onWarning: message => {
          this.log.warn('[Z] stream parser: ' + message);
        },
      });

      streamProcessor.on('thinking', delta => {
        this.log.debug('[Z] thinking delta length: ' + (delta?.length ?? 0));
      });

      streamProcessor.on('text', delta => {
        if (delta) {
          this.log.debug('[Z] content delta: ' + delta.slice(0, 200));
          progress.report(new LanguageModelTextPart(delta));
        }
      });

      // Accumulate tool call argument deltas — arguments arrive in pieces across multiple SSE frames.
      const toolCallBuffers = new Map<number, { id: string; name: string; arguments: string }>();
      const emittedToolCalls = new Set<string>();

      for await (const chunk of streamResult) {
        if (token.isCancellationRequested) {
          break;
        }

        const delta = chunk?.data?.choices?.[0]?.delta;
        const finishReason = chunk?.data?.choices?.[0]?.finish_reason;

        // Track usage metrics from streaming response
        const usage = (chunk?.data as any)?.usage;
        if (usage) {
          if (typeof usage.prompt_tokens === 'number') this.usageMetrics.promptTokens = usage.prompt_tokens;
          if (typeof usage.completion_tokens === 'number') this.usageMetrics.completionTokens = usage.completion_tokens;
        }
        const cachedTokens = usage?.prompt_tokens_details?.cached_tokens;
        if (typeof cachedTokens === 'number') {
          this.log.debug(`[Z] cached prompt tokens: ${cachedTokens}`);
        }

        const content = delta?.content;
        if (typeof content === 'string' && content.length > 0) {
          // Parse text-embedded tool call tokens before passing to stream processor
          const { visibleText, newBuffer, newActive, toolCalls: embeddedCalls } = parseTextEmbeddedToolCalls(
            content,
            this.textToolBuffer,
            this.textToolActive,
            this.emittedTextToolCallKeys,
          );
          this.textToolBuffer = newBuffer;
          this.textToolActive = newActive;

          // Emit any visible text through the stream processor
          if (visibleText.length > 0) {
            streamProcessor.process({ content: visibleText });
          }

          // Emit any tool calls parsed from text-embedded tokens
          for (const tc of embeddedCalls) {
            try {
              const parsed = JSON.parse(tc.arguments) as Record<string, unknown>;
              const vsCodeId = this.getOrCreateVsCodeToolCallId(`text_${tc.name}_${Date.now()}`);
              progress.report(new LanguageModelToolCallPart(vsCodeId, tc.name, parsed));
              this.log.info(`[Z] text-embedded tool call: ${tc.name} (id=${vsCodeId})`);
            } catch {
              this.log.warn(`[Z] Skipping malformed text-embedded tool call for '${tc.name}'.`);
            }
          }
        }

        const reasoning = delta?.reasoning_content;
        if (typeof reasoning === 'string' && reasoning.length > 0) {
          streamProcessor.process({ thinking: reasoning });
        }

        const toolCallDeltas = delta?.tool_calls;
        if (Array.isArray(toolCallDeltas)) {
          for (const tc of toolCallDeltas) {
            const idx = tc.index ?? 0;
            if (!toolCallBuffers.has(idx)) {
              toolCallBuffers.set(idx, { id: tc.id ?? '', name: tc.function?.name ?? '', arguments: '' });
            }
            const buf = toolCallBuffers.get(idx)!;
            if (tc.id) buf.id = tc.id;
            if (tc.function?.name) buf.name = tc.function.name;
            if (tc.function?.arguments) buf.arguments += tc.function.arguments;

            if (buf.id && buf.name && buf.arguments && !emittedToolCalls.has(buf.id)) {
              try {
                const parsed = JSON.parse(buf.arguments) as Record<string, unknown>;
                const vsCodeId = this.getOrCreateVsCodeToolCallId(buf.id);
                progress.report(new LanguageModelToolCallPart(vsCodeId, buf.name, parsed));
                emittedToolCalls.add(buf.id);
                this.log.info(`[Z] tool call streamed: ${buf.name} (id=${vsCodeId})`);
              } catch {
                // Keep buffering until JSON becomes valid.
              }
            }
          }
        }

        if (finishReason === 'tool_calls' || finishReason === 'stop') {
          for (const [, tc] of toolCallBuffers) {
            if (!tc.name || !tc.id || emittedToolCalls.has(tc.id)) {
              continue;
            }
            let input: Record<string, unknown> = {};
            try {
              input = JSON.parse(tc.arguments || '{}') as Record<string, unknown>;
            } catch {
              this.log.warn(`[Z] Skipping malformed streamed tool call arguments for '${tc.name}'.`);
              continue;
            }
            const vsCodeId = this.getOrCreateVsCodeToolCallId(tc.id);
            progress.report(new LanguageModelToolCallPart(vsCodeId, tc.name, input));
            emittedToolCalls.add(tc.id);
            this.log.info(`[Z] tool call flushed: ${tc.name} (id=${vsCodeId})`);
          }
        }
      }

      streamProcessor.flush();

      // Emit accumulated tool calls after streaming completes.
      for (const [, tc] of toolCallBuffers) {
        if (tc.name && tc.id && !emittedToolCalls.has(tc.id)) {
          const vsCodeId = this.getOrCreateVsCodeToolCallId(tc.id);
          let input: Record<string, unknown> = {};
          try {
            input = JSON.parse(tc.arguments || '{}') as Record<string, unknown>;
          } catch {
            this.log.warn(`[Z] Skipping malformed buffered tool call arguments for '${tc.name}'.`);
            continue;
          }
          progress.report(new LanguageModelToolCallPart(vsCodeId, tc.name, input));
          this.log.info(`[Z] tool call emitted: ${tc.name} (id=${vsCodeId})`);
          emittedToolCalls.add(tc.id);
        }
      }

      // Flush any remaining text-embedded tool call
      if (this.textToolActive && this.textToolActive.argBuffer) {
        const parsed = tryParseJson(this.textToolActive.argBuffer);
        if (parsed) {
          const name = this.textToolActive.name ?? 'unknown_tool';
          const vsCodeId = this.getOrCreateVsCodeToolCallId(`text_${name}_${Date.now()}`);
          progress.report(new LanguageModelToolCallPart(vsCodeId, name, parsed));
          this.log.info(`[Z] text-embedded tool call flushed: ${name} (id=${vsCodeId})`);
        }
      }

      // Report usage metrics before finishing
      this.reportUsageMetrics(progress);
    } catch (error) {
      // Classify errors as LanguageModelError subtypes for better VS Code UX
      if (
        token.isCancellationRequested ||
        (error instanceof Error && error.name === 'AbortError')
      ) {
        throw new (LanguageModelError as any)('Request cancelled', 'cancelled');
      }

      // If the error already has an HTTP status, classify it
      const httpStatus = (error as any)?.response?.statusCode ?? (error as any)?.statusCode;
      if (typeof httpStatus === 'number' && httpStatus > 0) {
        const errorBody = (error as any)?.response?.body ?? '';
        throw this.toLanguageModelError(httpStatus, '', typeof errorBody === 'string' ? errorBody : String(errorBody));
      }

      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      this.log.error(
        '[Z] provideLanguageModelChatResponse error: ' +
          (error instanceof Error ? error.stack || error.message : String(error)),
      );
      // Re-throw LanguageModelError as-is, wrap everything else
      if (error instanceof LanguageModelError) throw error;
      throw new Error(errorMessage);
    } finally {
      cancellationSubscription.dispose();
    }
  }

  /**
   * Convert VS Code chat messages into Z Chat Completion messages.
   *
   * Key rules (mirrors OpenAI/Z constraints):
   * - Assistant messages MUST have either non-empty content OR tool_calls.
   * - Tool results MUST be sent as role="tool" messages with tool_call_id.
   */
  public toZMessages(messages: readonly LanguageModelChatMessage[]): ZMessage[] {
    this.log.debug('[Z] toZMessages called with ' + messages.length + ' messages');
    const out: ZMessage[] = [];
    const toolNameByCallId = new Map<string, string>();

    for (const msg of messages) {
      const role = toZRole(msg.role);
      const textParts: string[] = [];
      const imageParts: Array<{ mimeType: string; data: Uint8Array }> = [];
      const toolCalls: ZToolCall[] = [];
      const toolResults: Array<{ callId: string; content: string }> = [];

      for (const part of msg.content) {
        if (part instanceof LanguageModelTextPart) {
          textParts.push(part.value);
          continue;
        }

        if (part instanceof LanguageModelDataPart) {
          // Only handle images. For any other data parts, stringify as text.
          if (part.mimeType?.startsWith('image/')) {
            imageParts.push({ mimeType: part.mimeType, data: part.data });
          } else {
            textParts.push(`[data:${part.mimeType}]`);
          }
          continue;
        }

        if (part instanceof LanguageModelToolCallPart) {
          // Map VS Code tool call ID to Z tool call ID
          // If no mapping exists, generate a valid 9-char alphanumeric ID
          let zId = this.getZToolCallId(part.callId);
          if (!zId) {
            zId = this.generateToolCallId();
            this.toolCallIdMapping.set(part.callId, zId);
            this.reverseToolCallIdMapping.set(zId, part.callId);
          }
          toolNameByCallId.set(zId, part.name);
          toolCalls.push({
            id: zId,
            type: 'function',
            function: {
              name: part.name,
              arguments: JSON.stringify(part.input ?? {}),
            },
          });
          continue;
        }

        if (part instanceof LanguageModelToolResultPart) {
          // Map VS Code tool call ID to Z tool call ID
          // If no mapping exists, generate a valid 9-char alphanumeric ID
          let zId = this.getZToolCallId(part.callId);
          if (!zId) {
            zId = this.generateToolCallId();
            this.toolCallIdMapping.set(part.callId, zId);
            this.reverseToolCallIdMapping.set(zId, part.callId);
          }
          const resultText = part.content
            .filter(p => p instanceof LanguageModelTextPart)
            .map(p => (p as LanguageModelTextPart).value)
            .join('');
          const truncatedResult = resultText && resultText.length > 0
            ? ZChatModelProvider.truncateText(resultText, MAX_TOOL_RESULT_CHARS)
            : ZChatModelProvider.truncateText(JSON.stringify(part.content), MAX_TOOL_RESULT_CHARS);
          toolResults.push({
            callId: zId,
            content: truncatedResult,
          });
          continue;
        }
      }

      const content = textParts.join('');
      const hasContent = content.length > 0;
      const hasToolCalls = toolCalls.length > 0;
      const hasImages = imageParts.length > 0;

      const canSendImages = hasImages;
      let messageContent: ZMessage['content'] | undefined = undefined;
      if (canSendImages) {
        // Z expects a chunk-array for multimodal messages.
        const chunks: Array<{ type: 'text'; text: string } | { type: 'image_url'; imageUrl: string }> = [];
        if (hasContent) {
          chunks.push({ type: 'text', text: content });
        }
        for (const img of imageParts) {
          const base64 = Buffer.from(img.data).toString('base64');
          chunks.push({ type: 'image_url', imageUrl: `data:${img.mimeType};base64,${base64}` });
        }
        messageContent = chunks;
      } else if (hasContent) {
        messageContent = content;
      }

      // Only include non-empty user/system messages.
      // Include assistant messages if they have content OR tool calls.
      if (role === 'assistant') {
        if (hasContent || hasToolCalls) {
          out.push({
            role,
            // If this assistant message is only tool calls, prefer `null` content (matches SDK schema).
            content: messageContent ?? (hasToolCalls ? null : ''),
            tool_calls: hasToolCalls ? toolCalls : undefined,
          });
        }
      } else {
        if (messageContent !== undefined) {
          out.push({ role: 'user', content: messageContent });
        }
      }

      // Tool result messages come after the message that carried them.
      for (const tr of toolResults) {
        out.push({
          role: 'tool',
          content: tr.content,
          tool_call_id: tr.callId,
          name: toolNameByCallId.get(tr.callId),
        });
      }
    }

    return out;
  }

  /**
   * Provide token count for text or messages
   */
  async provideTokenCount(
    _model: LanguageModelChatInformation,
    text: string | LanguageModelChatMessage,
    _token: CancellationToken,
  ): Promise<number> {
    // Keep a cached encoding instance; do not free it per-call.
    // (Freeing and reusing can cause use-after-free issues.)
    if (!this.tokenizer) {
      this.tokenizer = get_encoding('cl100k_base');
    }

    let textContent = '';

    if (typeof text === 'string') {
      textContent = text;
    } else {
      const parts = Array.isArray(text.content) ? text.content : [text.content];

      // Extract text from message parts including tool calls and results
      textContent = parts
        .map(part => {
          if (part instanceof LanguageModelTextPart) {
            return part.value;
          } else if (part instanceof LanguageModelToolCallPart) {
            // Count tokens for tool calls (name + JSON-serialized input)
            return part.name + JSON.stringify(part.input);
          } else if (part instanceof LanguageModelToolResultPart) {
            // Count tokens for tool results
            return part.content
              .filter(resultPart => resultPart instanceof LanguageModelTextPart)
              .map(resultPart => (resultPart as LanguageModelTextPart).value)
              .join('');
          } else if (typeof part === 'string') {
            return part;
          }
          return '';
        })
        .join('');
    }

    const tokens = this.tokenizer.encode(textContent);
    return tokens.length;
  }

  dispose(): void {
    this._onDidChangeLanguageModelChatInformation.dispose();
    if (this.tokenizer) {
      this.tokenizer.free();
      this.tokenizer = null;
    }
    this.client = null;
    this.apiKeyForDiscovery = undefined;
    this.fetchedModels = null;
    this.modelCacheTimestamp = 0;
  }
}

/**
 * Re-export selected model/role helpers for compatibility with existing tests/imports.
 */
export { formatModelName, getChatModelInfo, toZRole };
export type { ZModel };
