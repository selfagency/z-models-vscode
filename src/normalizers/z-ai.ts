/**
 * Z.ai SSE Normalizer
 *
 * Converts Z.ai streaming API response format to canonical output format
 * compatible with LLMStreamProcessor.
 */

export interface ZAiRawChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning_content?: string;
      tool_calls?: Array<{
        id: string;
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export interface NormalizedOutput {
  content?: string;
  toolCalls?: Array<{ name: string; arguments: string }>;
  thinking?: string;
  usage?: { inputTokens: number; outputTokens: number };
  finished: boolean;
}

/**
 * Convert Z.ai SSE chunk format to canonical normalized format.
 *
 * @param raw - Raw Z.ai API response chunk (typically parsed from SSE data: field)
 * @returns Normalized output with content, tool calls, thinking, and usage metrics
 */
export function normalizeZAiChunk(raw: ZAiRawChunk): NormalizedOutput {
  const choice = raw.choices?.[0];
  const delta = choice?.delta;

  return {
    content: delta?.content || undefined,
    thinking: delta?.reasoning_content || undefined,
    toolCalls: delta?.tool_calls?.map(tc => ({
      name: tc.function?.name ?? 'unknown',
      arguments: tc.function?.arguments ?? '{}',
    })),
    usage: raw.usage
      ? {
          inputTokens: raw.usage.prompt_tokens,
          outputTokens: raw.usage.completion_tokens,
        }
      : undefined,
    finished:
      choice?.finish_reason === 'stop' ||
      choice?.finish_reason === 'tool_calls' ||
      choice?.finish_reason === 'tool_use',
  };
}

/**
 * Create a streaming processor factory for Z.ai responses.
 * This can be used with LLMStreamProcessor to handle tool call deduplication,
 * buffering, and complete argument accumulation.
 *
 * @returns A function that accepts raw Z.ai chunks and returns normalized output
 */
export function createZAiStreamNormalizer() {
  return normalizeZAiChunk;
}
