import * as vscode from 'vscode';

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
  readonly onDidChangeMcpServerDefinitions = this.emitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {
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

    queueMicrotask(() => this.emitter.fire(undefined));
  }

  async provideMcpServerDefinitions(_token: vscode.CancellationToken): Promise<vscode.McpServerDefinition[]> {
    const config = vscode.workspace.getConfiguration('zModels');
    const servers: vscode.McpServerDefinition[] = [];
    const searchUri = vscode.Uri.parse(MCP_URLS.search);
    const readerUri = vscode.Uri.parse(MCP_URLS.reader);
    const zreadUri = vscode.Uri.parse(MCP_URLS.zread);

    if (config.get<boolean>('mcpServers.search', true)) {
      servers.push(new vscode.McpHttpServerDefinition('zSearch', searchUri, {}, MCP_SERVER_VERSION));
    }
    if (config.get<boolean>('mcpServers.reader', true)) {
      servers.push(new vscode.McpHttpServerDefinition('zReader', readerUri, {}, MCP_SERVER_VERSION));
    }
    if (config.get<boolean>('mcpServers.zread', true)) {
      servers.push(new vscode.McpHttpServerDefinition('zRead', zreadUri, {}, MCP_SERVER_VERSION));
    }
    if (config.get<boolean>('mcpServers.vision', true)) {
      servers.push(
        new vscode.McpStdioServerDefinition(
          'zVision',
          VISION_MCP_COMMAND,
          VISION_MCP_ARGS,
          { Z_AI_MODE: 'ZAI' },
          MCP_SERVER_VERSION,
        ),
      );
    }

    return servers;
  }

  async resolveMcpServerDefinition(
    server: vscode.McpServerDefinition,
    _token: vscode.CancellationToken,
  ): Promise<vscode.McpServerDefinition | undefined> {
    const apiKey = this.context.secrets?.get ? await this.context.secrets.get('Z_API_KEY') : undefined;
    if (!apiKey) {
      return undefined;
    }

    if (server instanceof vscode.McpHttpServerDefinition) {
      server.headers = { ...server.headers, Authorization: `Bearer ${apiKey}` };
      return server;
    }

    if (server instanceof vscode.McpStdioServerDefinition) {
      server.env = { ...server.env, Z_AI_API_KEY: apiKey, Z_AI_MODE: 'ZAI' };
      return server;
    }

    return server;
  }
}
