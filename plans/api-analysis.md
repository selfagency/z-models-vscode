# API Patterns Analysis — VS Code Copilot + Z.ai Integration

**Date:** 2026-05-06
**Purpose:** Synthesize best practices from upstream documentation to guide z-models-vscode implementation
**Scope:** LanguageModelChatProvider BYOK patterns, Z.ai API correctness, Streaming & Tool Call handling

---

## Executive Summary

This analysis documents best practice patterns for integrating Z.ai's GLM models with VS Code's LanguageModelChatProvider API. It synthesizes findings from:

1. **microsoft/vscode-copilot-chat** — BYOK provider reference implementation
2. **docs.z.ai API Reference** — Complete OpenAPI specification
3. **docs.z.ai Capability Guides** — Thinking Mode, Stream Tool Call, Context Caching
4. **Current z-models-vscode implementation** — Existing patterns and gaps

**Key Findings:**

- ✅ Current implementation already uses focused `@agentsy/*` packages (no migration from @agentsy/core needed)
- 🟡 Thinking content is logged but not emitted to VS Code UI (missing `LanguageModelThinkingPart`)
- 🔴 Tool call preservation in history is incomplete (C-02 in remediation plan)
- 🔴 Several Z.ai API parameters are hardcoded incorrectly (`search_engine`, `clear_thinking` defaults)
- 🟢 Z.ai Tokenizer API should replace tiktoken for accurate token counting

---

## 1. VS Code LanguageModelChatProvider Patterns

### 1.1 Proposed API Capabilities

The `microsoft/vscode-copilot-chat` reference implementation demonstrates usage of **proposed VS Code APIs** that are not yet stable but should be implemented with version guards:

| Proposed API | Purpose | Version Guard Pattern |
|--------------|---------|---------------------|
| `LanguageModelThinkingPart` | Emit model reasoning content inline in chat UI | `(vscode as any).LanguageModelThinkingPart` |
| `LanguageModelResponsePart2` | Union type extending standard parts to include thinking/data | Conditional type alias |
| `MCP Server Definition Provider` | Register MCP servers for tool discovery | `vscode.lm.registerMcpServerDefinitionProvider` |

## Pattern: Guard with feature detection before using proposed APIs

```typescript
// Proposed: Emit thinking content
if (delta.thinking && (vscode as any).LanguageModelThinkingPart) {
  progress.report(new (vscode as any).LanguageModelThinkingPart(delta.thinking));
}

// Proposed: Extend progress type for newer VS Code versions
type ChatProgress = (vscode as any).LanguageModelResponsePart2
  ? Progress<(vscode as any).LanguageModelResponsePart2>
  : Progress<LanguageModelResponsePart>;
```

### 1.2 Streaming Progress Reporting

**Best Practice:** Use `progress.report()` for incremental updates during streaming:

```typescript
// ✅ CORRECT: Report incremental content
for await (const chunk of apiStream) {
  const { content, toolCalls, thinking } = normalizeChunk(chunk);

  if (content) {
    progress.report(new LanguageModelTextPart(content));
  }

  if (thinking) {
    // Option 1: Proposed API (VS Code 1.96+)
    if ((vscode as any).LanguageModelThinkingPart) {
      progress.report(new (vscode as any).LanguageModelThinkingPart(thinking));
    }
    // Option 2: Backward compatible (fallback)
    progress.report(new LanguageModelTextPart(`\n\n🧠 ${thinking}\n\n`));
  }

  for (const tool of toolCalls) {
    progress.report(new LanguageModelToolCallPart(tool.name, JSON.parse(tool.arguments)));
  }
}
```

**Pattern: Never buffer entire response before reporting. Emit as chunks arrive.**

### 1.3 Error Handling & User-Facing Messages

**Best Practice:** Convert API errors to `LanguageModelError` with user-friendly messages:

```typescript
try {
  await apiRequest();
} catch (error) {
  if (error.statusCode === 401) {
    throw new LanguageModelError('Invalid API key. Please check your Z.ai credentials.', 'InvalidCredentials');
  }
  if (error.statusCode === 429) {
    throw new LanguageModelError('Rate limit exceeded. Please wait before retrying.', 'RateLimitExceeded');
  }
  throw new LanguageModelError('An unexpected error occurred.', 'Unknown');
}
```

**Pattern: Always throw `LanguageModelError` (not generic `Error`) for API failures so VS Code can display appropriately.**

### 1.4 Cancellation Signal Handling

**Best Practice:** Convert VS Code's `CancellationToken` to `AbortSignal` for HTTP clients:

```typescript
// ✅ CORRECT: Use @agentsy/vscode helper
import { cancellationTokenToAbortSignal } from '@agentsy/vscode';

const abortSignal = cancellationTokenToAbortSignal(token);

await got.post(url, {
  signal: abortSignal,
  // ... other options
});
```

**Pattern: Never ignore cancellation tokens. All HTTP requests must support abortion.**

---

## 2. Z.ai API Patterns

### 2.1 Endpoints & URL Routing

Z.ai provides **two distinct endpoints** with different capabilities:

| Endpoint | URL | Purpose | Key Differences |
|----------|-----|---------|------------------|
| **General API** | `https://api.z.ai/api/paas/v4` | Text, Vision, Audio, Video | Standard models, thinking disabled by default |
| **Coding Plan API** | `https://api.z.ai/api/coding/paas/v4` | Coding-focused, Agentic tasks | **Preserved Thinking enabled by default**, optimized for tool use |

**Best Practice:** Route requests based on selected model/capability:

```typescript
function getEndpointForModel(modelId: string, useCoding: boolean): string {
  // Coding Plan endpoint for supported tools (Claude Code, Cursor, etc.)
  if (useCoding && modelId.startsWith('glm-5')) {
    return 'https://api.z.ai/api/coding/paas/v4';
  }
  // General API for all other use cases
  return 'https://api.z.ai/api/paas/v4';
}
```

### 2.2 Request Headers (Required)

**Best Practice:** Always include these headers (per Z.ai OpenAPI spec):

```typescript
headers: {
  'Authorization': `Bearer ${apiKey}`,
  'Content-Type': 'application/json',
  'Accept-Language': 'en-US,en',  // ← Required for error messages in English
  'User-Agent': userAgent,
}
```

**Pattern: `Accept-Language` is required. Without it, error messages may be returned in Chinese.**

### 2.3 Thinking Mode Configuration

Z.ai supports **two thinking modes** with different defaults per endpoint:

| Mode | Parameter | General API Default | Coding API Default | Models Supporting |
|-------|-----------|---------------------|-------------------|-------------------|
| **Deep Thinking** | `thinking.type = "enabled"` | Disabled (opt-in) | **Enabled by default** | GLM-5.1, GLM-5, GLM-5-Turbo, GLM-5V-Turbo, GLM-4.7 series |
| **Preserved Thinking** | `thinking.type = "enabled"` + endpoint | N/A (General API) | **Enabled by default** (Coding API) | GLM-5.1, GLM-5 series on Coding endpoint |

**Best Practice:** Smart-default based on endpoint and model:

```typescript
function getDefaultThinkingConfig(modelId: string, endpoint: string): {
  thinking?: { type: 'enabled' | 'disabled' };
  clear_thinking?: boolean;
} {
  // Coding endpoint: Preserved Thinking ON by default
  const isCodingEndpoint = endpoint.includes('/coding/');
  // GLM-5.1, GLM-5, GLM-4.7: Deep Thinking ON by default
  const isThinkingModel = /^glm-(5\.1|5($|-turbo)|4\.7)/i.test(modelId);

  if (isCodingEndpoint) {
    return { clear_thinking: false }; // Preserve thinking across turns
  }

  if (isThinkingModel) {
    return { thinking: { type: 'enabled' } };
  }

  return {}; // No thinking configuration
}
```

**Pattern: Never hardcode thinking defaults. They vary by model and endpoint.**

### 2.4 Thinking Content Handling (Streaming)

**Best Practice:** Accumulate `reasoning_content` from streaming deltas:

```typescript
// ✅ CORRECT: Process streaming thinking deltas
let reasoningContent = '';

for await (const chunk of apiStream) {
  const delta = chunk.choices?.[0]?.delta;

  // Thinking comes before content in streaming responses
  if (delta?.reasoning_content) {
    reasoningContent += delta.reasoning_content;
    progress.report(new LanguageModelThinkingPart(delta.reasoning_content));
  }

  // Content comes after thinking completes
  if (delta?.content) {
    progress.report(new LanguageModelTextPart(delta.content));
  }
}

// Store for history preservation
turn.reasoning = reasoningContent;
```

**Pattern: Emit thinking to progress immediately as deltas arrive. Don't wait for full response.**

### 2.5 Thinking Content in History (Preserved Thinking)

**Critical Pattern:** For Coding Plan endpoint (Preserved Thinking), `reasoning_content` MUST be sent back in assistant history messages:

```typescript
// ✅ CORRECT: Include reasoning_content in assistant history
function toZMessages(history: LanguageModelChatMessage[]): ZMessage[] {
  const messages: ZMessage[] = [];

  for (const turn of history) {
    if (turn.role === 'assistant') {
      // Extract reasoning from stored turn data (C-02 remediation)
      const reasoning = (turn as any).metadata?.reasoning;

      messages.push({
        role: 'assistant',
        content: turn.content,
        reasoning_content: reasoning, // ← REQUIRED for Preserved Thinking
        tool_calls: turn.toolCalls, // If present
      });
    }
  }

  return messages;
}
```

**Pattern: Missing `reasoning_content` in history breaks Preserved Thinking. The model will restart reasoning from scratch on each turn.**

### 2.6 Stream Tool Call (Tool Streaming)

**Best Practice:** Enable `tool_stream: true` for real-time tool call updates (reduces latency):

```typescript
// ✅ CORRECT: Enable tool streaming for GLM-4.6+
const requestBody = {
  model: 'glm-5.1',
  messages: zMessages,
  tools: toolDefinitions,
  stream: true,
  tool_stream: true, // ← REQUIRED for streaming tool calls
};

// Process streaming tool calls
for await (const chunk of apiStream) {
  const delta = chunk.choices?.[0]?.delta;

  if (delta?.tool_calls) {
    for (const toolCall of delta.tool_calls) {
      // Accumulate tool calls by index
      if (!accumulatedToolCalls[toolCall.index]) {
        accumulatedToolCalls[toolCall.index] = {
          id: toolCall.id,
          type: toolCall.type,
          function: { name: toolCall.function.name, arguments: '' },
        };
      }
      // Append arguments (streaming construction)
      accumulatedToolCalls[toolCall.index].function.arguments += toolCall.function.arguments;

      // Emit when complete (valid JSON)
      try {
        const args = JSON.parse(accumulatedToolCalls[toolCall.index].function.arguments);
        progress.report(new LanguageModelToolCallPart(args.name, args));
      } catch {
        // Still streaming, not complete yet
      }
    }
  }
}
```

**Pattern: Accumulate tool call arguments by index. Only emit when JSON is valid.**

### 2.7 Web Search Tool Configuration

**Best Practice:** Use correct `search_engine` enum value (per Z.ai OpenAPI spec):

```typescript
// ❌ INCORRECT: Invalid enum value
const webSearchConfig = {
  enable: true,
  search_engine: 'search-prime', // ← This doesn't exist
  search_result: true,
};

// ✅ CORRECT: Only valid value is 'search_pro_jina'
const webSearchConfig = {
  enable: true,
  search_engine: 'search_pro_jina', // ← ONLY valid value
  search_result: true,
};
```

**Pattern: The Z.ai API spec defines `search_engine` as required enum with exactly one value: `search_pro_jina`.**

### 2.8 Multimodal Content Types (Vision)

**Best Practice:** Support all three content types for vision models:

```typescript
// ✅ CORRECT: Handle image_url, video_url, and file_url
function toZMessageContent(part: LanguageModelDataPart): ZMessageContent[] {
  const content: ZMessageContent[] = [];

  // Image attachment
  if (part.mimeType?.startsWith('image/')) {
    content.push({
      type: 'image_url',
      image_url: { url: part.data.toString('base64') },
    });
  }

  // Video attachment (NEW: currently missing)
  if (part.mimeType?.startsWith('video/')) {
    content.push({
      type: 'video_url',
      video_url: { url: part.data.toString('base64') },
    });
  }

  // File attachment (NEW: currently missing)
  if (part.mimeType?.startsWith('application/pdf') || part.mimeType?.startsWith('text/')) {
    content.push({
      type: 'file_url',
      file_url: { url: part.data.toString('base64') },
    });
  }

  return content;
}
```

**Pattern: Z.ai Vision API supports `image_url`, `video_url`, and `file_url`. All three must be handled.**

### 2.9 Tokenizer API (Replace tiktoken)

**Best Practice:** Use Z.ai's native tokenizer API for accurate token counting:

```typescript
// ✅ CORRECT: Use Z.ai Tokenizer API for supported models
async function countTokensWithZaiTokenizer(messages: ZMessage[]): Promise<number> {
  const response = await got.post('https://api.z.ai/api/paas/v4/tokenizer', {
    headers: { 'Authorization': `Bearer ${apiKey}` },
    json: { model: 'glm-5.1', messages },
  }).json();

  return response.tokens ?? 0;
}

// ❌ INCORRECT: Using tiktoken with cl100k_base (wrong for GLM)
const encoding = get_encoding('cl100k_base');
const tokenCount = encoding.encode(text).length;
```

**Pattern: The Z.ai Tokenizer API supports `glm-4.6`, `glm-4.6v`, and `glm-4.5`. Use it for accurate counts. Fallback to tiktoken only for unsupported models.**

### 2.10 Model Token Limits

**Best Practice:** Fetch token limits from `/models/{id}` endpoint with fallback:

```typescript
// ✅ CORRECT: Fetch real token limits from API
async function fetchModelTokenLimits(modelId: string): Promise<{
  maxInputTokens?: number;
  maxOutputTokens?: number;
}> {
  try {
    const response = await got.get(`https://api.z.ai/api/paas/v4/models/${modelId}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    }).json();

    return {
      maxInputTokens: response.context_window ?? 200_000,
      maxOutputTokens: response.max_completion_tokens ?? 128_000,
    };
  } catch {
    // Fallback to hardcoded limits
    return getKnownTokenLimits(modelId);
  }
}
```

**Pattern: Always try to fetch limits from API first. Hardcoded limits are fallback only.**

### 2.11 Additional Request Parameters

These parameters should be exposed via `ZSupportedModelOptions`:

| Parameter | Type | Purpose | Z.ai API Field |
|-----------|------|---------|------------------|
| `do_sample` | boolean | Enable/disable sampling (false = greedy decoding) | `do_sample` |
| `stop` | string[] | Stop sequence (max 1 element) | `stop` |
| `user_id` | string (6-128 chars) | Multi-user attribution | `user_id` |
| `request_id` | string (UUID) | Request tracing | `request_id` |

**Best Practice:** Map user-facing options to Z.ai API fields with validation:

```typescript
interface ZSupportedModelOptions {
  // Existing
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  thinking?: { type: 'enabled' | 'disabled' };

  // NEW: Additional parameters
  do_sample?: boolean;
  stop?: string[];
  user_id?: string; // 6-128 chars, no PII
}
```

---

## 3. @agentsy/* Integration Patterns

### 3.1 Current Architecture

The z-models-vscode extension already uses **focused @agentsy/* package ecosystem** (not legacy monolith):

```text
@agentsy/vscode          → VS Code integration helpers
@agentsy/processor      → LLMStreamProcessor for stream orchestration
@agentsy/normalizers    → Provider-specific normalization
@agentsy/thinking       → Thinking content parsing
@agentsy/tool-calls     → Tool call buffering
@agentsy/structured      → JSON/structured output
@agentsy/context        → Context window management
@agentsy/formatting     → Text formatting utilities
@agentsy/renderers      → Rendering adapters (optional)
```

**No migration needed:** The extension already follows current @agentsy/* guidance. The PR title "feat: migrate extension to @agentsy/core and @agentsy/vscode" is misleading — no @agentsy/core cleanup is required.

### 3.2 Stream Processing with LLMStreamProcessor

**Best Practice:** Use `LLMStreamProcessor` from `@agentsy/processor` for event-driven stream handling:

```typescript
import { LLMStreamProcessor } from '@agentsy/processor';
import { normalizeZAiChunk } from '@agentsy/normalizers';

// Create processor once per request
const processor = new LLMStreamProcessor({
  maxToolCalls: MAX_TOOLS_PER_REQUEST,
  maxToolResultChars: MAX_TOOL_RESULT_CHARS,
});

// Process streaming chunks
for await (const chunk of apiStream) {
  const normalized = normalizeZAiChunk(chunk);
  const output = processor.process(normalized);

  // Emit to VS Code
  if (output.content) stream.progress.report(new LanguageModelTextPart(output.content));
  if (output.thinking) {
    // Emit thinking content (H-01 in remediation plan)
    stream.progress.report(new LanguageModelThinkingPart(output.thinking));
  }
  for (const toolCall of output.toolCalls) {
    stream.progress.report(new LanguageModelToolCallPart(
      toolCall.name,
      JSON.parse(toolCall.arguments ?? '{}'),
    ));
  }
}

// Flush final output
const final = processor.flush();
if (final.content) stream.progress.report(new LanguageModelTextPart(final.content));
```

**Pattern: Use `LLMStreamProcessor` for robust deduplication and buffering. Don't implement custom parsers.**

### 3.3 VS Code Rendering (Optional Enhancement)

**Best Practice:** Consider using `createVSCodeChatRenderer` from `@agentsy/vscode` for automatic proposed API handling:

```typescript
import { createVSCodeChatRenderer } from '@agentsy/vscode';

const renderer = createVSCodeChatRenderer({
  stream,  // ChatResponseStream from VS Code
  showThinking: true,
  thinkingStyle: 'progress', // 'blockquote' or 'progress'
});

await renderer.write(content);
await renderer.end();
```

**Pattern: The renderer handles `LanguageModelThinkingPart`, `LanguageModelDataPart`, and proposed API detection automatically. This is optional — manual progress reporting works fine.**

---

## 4. Integration Checklist

Based on this analysis, here's the priority checklist for z-models-vscode implementation:

### 🔴 Critical (Block Release)

- [ ] **C-01:** Fix `search_engine: 'search-prime'` → `'search_pro_jina'`
- [ ] **C-02:** Preserve `reasoning_content` in assistant history messages (Coding endpoint)
- [ ] **H-01:** Emit `LanguageModelThinkingPart` to progress (currently logged only)
- [ ] **H-04:** Add `Accept-Language: en-US,en` header to all API requests

### 🟡 High (Fix in Current Sprint)

- [ ] **H-02:** Update progress type to `LanguageModelResponsePart2` with version guard
- [ ] **H-03:** Add 13 missing GLM model token limits to `KNOWN_MODEL_TOKEN_LIMITS`
- [ ] **H-05:** Handle `video_url` and `file_url` multimodal content types
- [ ] **H-06:** Smart-default `clear_thinking` based on endpoint type
- [ ] **M-01:** Send `request_id` (UUID) on all API requests
- [ ] **M-02:** Handle non-standard `finish_reason` values (`length`, `sensitive`, etc.)

### 🟢 Medium (Fix in Current Milestone)

- [ ] **M-03:** Detect compulsory thinking models (GLM-5.1, GLM-5-Turbo, GLM-4.7)
- [ ] **M-04:** Use Z.ai Tokenizer API instead of tiktoken for supported models
- [ ] **M-05:** Expose `do_sample` parameter
- [ ] **M-06:** Expose `stop` parameter (max 1 element)
- [ ] **M-07:** Expose `user_id` parameter (6-128 chars, no PII)

### 🔵 Low / Enhancement

- [ ] **L-01:** Co-locate `reasoning_content` with `tool_calls` in history (Interleaved Thinking)
- [ ] Consider migrating to `createVSCodeChatRenderer` for automatic proposed API handling
- [ ] Add unit tests for `reasoning_content` preservation scenarios

---

## 5. References

- [microsoft/vscode-copilot-chat](https://github.com/microsoft/vscode-copilot-chat) — BYOK provider reference
- [docs.z.ai API Reference](https://docs.z.ai/api-reference/introduction) — Complete OpenAPI spec
- [docs.z.ai Chat Completion API](https://docs.z.ai/api-reference/llm/chat-completion.md) — Request/Response schemas
- [docs.z.ai Thinking Mode](https://docs.z.ai/guides/capabilities/thinking-mode.md) — Deep Thinking configuration
- [docs.z.ai Stream Tool Call](https://docs.z.ai/guides/tools/stream-tool.md) — Tool streaming guide
- [docs.z.ai Tokenizer API](https://docs.z.ai/api-reference/tools/tokenizer.md) — Native tokenizer endpoint
- [agentsy documentation](https://agentsy.self.agency/) — Current package guidance
- [remediation-plan.md](../remediation-plan.md) — Issue register for z-models-vscode

---

**Document Status:** Complete
**Next Steps:** Begin implementation of Critical and High priority issues
**Owner:** z-models-vscode maintainers
