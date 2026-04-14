import ky, { HTTPError } from 'ky';
import { CancellationToken, Progress } from 'vscode';

// Note: ModelContextProvider and ModelContextValue are not yet available in the stable VS Code API
// These interfaces are placeholders for when the MCP API becomes available
interface ModelContextProvider {
  provideModelContext(prompt: string, progress: Progress<any>, token: CancellationToken): Promise<void>;
}

interface ModelContextValue {
  type: string;
  value: any;
}

// Configuration for Z.AI API
const Z_AI_API_KEY = process.env.Z_AI_API_KEY || '';
const Z_AI_BASE_URL = 'https://api.z.ai/api';

// Helper function to make API requests to Z.AI with rate limiting and exponential backoff
async function fetchFromZAI(
  endpoint: string,
  params: any = {},
  retries: number = 3,
  delay: number = 1000,
): Promise<any> {
  try {
    const url = new URL(`${Z_AI_BASE_URL}/${endpoint}`);
    for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }

    return await ky
      .get(url.toString(), {
        headers: {
          Authorization: `Bearer ${Z_AI_API_KEY}`,
        },
        retry: 0,
      })
      .json<any>();
  } catch (error) {
    if (retries <= 0) {
      console.error(`Failed to fetch from Z.AI API after retries: ${error}`);
      throw error;
    }

    if (error instanceof HTTPError && error.response.status === 429) {
      console.warn(`Rate limit exceeded. Retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return fetchFromZAI(endpoint, params, retries - 1, delay * 2);
    }

    console.error(`Failed to fetch from Z.AI API: ${error}`);
    throw error;
  }
}

/**
 * Vision MCP Server - Provides vision capabilities for Z AI models
 */
export class VisionMCPServer implements ModelContextProvider {
  async provideModelContext(
    prompt: string,
    progress: Progress<ModelContextValue>,
    _token: CancellationToken,
  ): Promise<void> {
    try {
      // Fetch vision capabilities from Z.AI API
      const data = await fetchFromZAI('mcp/vision/capabilities');
      progress.report({
        type: 'vision',
        value: {
          description: 'Vision capabilities enabled',
          data: {
            supportsImageInput: data.supportsImageInput || true,
            supportsImageAnalysis: data.supportsImageAnalysis || true,
          },
        },
      });
    } catch (error) {
      progress.report({
        type: 'error',
        value: {
          description: 'Failed to fetch vision capabilities',
          error: error instanceof Error ? error.message : 'Unknown error',
        },
      });
    }
  }
}

/**
 * Search MCP Server - Provides search capabilities for Z AI models
 */
export class SearchMCPServer implements ModelContextProvider {
  async provideModelContext(
    prompt: string,
    progress: Progress<ModelContextValue>,
    _token: CancellationToken,
  ): Promise<void> {
    try {
      // Fetch search capabilities from Z.AI API
      const data = await fetchFromZAI('mcp/search/capabilities');
      progress.report({
        type: 'search',
        value: {
          description: 'Search capabilities enabled',
          data: {
            supportsWebSearch: data.supportsWebSearch || true,
            supportsCodeSearch: data.supportsCodeSearch || true,
          },
        },
      });
    } catch (error) {
      progress.report({
        type: 'error',
        value: {
          description: 'Failed to fetch search capabilities',
          error: error instanceof Error ? error.message : 'Unknown error',
        },
      });
    }
  }
}

/**
 * Reader MCP Server - Provides reader capabilities for Z AI models
 */
export class ReaderMCPServer implements ModelContextProvider {
  async provideModelContext(
    prompt: string,
    progress: Progress<ModelContextValue>,
    _token: CancellationToken,
  ): Promise<void> {
    try {
      // Fetch reader capabilities from Z.AI API
      const data = await fetchFromZAI('mcp/reader/capabilities');
      progress.report({
        type: 'reader',
        value: {
          description: 'Reader capabilities enabled',
          data: {
            supportsDocumentReading: data.supportsDocumentReading || true,
            supportsPDFProcessing: data.supportsPDFProcessing || true,
          },
        },
      });
    } catch (error) {
      progress.report({
        type: 'error',
        value: {
          description: 'Failed to fetch reader capabilities',
          error: error instanceof Error ? error.message : 'Unknown error',
        },
      });
    }
  }
}

/**
 * ZRead MCP Server - Provides zread capabilities for Z AI models
 */
export class ZReadMCPServer implements ModelContextProvider {
  async provideModelContext(
    prompt: string,
    progress: Progress<ModelContextValue>,
    _token: CancellationToken,
  ): Promise<void> {
    try {
      // Fetch zread capabilities from Z.AI API
      const data = await fetchFromZAI('mcp/zread/capabilities');
      progress.report({
        type: 'zread',
        value: {
          description: 'ZRead capabilities enabled',
          data: {
            supportsAdvancedReading: data.supportsAdvancedReading || true,
            supportsContextualAnalysis: data.supportsContextualAnalysis || true,
          },
        },
      });
    } catch (error) {
      progress.report({
        type: 'error',
        value: {
          description: 'Failed to fetch zread capabilities',
          error: error instanceof Error ? error.message : 'Unknown error',
        },
      });
    }
  }
}
