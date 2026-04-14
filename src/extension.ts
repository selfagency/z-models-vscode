import * as vscode from 'vscode';
import { ZMcpServerDefinitionProvider } from './mcp-server-definition-provider.js';
import { ZChatModelProvider } from './provider.js';

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
      provider = new ZChatModelProvider(context, logOutputChannel as any, true);
    }
    return provider;
  };

  // Register the API-key command first so users can recover even if model/MCP APIs fail.
  try {
    context.subscriptions.push(
      vscode.commands.registerCommand('z-chat.manageApiKey', async () => {
        await getProvider().setApiKey();
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
    const messages: vscode.LanguageModelChatMessage[] = [];

    for (const turn of chatContext.history) {
      if (turn instanceof vscode.ChatRequestTurn) {
        messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
      } else if (turn instanceof vscode.ChatResponseTurn) {
        const text = turn.response
          .filter((r): r is vscode.ChatResponseMarkdownPart => r instanceof vscode.ChatResponseMarkdownPart)
          .map(r => r.value.value)
          .join('');
        if (text) {
          messages.push(vscode.LanguageModelChatMessage.Assistant(text));
        }
      }
    }

    messages.push(vscode.LanguageModelChatMessage.User(request.prompt));

    try {
      const response = await request.model.sendRequest(messages, {}, token);
      for await (const chunk of response.stream) {
        if (chunk instanceof vscode.LanguageModelTextPart) {
          stream.markdown(chunk.value);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      stream.markdown(`Error: ${message}`);
    }
  };

  const participant = vscode.chat.createChatParticipant('z-models-vscode.z', participantHandler);
  participant.iconPath = (vscode.Uri as any).joinPath(context.extensionUri, 'logo.png');
  context.subscriptions.push(participant);
}

export function deactivate() {}
