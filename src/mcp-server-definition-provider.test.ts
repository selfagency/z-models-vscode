import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EventEmitter,
  McpHttpServerDefinition,
  McpStdioServerDefinition,
  Uri,
  workspace,
} from 'vscode';
import { ZMcpServerDefinitionProvider } from './mcp-server-definition-provider.js';

const mockContext = {
  secrets: {
    get: vi.fn().mockResolvedValue(undefined),
    onDidChange: vi.fn((listener: (event: { key: string }) => void) => {
      const emitter = new EventEmitter<{ key: string }>();
      return emitter.event(listener);
    }),
  },
  subscriptions: [] as any[],
} as any;

describe('ZMcpServerDefinitionProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockContext.subscriptions = [];
    vi.spyOn(workspace, 'getConfiguration').mockReturnValue({
      get: vi.fn((_key: string, defaultValue: unknown) => defaultValue),
    } as any);
  });

  it('provides HTTP search/reader/zread servers and local stdio vision server without requiring an API key up front', async () => {
    const provider = new ZMcpServerDefinitionProvider(mockContext);

    const servers = await provider.provideMcpServerDefinitions({} as any);

    expect(servers).toHaveLength(4);
    expect(servers[0]).toBeInstanceOf(McpHttpServerDefinition);
    expect(servers[1]).toBeInstanceOf(McpHttpServerDefinition);
    expect(servers[2]).toBeInstanceOf(McpHttpServerDefinition);
    expect(servers[3]).toBeInstanceOf(McpStdioServerDefinition);

    const vision = servers[3] as McpStdioServerDefinition;
    expect(vision.label).toBe('zVision');
    expect(vision.command).toBe('npx');
    expect(vision.args).toEqual(['-y', '@z_ai/mcp-server@latest']);
    expect(vision.env).toEqual({ Z_AI_MODE: 'ZAI' });
  });

  it('resolves HTTP server definitions by injecting Authorization header from secret storage', async () => {
    vi.spyOn(mockContext.secrets, 'get').mockResolvedValue('secret-key');
    const provider = new ZMcpServerDefinitionProvider(mockContext);
    const server = new McpHttpServerDefinition('zSearch', Uri.parse('https://example.com/mcp'), {}, '1.0.0');

    const resolved = await provider.resolveMcpServerDefinition(server as any, {} as any);

    expect(resolved).toBe(server);
    expect((resolved as McpHttpServerDefinition).headers.Authorization).toBe('Bearer secret-key');
  });

  it('resolves stdio vision server definitions by injecting required env vars from secret storage', async () => {
    vi.spyOn(mockContext.secrets, 'get').mockResolvedValue('secret-key');
    const provider = new ZMcpServerDefinitionProvider(mockContext);
    const server = new McpStdioServerDefinition('zVision', 'npx', ['-y', '@z_ai/mcp-server@latest'], {}, '1.0.0');

    const resolved = await provider.resolveMcpServerDefinition(server as any, {} as any);

    expect(resolved).toBe(server);
    expect((resolved as McpStdioServerDefinition).env).toMatchObject({
      Z_AI_API_KEY: 'secret-key',
      Z_AI_MODE: 'ZAI',
    });
  });

  it('returns undefined from resolve when no API key is available', async () => {
    vi.spyOn(mockContext.secrets, 'get').mockResolvedValue(undefined);
    const provider = new ZMcpServerDefinitionProvider(mockContext);
    const server = new McpHttpServerDefinition('zSearch', Uri.parse('https://example.com/mcp'), {}, '1.0.0');

    const resolved = await provider.resolveMcpServerDefinition(server as any, {} as any);
    expect(resolved).toBeUndefined();
  });
});
