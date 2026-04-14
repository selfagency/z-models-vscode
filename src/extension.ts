import * as vscode from 'vscode';
import { ZMcpServerDefinitionProvider } from './mcp-server-definition-provider.js';
import { ZChatModelProvider } from './provider.js';

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
  let logOutputChannel: vscode.LogOutputChannel | undefined;
  try {
    logOutputChannel =
      typeof vscode.window.createOutputChannel === 'function'
        ? (vscode.window.createOutputChannel('Z Models', { log: true }) as vscode.LogOutputChannel)
        : undefined;
  } catch {
    // Older VS Code builds may not support the options object overload.
    logOutputChannel = undefined;
  }

  let provider: ZChatModelProvider | undefined;
  const getProvider = (): ZChatModelProvider => {
    if (!provider) {
      provider = new ZChatModelProvider(context, logOutputChannel, true);
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
      const response = await request.model.sendRequest(messages, {}, token);
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

export function deactivate() {}
