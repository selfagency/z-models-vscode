import got from 'got';
import * as vscode from 'vscode';
import { getConfiguredBaseUrl } from '../provider.js';

/**
 * Resolve the Z.ai API key using the same precedence as the chat provider:
 * injected ApiKeyManager first, then ExtensionContext secrets, then env vars.
 */
export async function resolveApiKey(
  context: vscode.ExtensionContext,
  apiKeyManager?: Pick<{ getApiKey(): Promise<string | undefined> }, 'getApiKey'>,
): Promise<string | undefined> {
  if (apiKeyManager) {
    const fromManager = (await apiKeyManager.getApiKey())?.trim();
    if (fromManager) {
      return fromManager;
    }
  }
  const fromSecrets = await context.secrets.get('Z_API_KEY');
  if (fromSecrets && fromSecrets.trim().length > 0) {
    return fromSecrets;
  }
  const fromEnv = (process.env.Z_API_KEY || process.env.ZHIPU_API_KEY || '').trim();
  return fromEnv.length > 0 ? fromEnv : undefined;
}

interface WebToolDeps {
  context: vscode.ExtensionContext;
  apiKeyManager?: Pick<{ getApiKey(): Promise<string | undefined> }, 'getApiKey'>;
}

function authHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'Accept-Language': 'en-US,en',
  };
}

function toToolResult(text: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}

function friendlyError(status: number): string {
  if (status === 401 || status === 403) {
    return 'Z.ai web tools could not authenticate. Please check your Z.ai API key.';
  }
  return `Z.ai web tool request failed with status ${status}. Please try again.`;
}

interface SearchResult {
  content?: string;
  title?: string;
  link?: string;
  icon?: string;
  publish_date?: string;
}

/**
 * First-party web search tool backed by the Z.ai web_search API.
 * Independent of MCP servers; calls the provider's own API directly.
 */
export class ZWebSearchTool implements vscode.LanguageModelTool<{ query: string; count?: number }> {
  constructor(private readonly deps: WebToolDeps) {}

  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<{ query: string; count?: number }>,
  ): { invocationMessage: string } | undefined {
    return { invocationMessage: `Searching the web for "${options.input.query}"` };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<{ query: string; count?: number }>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const query = options.input.query?.trim();
    if (!query) {
      return toToolResult('No search query provided.');
    }

    const apiKey = await resolveApiKey(this.deps.context, this.deps.apiKeyManager);
    if (!apiKey) {
      return toToolResult('Z.ai API key is not configured. Set it via the "Z: Manage API Key" command.');
    }

    const count = typeof options.input.count === 'number' && options.input.count > 0 ? Math.min(options.input.count, 10) : 5;
    const baseUrl = getConfiguredBaseUrl().replace(/\/$/, '');

    try {
      const body = await got
        .post(`${baseUrl}/web_search`, {
          headers: authHeaders(apiKey),
          json: { search_engine: 'search_pro_jina', search_query: query, count },
          timeout: { request: 30000 },
        })
        .json<{ search_results?: SearchResult[] }>();

      const results = Array.isArray(body?.search_results) ? body.search_results : [];
      if (results.length === 0) {
        return toToolResult(`No search results found for "${query}".`);
      }

      const lines = results
        .slice(0, count)
        .map((r, i) => {
          const title = r.title?.trim() || 'Untitled';
          const link = r.link?.trim() || '';
          const date = r.publish_date?.trim() ? ` (${r.publish_date.trim()})` : '';
          const content = r.content?.trim() ? `\n${r.content.trim()}` : '';
          return `${i + 1}. ${title}${date}\n${link}${content}`;
        })
        .join('\n\n');

      return toToolResult(`Web search results for "${query}":\n\n${lines}`);
    } catch (error) {
      const status = (error as { response?: { statusCode?: number } })?.response?.statusCode;
      if (typeof status === 'number') {
        return toToolResult(friendlyError(status));
      }
      return toToolResult('Z.ai web search failed due to a network error. Please try again.');
    }
  }
}

const MAX_FETCH_BYTES = 200 * 1024;

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

const ENTITY_MAP: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#39': "'",
};

export function stripHtml(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script\b[^>]*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    // single-pass decode so a decoded '&' is never re-scanned by later decodes
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/gi, (match, name: string) => {
      const lower = name.toLowerCase();
      return ENTITY_MAP[lower] ?? match;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * First-party web fetch tool that retrieves a URL's text content (bounded).
 * Rejects non-http(s) schemes to avoid file/data/SSRF-style access.
 */
export class ZWebFetchTool implements vscode.LanguageModelTool<{ url: string }> {
  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<{ url: string }>,
  ): { invocationMessage: string } | undefined {
    return { invocationMessage: `Fetching ${options.input.url}` };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<{ url: string }>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const url = options.input.url?.trim();
    if (!url) {
      return toToolResult('No URL provided.');
    }
    if (!isHttpUrl(url)) {
      return toToolResult('Only http(s) URLs can be fetched.');
    }

    try {
      const response = await got.get(url, {
        timeout: { request: 30000 },
        headers: { 'User-Agent': 'z-models-vscode/1.0.0' },
        responseType: 'text',
        maxRedirects: 5,
      });

      const body = response.body ?? '';
      const truncated = body.length > MAX_FETCH_BYTES;
      const text = stripHtml(truncated ? body.slice(0, MAX_FETCH_BYTES) : body);
      if (!text) {
        return toToolResult('The fetched page contained no readable text.');
      }
      const suffix = truncated ? '\n\n...[truncated: content exceeded size limit]' : '';
      return toToolResult(text + suffix);
    } catch (error) {
      const status = (error as { response?: { statusCode?: number } })?.response?.statusCode;
      if (typeof status === 'number') {
        return toToolResult(friendlyError(status));
      }
      return toToolResult('Failed to fetch the URL due to a network error. Please try again.');
    }
  }
}
