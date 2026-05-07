import * as vscode from 'vscode';
import { ApiKeyManager, type IQuotaDataSource, type UsageQuota, UsageStatusBar } from '@agentsy/vscode';
import { ZMcpServerDefinitionProvider } from './mcp-server-definition-provider.js';
import { ZChatModelProvider } from './provider.js';
import { UsageService } from './usage-service.js';

let activeProvider: ZChatModelProvider | undefined;
let activeUsageService: UsageService | undefined;
let activeUsageBar: UsageStatusBar | undefined;
let usageRefreshTimer: ReturnType<typeof setInterval> | undefined;

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
      vscode.commands.registerCommand('z-chat.manageSettings', async () => {
        await vscode.window.showInformationMessage(
          'Z.ai for Copilot uses the dedicated coding endpoint: https://api.z.ai/api/coding/paas/v4',
        );
      }),
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
            'Z.ai Vision & Search tools require VS Code 1.95 or later. Please update VS Code to enable MCP servers.',
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

  if (logOutputChannel) {
    context.subscriptions.push(logOutputChannel);
  }

  // ── Usage tracking status bar ──────────────────────────────────────────
  let usageViewMode: 'hourly' | 'weekly' = 'hourly';

  const pickHourlyQuota = (quotas: Array<{ unit: number; number: number; percentage: number; nextResetTime?: number }>) => {
    const hourly = quotas.filter(q => q.unit === 3).sort((a, b) => a.number - b.number);
    return hourly.length > 0 ? hourly[0] : quotas[0];
  };

  const pickWeeklyQuota = (quotas: Array<{ unit: number; number: number; percentage: number; nextResetTime?: number }>) => {
    const weekly = quotas.filter(q => q.unit === 6).sort((a, b) => a.number - b.number);
    return weekly.length > 0 ? weekly[0] : pickHourlyQuota(quotas);
  };

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

      const selected = usageViewMode === 'hourly'
        ? pickHourlyQuota(result.data.tokenQuotas)
        : pickWeeklyQuota(result.data.tokenQuotas);

      return {
        used: selected.percentage,
        total: 100,
        unit: 'tokens',
        window: mapWindow(selected.unit),
        percentUsed: Math.max(0, Math.min(1, selected.percentage / 100)),
        expiresAt: selected.nextResetTime ? new Date(selected.nextResetTime) : undefined,
      };
    },

    async refreshQuota(): Promise<UsageQuota> {
      return this.getQuota();
    },
  };

  const usageBar = new UsageStatusBar({
    displayName: 'Z.ai Usage',
    warningThreshold: 0.8,
    errorThreshold: 0.95,
    refreshIntervalMs: 60_000,
    quotaDataSource,
  });
  activeUsageBar = usageBar;
  context.subscriptions.push(usageBar);
  void usageBar.show();

  const refreshUsage = async () => {
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
      await usageBar.show();
      const quota = await usageBar.refresh();
      if (quota) {
        logOutputChannel?.info(`[Z] Usage updated: ${Math.round(quota.percentUsed * 100)}% (${quota.window})`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      logOutputChannel?.error(`[Z] Usage error: ${msg}`);
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('z-chat.refreshUsage', refreshUsage),
    vscode.commands.registerCommand('z-chat.toggleUsageView', async () => {
      usageViewMode = usageViewMode === 'hourly' ? 'weekly' : 'hourly';
      await refreshUsage();
    }),
  );

  // Initial fetch + periodic refresh
  void refreshUsage();
  const setupRefreshTimer = () => {
    if (usageRefreshTimer) clearInterval(usageRefreshTimer);
    const interval = vscode.workspace.getConfiguration('zModels').get<number>('usage.refreshInterval', 5);
    usageRefreshTimer = setInterval(() => void refreshUsage(), interval * 60_000);
  };
  setupRefreshTimer();

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

  // Adjust refresh interval when settings change
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('zModels.usage.refreshInterval')) {
        setupRefreshTimer();
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
}

export function deactivate() {
  if (usageRefreshTimer) {
    clearInterval(usageRefreshTimer);
    usageRefreshTimer = undefined;
  }
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
