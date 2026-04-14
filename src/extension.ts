import * as vscode from 'vscode';
import { ZMcpServerDefinitionProvider } from './mcp-server-definition-provider.js';
import { ZChatModelProvider } from './provider.js';
import { UsageService } from './usage-service.js';
import { UsageStatusBar } from './usage-status-bar.js';

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

function toHistoryMessages(chatContext: vscode.ChatContext): vscode.LanguageModelChatMessage[] {
  const messages: vscode.LanguageModelChatMessage[] = [];

  for (const turn of chatContext.history) {
    if (turn instanceof vscode.ChatRequestTurn) {
      messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
      continue;
    }

    if (turn instanceof vscode.ChatResponseTurn) {
      const text = turn.response
        .filter((part): part is vscode.ChatResponseMarkdownPart => part instanceof vscode.ChatResponseMarkdownPart)
        .map(part => part.value.value)
        .join('');

      if (text) {
        messages.push(vscode.LanguageModelChatMessage.Assistant(text));
      }
    }
  }

  return messages;
}

export function activate(context: vscode.ExtensionContext) {
  const logOutputChannel = vscode.window.createOutputChannel('Z Models', { log: true }) as vscode.LogOutputChannel;

  let provider: ZChatModelProvider | undefined;
  const getProvider = (): ZChatModelProvider => {
    if (!provider) {
      const ua = `z-models-vscode/${extVersion} VSCode/${vscode.version}`;
      provider = new ZChatModelProvider(context, logOutputChannel, true, ua);
      activeProvider = provider;
    }
    return provider;
  };

  const updateApiKeyContext = async () => {
    const apiKey = await context.secrets.get('Z_API_KEY');
    await vscode.commands.executeCommand('setContext', 'zModels.hasApiKey', Boolean(apiKey && apiKey.trim().length > 0));
  };

  if (context.secrets?.onDidChange) {
    context.subscriptions.push(
      context.secrets.onDidChange(event => {
        if (event.key === 'Z_API_KEY') {
          void updateApiKeyContext();
        }
      }),
    );
  }
  void updateApiKeyContext();

  // Register the API-key command first so users can recover even if model/MCP APIs fail.
  try {
    context.subscriptions.push(
      vscode.commands.registerCommand('z-chat.manageApiKey', async () => {
        await getProvider().setApiKey();
        await updateApiKeyContext();
      }),
      vscode.commands.registerCommand('z-chat.manageSettings', async () => {
        const config = vscode.workspace.getConfiguration('zModels');
        const current = config.get<'zaiCoding' | 'zaiGeneral' | 'bigmodel'>('api.endpointMode', 'zaiCoding');
        const picked = await vscode.window.showQuickPick(
          [
            { label: 'zaiCoding', detail: 'https://api.z.ai/api/coding/paas/v4' },
            { label: 'zaiGeneral', detail: 'https://api.z.ai/api/paas/v4' },
            { label: 'bigmodel', detail: 'https://open.bigmodel.cn/api/paas/v4' },
          ],
          { placeHolder: `Current endpoint mode: ${current}` },
        );

        if (picked) {
          await config.update('api.endpointMode', picked.label, vscode.ConfigurationTarget.Global);
          await vscode.window.showInformationMessage(`Z.ai endpoint mode set to ${picked.label}.`);
        }
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
      const mcpServerDefinitionProvider = new ZMcpServerDefinitionProvider(context);
      context.subscriptions.push(
        vscode.lm.registerMcpServerDefinitionProvider('zModels.mcpServers', mcpServerDefinitionProvider),
      );
    } else {
      logOutputChannel?.warn('[Z] MCP server definition provider API is unavailable in this VS Code build.');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown MCP registration error';
    logOutputChannel?.warn(`[Z] MCP registration unavailable in this VS Code build: ${message}`);
  }

  if (logOutputChannel) {
    context.subscriptions.push(logOutputChannel);
  }

  // ── Usage tracking status bar ──────────────────────────────────────────
  const usageBar = new UsageStatusBar();
  activeUsageBar = usageBar;
  context.subscriptions.push(usageBar);

  const refreshUsage = async () => {
    const apiKey = await context.secrets.get('Z_API_KEY');
    if (!apiKey || !apiKey.trim()) {
      usageBar.showNoKey();
      return;
    }
    usageBar.showLoading();
    try {
      const svc = activeUsageService ?? new UsageService(apiKey);
      if (!activeUsageService) {
        activeUsageService = svc;
      } else {
        svc.updateApiKey(apiKey);
      }
      const result = await svc.fetchUsage();
      if (result.success && result.data) {
        usageBar.updateUsage(result.data);
        logOutputChannel?.info(`[Z] Usage updated: ${result.data.tokenQuotas.map(q => `${q.windowName}=${q.percentage}%`).join(', ')}`);
      } else {
        usageBar.showError(result.error ?? 'Failed to fetch usage');
        logOutputChannel?.warn(`[Z] Usage fetch failed: ${result.error}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      usageBar.showError(msg);
      logOutputChannel?.error(`[Z] Usage error: ${msg}`);
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('z-chat.refreshUsage', refreshUsage),
    vscode.commands.registerCommand('z-chat.toggleUsageView', async () => {
      usageBar.toggleView();
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
      stream.markdown('For vision tasks, attach an image in chat (for image-input models) or enable the Vision MCP server.');
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
        stream.markdown(
          vscode.l10n.t('The selected model could not process this request right now ({0}).', error.code ?? 'unknown'),
        );
        return;
      }

      const message = error instanceof Error ? error.message : 'Unknown error';
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
