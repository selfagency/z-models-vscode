import * as vscode from 'vscode';
import {
  createMcpServerDefinitionProvider,
  McpServerRegistry,
  type ApiKeyManager,
  type McpServerProvider,
} from '@agentsy/vscode';

const MCP_URLS = {
  search: 'https://api.z.ai/api/mcp/web_search_prime/mcp',
  reader: 'https://api.z.ai/api/mcp/web_reader/mcp',
  zread: 'https://api.z.ai/api/mcp/zread/mcp',
} as const;

const MCP_SERVER_VERSION = '1.0.0';
const VISION_MCP_COMMAND = 'npx';
const VISION_MCP_ARGS = ['-y', '@z_ai/mcp-server@latest'];

/**
 * Registers Z.AI managed MCP servers as HTTP MCP definitions.
 *
 * The API key is read from VS Code secrets and attached as a Bearer auth header.
 */
export class ZMcpServerDefinitionProvider implements vscode.McpServerDefinitionProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly mcpProvider: McpServerProvider;
  private readonly mcpRegistry: McpServerRegistry;
  readonly onDidChangeMcpServerDefinitions = this.emitter.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly apiKeyManager?: Pick<ApiKeyManager, 'getApiKey'>,
  ) {
    this.mcpProvider = createMcpServerDefinitionProvider({
      servers: [
        {
          name: 'zSearch',
          command: MCP_URLS.search,
          enabledSettingKey: 'mcpServers.search',
          apiKeyHeader: 'Authorization',
        },
        {
          name: 'zReader',
          command: MCP_URLS.reader,
          enabledSettingKey: 'mcpServers.reader',
          apiKeyHeader: 'Authorization',
        },
        {
          name: 'zRead',
          command: MCP_URLS.zread,
          enabledSettingKey: 'mcpServers.zread',
          apiKeyHeader: 'Authorization',
        },
        {
          name: 'zVision',
          command: VISION_MCP_COMMAND,
          args: VISION_MCP_ARGS,
          env: { Z_AI_MODE: 'ZAI' },
          enabledSettingKey: 'mcpServers.vision',
          apiKeyEnvVar: 'Z_AI_API_KEY',
        },
      ],
      settings: {
        get: <T>(key: string, fallback?: T): T | undefined => {
          return vscode.workspace.getConfiguration('zModels').get<T>(key, fallback as T);
        },
      },
      getApiKey: async () => {
        const managerKey = this.apiKeyManager ? await this.apiKeyManager.getApiKey() : undefined;
        const secretKey = this.context.secrets?.get ? await this.context.secrets.get('Z_API_KEY') : undefined;
        return managerKey ?? secretKey;
      },
      defaultEnabled: true,
      defaultApiKeyHeader: 'Authorization',
      formatApiKeyHeaderValue: (apiKey: string) => `Bearer ${apiKey}`,
    });

    this.mcpRegistry = new McpServerRegistry({
      namespace: 'zModels.mcpServers',
      providers: [this.mcpProvider],
      autoRegister: false,
    });

    const disposables: vscode.Disposable[] = [this.emitter];

    if (vscode.workspace?.onDidChangeConfiguration) {
      disposables.push(
        vscode.workspace.onDidChangeConfiguration(event => {
          if (event.affectsConfiguration('zModels.mcpServers')) {
            this.emitter.fire(undefined);
          }
        }),
      );
    }

    if (this.context.secrets?.onDidChange) {
      disposables.push(
        this.context.secrets.onDidChange(event => {
          if (event.key === 'Z_API_KEY') {
            this.emitter.fire(undefined);
          }
        }),
      );
    }

    this.context.subscriptions.push(...disposables);
    this.context.subscriptions.push(this.mcpRegistry);

    queueMicrotask(() => this.emitter.fire(undefined));
  }

  async provideMcpServerDefinitions(_token: vscode.CancellationToken): Promise<vscode.McpServerDefinition[]> {
    await this.mcpRegistry.loadFromProviders();

    return this.mcpRegistry.getAll().map(server => {
      if (server.command.startsWith('http://') || server.command.startsWith('https://')) {
        return new vscode.McpHttpServerDefinition(
          server.name,
          vscode.Uri.parse(server.command),
          server.headers ?? {},
          MCP_SERVER_VERSION,
        );
      }

      return new vscode.McpStdioServerDefinition(
        server.name,
        server.command,
        server.args ?? [],
        server.env ?? {},
        MCP_SERVER_VERSION,
      );
    });
  }

  async resolveMcpServerDefinition(
    server: vscode.McpServerDefinition,
    _token: vscode.CancellationToken,
  ): Promise<vscode.McpServerDefinition | undefined> {
    const managerKey = this.apiKeyManager ? await this.apiKeyManager.getApiKey() : undefined;
    const apiKey = managerKey ?? (this.context.secrets?.get ? await this.context.secrets.get('Z_API_KEY') : undefined);
    if (!apiKey) {
      return undefined;
    }

    if (server instanceof vscode.McpHttpServerDefinition) {
      server.headers = {
        ...server.headers,
        Authorization: `Bearer ${apiKey}`,
        'Accept-Language': 'en-US,en',
      };
      return server;
    }

    if (server instanceof vscode.McpStdioServerDefinition) {
      server.env = { ...server.env, Z_AI_API_KEY: apiKey, Z_AI_MODE: 'ZAI' };
      return server;
    }

    return server;
  }
}
