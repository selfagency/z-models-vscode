import * as vscode from 'vscode';

const MCP_URLS = {
  vision: 'https://api.z.ai/api/mcp/vision/mcp',
  search: 'https://api.z.ai/api/mcp/web_search_prime/mcp',
  reader: 'https://api.z.ai/api/mcp/web_reader/mcp',
  zread: 'https://api.z.ai/api/mcp/zread/mcp',
} as const;

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
  }

  async provideMcpServerDefinitions(_token: vscode.CancellationToken): Promise<vscode.McpServerDefinition[]> {
    const apiKey = this.context.secrets?.get ? await this.context.secrets.get('Z_API_KEY') : undefined;
    if (!apiKey) {
      return [];
    }

    const config = vscode.workspace.getConfiguration('zModels');
    const headers = { Authorization: `Bearer ${apiKey}` };
    const servers: vscode.McpServerDefinition[] = [];
    const visionUri = vscode.Uri.parse(MCP_URLS.vision);
    const searchUri = vscode.Uri.parse(MCP_URLS.search);
    const readerUri = vscode.Uri.parse(MCP_URLS.reader);
    const zreadUri = vscode.Uri.parse(MCP_URLS.zread);

    if (config.get<boolean>('mcpServers.search', true)) {
      servers.push(new vscode.McpHttpServerDefinition('zSearch', searchUri, headers));
    }
    if (config.get<boolean>('mcpServers.reader', true)) {
      servers.push(new vscode.McpHttpServerDefinition('zReader', readerUri, headers));
    }
    if (config.get<boolean>('mcpServers.zread', true)) {
      servers.push(new vscode.McpHttpServerDefinition('zRead', zreadUri, headers));
    }
    if (config.get<boolean>('mcpServers.vision', true)) {
      servers.push(new vscode.McpHttpServerDefinition('zVision', visionUri, headers));
    }

    return servers;
  }

  async resolveMcpServerDefinition(
    server: vscode.McpServerDefinition,
    _token: vscode.CancellationToken,
  ): Promise<vscode.McpServerDefinition> {
    return server;
  }
}
