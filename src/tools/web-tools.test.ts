import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguageModelTextPart, LanguageModelToolResult } from 'vscode';
import { resolveApiKey, ZWebFetchTool, ZWebSearchTool } from './web-tools.js';
vi.mock('got', () => ({
  default: {
    post: vi.fn(),
    get: vi.fn(),
  },
}));

const mockContext = {
  secrets: {
    get: vi.fn().mockResolvedValue(undefined),
  },
} as any;

const mockToken = { isCancellationRequested: false } as any;

function textOf(result: LanguageModelToolResult): string {
  return result.content
    .filter((part): part is LanguageModelTextPart => part instanceof LanguageModelTextPart)
    .map(part => part.value)
    .join('');
}

describe('resolveApiKey', () => {
  it('prefers the ApiKeyManager over secrets and env', async () => {
    const manager = { getApiKey: vi.fn().mockResolvedValue('manager-key') };
    expect(await resolveApiKey(mockContext, manager)).toBe('manager-key');
  });

  it('falls back to secrets when the manager has no key', async () => {
    const manager = { getApiKey: vi.fn().mockResolvedValue(undefined) };
    mockContext.secrets.get.mockResolvedValue('secret-key');
    expect(await resolveApiKey(mockContext, manager)).toBe('secret-key');
  });

  it('falls back to env vars when secrets are empty', async () => {
    mockContext.secrets.get.mockResolvedValue(undefined);
    const old = process.env.Z_API_KEY;
    process.env.Z_API_KEY = 'env-key';
    try {
      expect(await resolveApiKey(mockContext)).toBe('env-key');
    } finally {
      if (old === undefined) delete process.env.Z_API_KEY;
      else process.env.Z_API_KEY = old;
    }
  });
});

describe('ZWebSearchTool', () => {
  let tool: ZWebSearchTool;
  let gotPost: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockContext.secrets.get.mockResolvedValue('test-key');
    tool = new ZWebSearchTool({ context: mockContext });
    const { default: got } = await import('got');
    gotPost = got.post as any;
  });

  it('returns a LanguageModelToolResult containing the search text', async () => {
    gotPost.mockReturnValue({
      json: vi.fn().mockResolvedValue({
        search_results: [
          { title: 'Result One', link: 'https://example.com/1', content: 'First snippet', publish_date: '2026-01-01' },
          { title: 'Result Two', link: 'https://example.com/2', content: 'Second snippet' },
        ],
      }),
    });

    const result = await tool.invoke({ input: { query: 'glm models' }, toolInvocationToken: undefined }, mockToken);
    expect(result).toBeInstanceOf(LanguageModelToolResult);
    const text = textOf(result);
    expect(text).toContain('Result One');
    expect(text).toContain('https://example.com/1');
    expect(text).toContain('First snippet');
    expect(text).toContain('Result Two');
  });

  it('posts to the web_search endpoint with the query', async () => {
    gotPost.mockReturnValue({ json: vi.fn().mockResolvedValue({ search_results: [] }) });
    await tool.invoke({ input: { query: 'hello', count: 3 }, toolInvocationToken: undefined }, mockToken);
    expect(gotPost).toHaveBeenCalledWith(
      expect.stringContaining('/web_search'),
      expect.objectContaining({
        json: expect.objectContaining({ search_query: 'hello', count: 3 }),
      }),
    );
  });

  it('returns a sensible message for empty results', async () => {
    gotPost.mockReturnValue({ json: vi.fn().mockResolvedValue({ search_results: [] }) });
    const result = await tool.invoke({ input: { query: 'nothing' }, toolInvocationToken: undefined }, mockToken);
    expect(textOf(result)).toContain('No search results found');
  });

  it('returns a friendly message on 401 without throwing the raw error', async () => {
    gotPost.mockReturnValue({ json: vi.fn().mockRejectedValue({ response: { statusCode: 401 } }) });
    const result = await tool.invoke({ input: { query: 'secret' }, toolInvocationToken: undefined }, mockToken);
    expect(textOf(result)).toContain('could not authenticate');
  });

  it('returns a friendly message on network errors', async () => {
    gotPost.mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await tool.invoke({ input: { query: 'x' }, toolInvocationToken: undefined }, mockToken);
    expect(textOf(result)).toContain('network error');
  });

  it('returns a message when no API key is configured', async () => {
    mockContext.secrets.get.mockResolvedValue(undefined);
    const result = await tool.invoke({ input: { query: 'x' }, toolInvocationToken: undefined }, mockToken);
    expect(textOf(result)).toContain('API key is not configured');
  });

  it('returns a message for a missing query', async () => {
    const result = await tool.invoke({ input: { query: '   ' }, toolInvocationToken: undefined }, mockToken);
    expect(textOf(result)).toContain('No search query provided');
  });
});

describe('ZWebFetchTool', () => {
  let tool: ZWebFetchTool;
  let gotGet: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    tool = new ZWebFetchTool({ context: mockContext });
    const { default: got } = await import('got');
    gotGet = got.get as any;
  });

  it('returns stripped text from a mocked fetch', async () => {
    gotGet.mockResolvedValue({ body: '<html><body><h1>Title</h1><p>Hello &amp; world</p></body></html>' });
    const result = await tool.invoke({ input: { url: 'https://example.com' }, toolInvocationToken: undefined }, mockToken);
    const text = textOf(result);
    expect(text).toContain('Title');
    expect(text).toContain('Hello & world');
    expect(text).not.toContain('<h1>');
  });

  it('rejects non-http(s) URLs', async () => {
    const result = await tool.invoke({ input: { url: 'file:///etc/passwd' }, toolInvocationToken: undefined }, mockToken);
    expect(textOf(result)).toContain('Only http(s) URLs');
    expect(gotGet).not.toHaveBeenCalled();
  });

  it('rejects data: URLs', async () => {
    const result = await tool.invoke({ input: { url: 'data:text/plain,hello' }, toolInvocationToken: undefined }, mockToken);
    expect(textOf(result)).toContain('Only http(s) URLs');
  });

  it('returns a message for a missing URL', async () => {
    const result = await tool.invoke({ input: { url: '   ' }, toolInvocationToken: undefined }, mockToken);
    expect(textOf(result)).toContain('No URL provided');
  });

  it('returns a friendly message on fetch failure', async () => {
    gotGet.mockRejectedValue({ response: { statusCode: 403 } });
    const result = await tool.invoke({ input: { url: 'https://example.com' }, toolInvocationToken: undefined }, mockToken);
    expect(textOf(result)).toContain('could not authenticate');
  });
});
