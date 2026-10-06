import * as vscode from 'vscode';
import { ApiKeyManager } from './agentsy-native.js';
import { type IQuotaDataSource, type UsageQuota, UsageStatusBar } from './usage-status-bar.js';
import { ZMcpServerDefinitionProvider } from './mcp-server-definition-provider.js';
import { ZChatModelProvider } from './provider.js';
import { ZWebFetchTool, ZWebSearchTool } from './tools/web-tools.js';
import { showSettingsUI } from './settings-ui.js';
import { type TokenQuota, UsageService } from './usage-service.js';

let activeProvider: ZChatModelProvider | undefined;
let activeUsageService: UsageService | undefined;
let activeUsageBar: UsageStatusBar | undefined;

/** Status bar refresh cadence in ms, from `zModels.usage.refreshInterval` (minutes). */
function getUsageRefreshMs(): number {
  const minutes = vscode.workspace.getConfiguration('zModels').get<number>('usage.refreshInterval', 5);
  return Math.max(1, minutes) * 60_000;
}

/** Whether the usage status bar is enabled by settings. */
function usageEnabled(): boolean {
  return vscode.workspace.getConfiguration('zModels').get<boolean>('usage.enabled', true) !== false;
}

// Read extension version for User-Agent at module level
let extVersion = 'unknown';
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  extVersion = require('../package.json').version ?? 'unknown';
} catch {
  // In test environments, package.json may not be resolvable
}

function extractResponseText(parts: readonly (vscode.ChatResponseMarkdownPart | unknown)[]): string {
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((part): part is vscode.ChatResponseMarkdownPart => part instanceof vscode.ChatResponseMarkdownPart)
    .map(part => part.value.value)
    .join('');
}

function toHistoryMessages(chatContext: vscode.ChatContext): vscode.LanguageModelChatMessage[] {
  const messages: vscode.LanguageModelChatMessage[] = [];

  for (const turn of chatContext.history) {
    if (turn instanceof vscode.ChatRequestTurn) {
      messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
      continue;
    }

    // VS Code < 1.96
    if (turn instanceof vscode.ChatResponseTurn) {
      const text = extractResponseText(turn.response);
      if (text) {
        messages.push(vscode.LanguageModelChatMessage.Assistant(text));
      }
      continue;
    }

    // VS Code >= 1.96: ChatResponseTurn2 has 'content' property
    if ('content' in turn) {
      const turnWithContent = turn as { content: readonly (vscode.ChatResponseMarkdownPart | unknown)[] };
      if (Array.isArray(turnWithContent.content)) {
        const text = extractResponseText(turnWithContent.content);
        if (text) {
          messages.push(vscode.LanguageModelChatMessage.Assistant(text));
        }
      }
    }
  }

  return messages;
}

export function activate(context: vscode.ExtensionContext) {
  const logOutputChannel = vscode.window.createOutputChannel('Z Models', { log: true }) as vscode.LogOutputChannel;

  if (context.secrets?.onDidChange) {
    context.subscriptions.push(
      context.secrets.onDidChange(event => {
        if (event.key === 'Z_API_KEY') {
          void context.secrets.get('Z_API_KEY').then(apiKey => {
            void vscode.commands.executeCommand(
              'setContext',
              'zModels.hasApiKey',
              Boolean(apiKey && apiKey.trim().length > 0),
            );
          });
        }
      }),
    );
  }

  const apiKeyManager = new ApiKeyManager(context, {
    secretKey: 'Z_API_KEY',
    contextKey: 'zModels.hasApiKey',
    displayName: 'Z.ai API Key',
    promptMessage: 'Enter your Z.ai API key',
  });
  void apiKeyManager.initialize?.();
  context.subscriptions.push(apiKeyManager);

  const getApiKey = async (): Promise<string | undefined> => {
    try {
      const keyFromManager = (await apiKeyManager.getApiKey())?.trim();
      if (keyFromManager) {
        return keyFromManager;
      }
    } catch {
      // fall back to legacy secret lookup in tests or older hosts
    }
    const keyFromSecrets = (await context.secrets.get('Z_API_KEY'))?.trim();
    return keyFromSecrets && keyFromSecrets.length > 0 ? keyFromSecrets : undefined;
  };

  let provider: ZChatModelProvider | undefined;
  const getProvider = (): ZChatModelProvider => {
    if (!provider) {
      const ua = `z-models-vscode/${extVersion} VSCode/${vscode.version}`;
      provider = new ZChatModelProvider(context, logOutputChannel, true, ua, apiKeyManager);
      activeProvider = provider;
    }
    return provider;
  };

  const clearApiKey = async (): Promise<void> => {
    await getProvider().clearApiKey();
    await updateApiKeyContext();
  };

  const updateApiKeyContext = async () => {
    const apiKey = await getApiKey();
    await vscode.commands.executeCommand(
      'setContext',
      'zModels.hasApiKey',
      Boolean(apiKey && apiKey.trim().length > 0),
    );
  };

  void updateApiKeyContext();

  // Register the API-key command first so users can recover even if model/MCP APIs fail.
  try {
    context.subscriptions.push(
      vscode.commands.registerCommand('z-chat.manageApiKey', async () => {
        await getProvider().setApiKey();
        await updateApiKeyContext();
      }),
      vscode.commands.registerCommand('z-chat.manageSettings', () =>
        showSettingsUI({ context, log: logOutputChannel, getApiKey, clearApiKey }),
      ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown command registration error';
    logOutputChannel?.error(`[Z] Failed to register manageApiKey command: ${message}`);
  }

  // Register language model provider (guarded to avoid breaking command registration).
  try {
    if (vscode.lm?.registerLanguageModelChatProvider) {
      context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider('z', getProvider()));
    } else {
      logOutputChannel?.warn('[Z] Language model chat provider API is unavailable in this VS Code build.');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown model provider registration error';
    logOutputChannel?.error(`[Z] Failed to register language model provider: ${message}`);
  }

  // Register MCP provider independently (guarded).
  try {
    if (vscode.lm?.registerMcpServerDefinitionProvider) {
      const mcpServerDefinitionProvider = new ZMcpServerDefinitionProvider(context, apiKeyManager);
      context.subscriptions.push(
        vscode.lm.registerMcpServerDefinitionProvider('zModels.mcpServers', mcpServerDefinitionProvider),
      );
    } else {
      logOutputChannel?.warn('[Z] MCP server definition provider API is unavailable in this VS Code build.');

      // Show user-facing warning on first run without MCP support (fire-and-forget)
      const shownMcpWarning = context.globalState.get<boolean>('z-mcp-warning-shown');
      if (!shownMcpWarning) {
        vscode.window
          .showWarningMessage(
            'Z.ai Vision & Search tools require VS Code 1.120 or later. Please update VS Code to enable MCP servers.',
            'Update VS Code',
            'Dismiss',
          )
          .then(() => {
            context.globalState.update('z-mcp-warning-shown', true);
          });
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown MCP registration error';
    logOutputChannel?.warn(`[Z] MCP registration unavailable in this VS Code build: ${message}`);
  }

  // Register first-party language model tools (guarded).
  try {
    if (vscode.lm?.registerTool) {
      const toolsConfig = vscode.workspace.getConfiguration('zModels').get<{ webSearch?: boolean; webFetch?: boolean }>('tools', {});
      if (toolsConfig.webSearch !== false) {
        context.subscriptions.push(vscode.lm.registerTool('z_webSearch', new ZWebSearchTool({ context, apiKeyManager })));
      }
      if (toolsConfig.webFetch !== false) {
        context.subscriptions.push(vscode.lm.registerTool('z_webFetch', new ZWebFetchTool()));
      }
    } else {
      logOutputChannel?.warn('[Z] Language model tool API is unavailable in this VS Code build.');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown tool registration error';
    logOutputChannel?.warn(`[Z] Failed to register language model tools: ${message}`);
  }

  if (logOutputChannel) {
    context.subscriptions.push(logOutputChannel);
  }

  // ── Usage tracking status bar ──────────────────────────────────────────
  let usageViewMode: 'hourly' | 'weekly' = 'hourly';

  /**
   * Select the quota window for the active view. Z.ai reports the 5-hour window
   * as unit=3/number=5 and the weekly window as unit=6/number=1, so unit alone
   * is the reliable discriminator here (the Z.ai quota API returns one TOKENS_LIMIT
   * row per window).
   */
  const pickHourlyQuota = (quotas: TokenQuota[]): TokenQuota | undefined =>
    quotas.find(q => q.unit === 3) ?? quotas[0];

  const pickWeeklyQuota = (quotas: TokenQuota[]): TokenQuota | undefined =>
    quotas.find(q => q.unit === 6) ?? pickHourlyQuota(quotas);

  const mapWindow = (unit: number): UsageQuota['window'] => {
    if (unit === 3) return 'hourly';
    if (unit === 6) return 'weekly';
    if (unit === 5) return 'monthly';
    return 'daily';
  };

  const quotaDataSource: IQuotaDataSource = {
    async getQuota(): Promise<UsageQuota> {
      if (!activeUsageService) {
        throw new Error('Usage service not initialized');
      }
      const result = await activeUsageService.fetchUsage();
      if (!result.success || !result.data || result.data.tokenQuotas.length === 0) {
        throw new Error(result.error ?? 'No usage quota available');
      }

      const selected =
        usageViewMode === 'hourly'
          ? pickHourlyQuota(result.data.tokenQuotas)
          : pickWeeklyQuota(result.data.tokenQuotas);

      if (!selected) {
        throw new Error('No usage quota available');
      }

      return {
        used: selected.percentage,
        total: 100,
        unit: 'tokens',
        window: mapWindow(selected.unit),
        windowLabel: selected.windowName,
        planLevel: result.data.planLevel,
        percentUsed: Math.max(0, Math.min(1, selected.percentage / 100)),
        expiresAt: selected.nextResetTime ? new Date(selected.nextResetTime) : undefined,
      };
    },

    async refreshQuota(): Promise<UsageQuota> {
      return this.getQuota();
    },
  };

  const usageBar = new UsageStatusBar({
    displayName: 'Z.ai',
    warningThreshold: 0.8,
    errorThreshold: 0.95,
    // The status bar owns the only refresh timer; the setting feeds its cadence
    // rather than adding a second competing interval.
    refreshIntervalMs: getUsageRefreshMs(),
    clickCommand: 'z-chat.toggleUsageView',
    quotaDataSource,
  });
  activeUsageBar = usageBar;
  context.subscriptions.push(usageBar);

  const refreshUsage = async () => {
    if (!usageEnabled()) {
      usageBar.hide();
      return;
    }
    const apiKey = await getApiKey();
    if (!apiKey || !apiKey.trim()) {
      usageBar.hide();
      return;
    }
    try {
      const svc = activeUsageService ?? new UsageService(apiKey);
      if (!activeUsageService) {
        activeUsageService = svc;
      } else {
        svc.updateApiKey(apiKey);
      }
      // show() already refreshes; do not issue a second quota fetch here.
      const quota = await usageBar.show();
      if (quota) {
        logOutputChannel?.info(`[Z] Usage updated: ${Math.round(quota.percentUsed * 100)}% (${quota.windowLabel ?? quota.window})`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      logOutputChannel?.error(`[Z] Usage error: ${msg}`);
    }
  };

  const toggleUsageView = async () => {
    usageViewMode = usageViewMode === 'hourly' ? 'weekly' : 'hourly';
    logOutputChannel?.info(`[Z] Usage view switched to ${usageViewMode}`);
    await refreshUsage();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('z-chat.refreshUsage', refreshUsage),
    vscode.commands.registerCommand('z-chat.toggleUsageView', toggleUsageView),
    vscode.commands.registerCommand('z-chat.resetUsageView', async () => {
      usageViewMode = 'hourly';
      usageBar.hide();
      await refreshUsage();
      logOutputChannel?.info('[Z] Usage display reset');
    }),
  );

  // Initial fetch. Ongoing refresh is owned by UsageStatusBar's single timer.
  void refreshUsage();

  // Refresh when API key changes
  if (context.secrets?.onDidChange) {
    context.subscriptions.push(
      context.secrets.onDidChange(event => {
        if (event.key === 'Z_API_KEY') void refreshUsage();
      }),
    );
  }

  if (typeof apiKeyManager.onDidChangeApiKey === 'function') {
    apiKeyManager.onDidChangeApiKey(() => {
      void updateApiKeyContext();
      void refreshUsage();
    });
  }

  // Adjust refresh cadence / visibility when settings change
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('zModels.usage.refreshInterval')) {
        usageBar.setRefreshInterval(getUsageRefreshMs());
      }
      if (
        event.affectsConfiguration('zModels.usage.enabled') ||
        event.affectsConfiguration('zModels.usage.refreshInterval')
      ) {
        void refreshUsage();
      }
    }),
  );

  const participantHandler: vscode.ChatRequestHandler = async (
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
  ): Promise<void> => {
    const commandName = (request as any).command as string | undefined;
    if (commandName === 'clear') {
      stream.markdown('History reset is managed by VS Code threads. Start a new chat thread to clear context.');
      return;
    }

    if (commandName === 'model') {
      stream.markdown('Use the model picker in Copilot Chat to select any available Z.ai model.');
      return;
    }

    if (commandName === 'vision') {
      stream.markdown(
        'For vision tasks, attach an image in chat (for image-input models) or enable the Vision MCP server.',
      );
      return;
    }

    const messages = toHistoryMessages(chatContext);

    messages.push(vscode.LanguageModelChatMessage.User(request.prompt));

    try {
      const response = await request.model.sendRequest(messages, undefined, token);
      for await (const chunk of response.stream) {
        if (chunk instanceof vscode.LanguageModelTextPart) {
          stream.markdown(chunk.value);
        } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
          const args = JSON.stringify(chunk.input ?? {});
          stream.markdown(`\n\nCalling tool \`${chunk.name}\` with ${args}`);
        } else if (chunk instanceof vscode.LanguageModelToolResultPart) {
          const text = chunk.content
            .filter((part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart)
            .map(part => part.value)
            .join('');
          if (text) {
            stream.markdown(text);
          }
        }
      }
    } catch (error) {
      if (error instanceof vscode.LanguageModelError) {
        // LanguageModelError has a user-friendly message already set by the provider
        const message = error.message || `Request failed (${error.code || 'unknown'})`;
        stream.markdown(vscode.l10n.t('The selected model could not process this request: {0}', message));
        return;
      }

      const message = error instanceof Error ? error.message : 'Unknown error occurred';
      stream.markdown(vscode.l10n.t('Error: {0}', message));
    }
  };

  const participant = vscode.chat.createChatParticipant('z-models-vscode.z', participantHandler);
  participant.iconPath = vscode.Uri.parse(`${context.extensionUri.toString().replace(/\/$/, '')}/logo.png`);
  participant.followupProvider = {
    provideFollowups: async () => [
      { prompt: '/model Show available Z.ai models', label: 'Switch model' },
      { prompt: '/vision Describe an attached image', label: 'Use vision' },
      { prompt: '/clear Start a clean thread', label: 'Clear context' },
    ],
  };
  context.subscriptions.push(participant);

  // Integration-test handles, gated on ExtensionMode.Test so nothing is added to
  // the production command surface: there is no `__test*` command in a normal
  // install. The streaming e2e test needs the real registered provider, not a
  // reconstruction, because the bug it guards (text buffered until the response
  // completed) only appears when the whole chain runs: HTTP -> SSE -> provider
  // -> VS Code progress surface.
  if (context.extensionMode === vscode.ExtensionMode.Test) {
    context.subscriptions.push(
      vscode.commands.registerCommand('z-models-vscode.__testProvider', () => getProvider()),
      vscode.commands.registerCommand('z-models-vscode.__testSeedApiKey', async (key: string) => {
        // Through the manager, not context.secrets.store directly, because the
        // manager caches the key in memory and that cache is exactly what a
        // broken clear path leaves behind. Storing the secret directly would
        // never populate it and the test would not be testing the real flow.
        await apiKeyManager.setApiKey(key);
        await getProvider().reinitializeClient();
      }),
      vscode.commands.registerCommand('z-models-vscode.__testClearApiKey', () =>
        getProvider().clearApiKey(),
      ),
    );
  }
}

export function deactivate() {
  if (activeUsageBar) {
    activeUsageBar.dispose();
    activeUsageBar = undefined;
  }
  activeUsageService = undefined;
  if (activeProvider && typeof (activeProvider as any).dispose === 'function') {
    activeProvider.dispose();
  }
  activeProvider = undefined;
}
