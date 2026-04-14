import { LLMStreamProcessor } from '@selfagency/llm-stream-parser/processor';
import ky from 'ky';
import { get_encoding, Tiktoken } from 'tiktoken';
import {
  CancellationToken,
  Event,
  EventEmitter,
  ExtensionContext,
  LanguageModelChatInformation,
  LanguageModelChatMessage,
  LanguageModelChatMessageRole,
  LanguageModelChatProvider,
  LanguageModelChatToolMode,
  LanguageModelDataPart,
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
import { createZhipu } from 'zhipu-ai-provider';

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

/**
 * Z model configuration
 */
export interface ZModel {
  id: string;
  name: string;
  detail?: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  defaultCompletionTokens: number;
  toolCalling: boolean;
  supportsParallelToolCalls: boolean;
  supportsVision?: boolean;
  temperature?: number;
  top_p?: number;
}

// Default completion tokens for rate limiting optimization
const DEFAULT_COMPLETION_TOKENS = 65536;
const DEFAULT_MAX_OUTPUT_TOKENS = 16384;

/**
 * Prettify a model ID into a display name when the API doesn't provide one.
 * e.g. "z-large-latest" → "Z Large Latest"
 */
export function formatModelName(id: string): string {
  return id
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Get chat model information for VS Code Language Model API
 */
export function getChatModelInfo(model: ZModel): LanguageModelChatInformation {
  return {
    id: model.id,
    name: model.name,
    // Intentionally omit tooltip: VS Code uses it as the picker description in the
    // chat window, overriding the detail field. Without it, detail: 'Z AI' is
    // shown correctly alongside the model in both the chat window and manage models view.
    family: 'z',
    // Short, consistent description shown alongside the model in the chat window
    // and manage models dropdown.
    detail: 'Z AI',
    maxInputTokens: model.maxInputTokens,
    maxOutputTokens: model.maxOutputTokens,
    version: '1.0.0',
    capabilities: {
      toolCalling: model.toolCalling,
      imageInput: model.supportsVision ?? false,
    },
  };
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
  | { role: 'assistant'; content: ZContent | null; toolCalls?: ZToolCall[] }
  | { role: 'tool'; content: string | null; toolCallId: string; name?: string };

/**
 * Z Chat Model Provider
 * Implements VS Code's LanguageModelChatProvider interface for GitHub Copilot Chat
 */
export class ZChatModelProvider implements LanguageModelChatProvider {
  private ai: any | null = null;
  private client: any | null = null;
  private tokenizer: Tiktoken | null = null;
  private fetchedModels: ZModel[] | null = null;
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

  private getConfiguredBaseUrl(): string {
    const defaultBaseByMode: Record<ApiEndpointMode, string> = {
      zaiCoding: 'https://api.z.ai/api/coding/paas/v4',
      zaiGeneral: 'https://api.z.ai/api/paas/v4',
      bigmodel: 'https://open.bigmodel.cn/api/paas/v4',
    };

    try {
      const config = workspace.getConfiguration('zModels');
      const override = (config.get<string>('api.baseUrlOverride', '') || '').trim();
      if (override.length > 0) {
        return override;
      }

      const mode = config.get<ApiEndpointMode>('api.endpointMode', 'zaiCoding');
      return defaultBaseByMode[mode] ?? defaultBaseByMode.zaiCoding;
    } catch {
      // Fallback for tests or environments without workspace configuration support.
      return defaultBaseByMode.zaiCoding;
    }
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

    // Load MCP server configuration from settings
    this.loadMCPConfig();

    this.log.info('[Z] Provider constructed');
    if (autoInit) {
      this.log.info('[Z] Auto-initializing client on activation');
      // Start initialization and remember the promise so incoming queries can await it.
      this.initPromise = this.initClient(true);
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
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let id = '';
    for (let i = 0; i < 9; i++) {
      id += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return id;
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
    if (this.fetchedModels !== null) {
      return this.fetchedModels;
    }

    if (!this.ai && !this.client) {
      return [];
    }

    try {
      let zModels: any[] = [];

      // Compatibility path: tests and advanced users can inject a custom client with models.list().
      if (this.client?.models?.list) {
        const response = await this.client.models.list();
        zModels = Array.isArray(response?.data) ? response.data : [];
      }

      // Fallback curated set when API/model listing is unavailable.
      if (!Array.isArray(zModels) || zModels.length === 0) {
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

      const chatModels = zModels.filter(m => m?.capabilities?.completionChat !== false);

      const rawModels = chatModels.map(m => ({
        id: m.id,
        originalName: m.name ?? formatModelName(m.id),
        detail: m.detail ?? m.description ?? undefined,
        maxInputTokens: m.maxInputTokens ?? m.maxContextLength ?? 32768,
        maxOutputTokens: m.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        defaultCompletionTokens: m.defaultCompletionTokens ?? DEFAULT_COMPLETION_TOKENS,
        toolCalling: m.toolCalling ?? m.capabilities?.functionCalling ?? false,
        supportsParallelToolCalls: m.supportsParallelToolCalls ?? m.capabilities?.functionCalling ?? false,
        supportsVision: m.supportsVision ?? m.capabilities?.vision ?? false,
        temperature: m.temperature ?? m.defaultModelTemperature ?? undefined,
      }));

      // Prefer the 'latest' variant within each model family when available.
      // Determine a base id by stripping a trailing '-latest' or numeric suffix (e.g. '-2512').
      const baseFor = (id: string) => id.replace(/-(?:latest|\d+)$/i, '');

      const groups = new Map<string, (typeof rawModels)[number][]>();
      for (const rm of rawModels) {
        const base = baseFor(rm.id);
        const arr = groups.get(base) ?? [];
        arr.push(rm);
        groups.set(base, arr);
      }

      const modelsToUse: (typeof rawModels)[number][] = [];
      for (const [, arr] of groups) {
        // Prefer an explicit 'latest' id if present
        const latest = arr.find(rm => /latest/i.test(rm.id));
        if (latest) {
          modelsToUse.push(latest);
          continue;
        }
        // Otherwise pick the variant with the largest context size as a sensible default
        let best = arr[0];
        for (const cand of arr) {
          if ((cand.maxInputTokens ?? 0) > (best.maxInputTokens ?? 0)) {
            best = cand;
          }
        }
        modelsToUse.push(best);
      }

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
      // Notify VS Code that models are available
      this._onDidChangeLanguageModelChatInformation.fire(undefined);
      return this.fetchedModels;
    } catch (error) {
      console.error('Failed to fetch Z models:', error);
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
    let apiKey: string | undefined = await this.context.secrets.get('Z_API_KEY');
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
        // Z API keys are typically long alphanumeric strings
        if (value.length < 20) {
          return 'API key appears too short';
        }
        return undefined;
      },
    });

    if (!apiKey) {
      this.log.info('[Z] setApiKey canceled by user');
      return undefined;
    }

    this.log.info('[Z] Storing API key and initializing client');
    try {
      await this.context.secrets.store('Z_API_KEY', apiKey);
      this.log.info('[Z] API key stored successfully');
    } catch (e) {
      this.log.warn('[Z] Failed to store API key in secret storage: ' + String(e));
    }
    // Initialize Zhipu AI client
    this.ai = createZhipu({
      baseURL: this.getConfiguredBaseUrl(),
      apiKey: apiKey,
    });
    this.client = {
      models: {
        list: async () => {
          const data = await ky
            .get(`${this.getConfiguredBaseUrl().replace(/\/$/, '')}/models`, {
              headers: {
                Authorization: `Bearer ${apiKey}`,
              },
              retry: 0,
            })
            .json<any>();
          return { data: Array.isArray((data as any)?.data) ? (data as any).data : [] };
        },
      },
    };
    this.fetchedModels = null;

    return apiKey;
  }

  /**
   * Initialize the Zhipu AI client.
   * @param silent Whether to initialize silently without prompting for API key
   * @returns Whether the initialization was successful
   */
  private async initClient(silent: boolean): Promise<boolean> {
    if (this.ai) {
      return true;
    }

    let apiKey: string | undefined = await this.context.secrets.get('Z_API_KEY');
    this.log.debug('[Z] initClient called (silent=' + silent + ', hasStoredKey=' + !!apiKey + ')');
    if (!silent && !apiKey) {
      apiKey = await this.setApiKey();
    } else if (apiKey) {
      this.ai = createZhipu({
        baseURL: this.getConfiguredBaseUrl(),
        apiKey: apiKey,
      });
      this.client = {
        models: {
          list: async () => {
            const data = await ky
              .get(`${this.getConfiguredBaseUrl().replace(/\/$/, '')}/models`, {
                headers: {
                  Authorization: `Bearer ${apiKey}`,
                },
                retry: 0,
              })
              .json<any>();
            return { data: Array.isArray((data as any)?.data) ? (data as any).data : [] };
          },
        },
      };
    }

    this.log.debug('[Z] initClient result: ' + !!apiKey);
    return !!apiKey;
  }

  /**
   * Provide available chat model information
   */
  async provideLanguageModelChatInformation(
    options: { silent: boolean },
    _token: CancellationToken,
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

    const models = await this.fetchModels();
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
    // Clear tool call ID mappings for this new request
    this.clearToolCallIdMappings();

    // Check if client is initialized
    if (!this.ai && !this.client) {
      progress.report(new LanguageModelTextPart('Please add your Z API key to use Z AI.'));
      return;
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
    const _toolChoice = shouldSendTools
      ? options.toolMode === LanguageModelChatToolMode.Required
        ? 'any'
        : 'auto'
      : undefined;
    const _parallelToolCalls = shouldSendTools ? (foundModel.supportsParallelToolCalls ?? false) : undefined;

    // Allow VS Code modelOptions to override some request parameters.
    const modelOptions = (options.modelOptions ?? {}) as Record<string, unknown>;
    const _temperature =
      typeof modelOptions.temperature === 'number' ? modelOptions.temperature : (foundModel.temperature ?? 0.7);
    const _topP = typeof modelOptions.topP === 'number' ? modelOptions.topP : (foundModel.top_p ?? undefined);
    const _safePrompt = typeof modelOptions.safePrompt === 'boolean' ? modelOptions.safePrompt : undefined;

    try {
      if (this.client?.chat?.stream) {
        const streamResult = await this.client.chat.stream({
          model: model.id,
          messages: _zMessages,
          maxTokens: Math.min(foundModel.defaultCompletionTokens, foundModel.maxOutputTokens),
          tools: zTools,
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

        for await (const chunk of streamResult) {
          const content = chunk?.data?.choices?.[0]?.delta?.content;
          if (typeof content === 'string' && content.length > 0) {
            streamProcessor.process({ content });
          }
        }

        streamProcessor.flush();
        return;
      }

      // Use Zhipu AI provider to generate chat completion
      const result = await this.ai.chat({
        model: model.id,
        messages: _zMessages as any,
        maxTokens: Math.min(foundModel.defaultCompletionTokens, foundModel.maxOutputTokens),
      });

      // Process streaming response
      // Tool call deltas often arrive in multiple chunks. Buffer them until we have valid JSON.
      const _toolCallBuffers = new Map<string, { name?: string; argsText: string }>();
      const _emittedToolCalls = new Set<string>();

      // LLMStreamProcessor handles thinking tag extraction (<think>...</think>) and
      // privacy scrubbing automatically. Text events stream clean content; thinking
      // events are logged to the output channel so they don't pollute the chat UI.
      const streamProcessor = new LLMStreamProcessor({
        parseThinkTags: true,
        scrubContextTags: true,
        enforcePrivacyTags: true,
        onWarning: message => {
          this.log.warn('[Z] stream parser: ' + message);
        },
      });

      streamProcessor.on('thinking', delta => {
        // Avoid logging raw thinking content to prevent leaking sensitive context.
        this.log.debug('[Z] thinking delta length: ' + (delta?.length ?? 0));
      });

      streamProcessor.on('text', delta => {
        if (delta) {
          this.log.debug('[Z] content delta: ' + delta.slice(0, 200));
          progress.report(new LanguageModelTextPart(delta));
        }
      });

      // Process the response from Zhipu AI
      if (result.content) {
        streamProcessor.process({ content: result.content });
      }

      // Flush any remaining text buffered in the stream processor
      streamProcessor.flush();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      this.log.error(
        '[Z] provideLanguageModelChatResponse error: ' +
          (error instanceof Error ? error.stack || error.message : String(error)),
      );
      progress.report(new LanguageModelTextPart(`Error: ${errorMessage}`));
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
          toolResults.push({
            callId: zId,
            content: resultText && resultText.length > 0 ? resultText : JSON.stringify(part.content),
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
            toolCalls: hasToolCalls ? toolCalls : undefined,
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
          toolCallId: tr.callId,
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
      // Extract text from message parts including tool calls and results
      textContent = text.content
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
          }
          return '';
        })
        .join('');
    }

    const tokens = this.tokenizer.encode(textContent);
    return tokens.length;
  }
}

/**
 * Convert VS Code message role to Z role
 */
export function toZRole(role: LanguageModelChatMessageRole): 'user' | 'assistant' {
  switch (role) {
    case LanguageModelChatMessageRole.User:
      return 'user';
    case LanguageModelChatMessageRole.Assistant:
      return 'assistant';
    default:
      return 'user';
  }
}
