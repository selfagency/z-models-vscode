# Z.ai for Copilot — Implementation Plan

**Target Version:** 1.0.0 (Production Release)
**Current Version:** 0.1.7
**Timeline:** 5 weeks, ~50 hours
**Priority:** High (Production extension with active users)

---

## Overview

This plan addresses critical bugs, architectural improvements, and quality enhancements to bring z-models-vscode to production maturity. The extension has solid foundations (error handling, MCP support, usage tracking) but needs fixes for cancellation handling, token limits, and tool call parsing before release.

---

## Phase 0: Critical Pre-Release Fixes (Days 1-2, ~3 hours)

### Objective

Fix 2 critical blocking issues that prevent production use.

### 0.1: Add Abort Signal Support to models.list() (1 hour)

**Issue:** C1 — Cancellation token not honored
**Current State:** `models.list()` ignores abort signals, causing UI hangs
**Deliverable:** All HTTP requests respect cancellation tokens

**Implementation:**

```typescript
// In createHttpClient()
models: {
  list: async (abortSignal?: AbortSignal) => {
    const data = await got
      .get(`${baseUrl}/models`, {
        headers,
        retry,
        signal: abortSignal, // ✅ Add this
      })
      .json();
    return { data: Array.isArray(data?.data) ? data.data : [] };
  }
}

// In provideLanguageModels()
async provideLanguageModels(token: CancellationToken): Promise<LanguageModelChatInformation[]> {
  const abortSignal = CancellationToken.toAbortSignal?.(token);
  const { data } = await this.client.models.list(abortSignal);
  // ...
}
```

**Testing:**

- [ ] Cancel model list request mid-fetch, verify HTTP abort
- [ ] Model picker cancels immediately (no timeout)

---

### 0.2: Fetch Token Limits from API Instead of Hardcoding (1.5 hours)

**Issue:** C2 — Token limits hardcoded and inaccurate
**Current State:** All models hardcoded to 200k/128k; missing limits for vision models
**Deliverable:** Token limits fetched from Z.ai API with fallback to defaults

**Implementation:**

```typescript
// Fetch token limits when models are fetched
private async fetchModelTokenLimits(modelId: string): Promise<{ maxInputTokens?: number; maxOutputTokens?: number }> {
  try {
    // Attempt to fetch from Z.ai models endpoint
    const response = await got.get(`${baseUrl}/models/${modelId}`, { headers }).json() as any;
    return {
      maxInputTokens: response.context_window ?? response.max_tokens ?? 200_000,
      maxOutputTokens: response.max_completion_tokens ?? 128_000,
    };
  } catch {
    // Fallback to known limits
    return getKnownTokenLimits(modelId) ?? {
      maxInputTokens: 200_000,
      maxOutputTokens: 128_000,
    };
  }
}

// Update fetchLanguageModels() to use this
async function fetchLanguageModels(): Promise<LanguageModelChatInformation[]> {
  const { data: modelData } = await this.client.models.list();
  return Promise.all(
    modelData.map(async (model) => ({
      id: model.id,
      vendor: 'z',
      family: model.family ?? 'glm',
      displayName: formatModelName(model.id),
      capabilities: resolveModelCapabilities(model.id),
      ...(await this.fetchModelTokenLimits(model.id)), // ✅ Fetch real limits
    }))
  );
}
```

**Testing:**

- [ ] Fetch models, verify token limits come from API
- [ ] Fallback to hardcoded limits if API unavailable
- [ ] Vision models have proper output limits

---

### 0.3: Run Full Test Suite and Verify (30 mins)

**Checklist:**

- [ ] All tests pass: `pnpm test`
- [ ] No regressions in streaming
- [ ] Type checking clean: `pnpm check-types`
- [ ] Linting clean: `pnpm lint`

---

## Phase 1: Important Fixes (Week 1, ~8 hours)

### Objective

Fix important issues that impact usability and reliability.

### 1.1: Replace Custom Tool Call Parser with LLMStreamProcessor (3 hours)

**Issue:** I1 — Text-embedded tool call parser has complexity bugs
**Current State:** Custom state machine for parsing `<|tool_call_begin|>...<|tool_call_end|>`
**Deliverable:** Integrated LLMStreamProcessor for tool call accumulation

**Why LLMStreamProcessor:**

- Robust deduplication based on complete arguments
- No resource leaks on incomplete streams
- Shared tool call logic with other extensions
- Documented and battle-tested

**Implementation:**

```typescript
import { LLMStreamProcessor } from '@selfagency/llm-stream-parser/processor';
import { LLMStreamNormalizer } from '@selfagency/llm-stream-parser/normalizers'; // New

// Create processor once per request
private createStreamProcessor(): LLMStreamProcessor {
  return new LLMStreamProcessor({
    maxToolCalls: MAX_TOOLS_PER_REQUEST,
    maxToolResultChars: MAX_TOOL_RESULT_CHARS,
  });
}

// In streaming handler:
const processor = this.createStreamProcessor();

for await (const chunk of apiStream) {
  // Normalize Z.ai SSE to canonical format
  const output = processor.process(chunk);

  // Emit tool calls
  for (const toolCall of output.toolCalls) {
    stream.tool({
      name: toolCall.name,
      input: JSON.parse(toolCall.arguments ?? '{}'),
    });
  }

  // Emit content
  if (output.content) {
    stream.markdown(output.content);
  }
}

// Flush any remaining
const final = processor.flush();
if (final.content) stream.markdown(final.content);
```

**Files to Create:**

- `src/normalizers/z-ai-sse.ts` — Convert Z.ai SSE format to canonical processor format

**Testing:**

- [ ] Tool calls from text-embedded tokens parsed correctly
- [ ] Duplicates deduplicated
- [ ] Partial JSON buffered and emitted when complete
- [ ] No memory leaks on incomplete streams
- [ ] Tool calls appear in VS Code chat UI

---

### 1.2: Add ChatResponseTurn2 Support for VS Code 1.96+ (1 hour)

**Issue:** I8 — History messages don't handle new VS Code structure
**Current State:** Only `ChatResponseTurn` and `ChatRequestTurn` handled
**Deliverable:** Graceful support for both old and new VS Code versions

**Implementation:**

```typescript
function toHistoryMessages(chatContext: vscode.ChatContext): vscode.LanguageModelChatMessage[] {
  const messages: vscode.LanguageModelChatMessage[] = [];

  for (const turn of chatContext.history) {
    if (turn instanceof vscode.ChatRequestTurn) {
      messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
      continue;
    }

    // VS Code < 1.96
    if (turn instanceof vscode.ChatResponseTurn) {
      const text = extractResponseText(turn.response);
      if (text) messages.push(vscode.LanguageModelChatMessage.Assistant(text));
      continue;
    }

    // VS Code >= 1.96
    if ('content' in turn && Array.isArray((turn as any).content)) {
      const text = extractResponseText((turn as any).content);
      if (text) messages.push(vscode.LanguageModelChatMessage.Assistant(text));
    }
  }

  return messages;
}

function extractResponseText(parts: any[]): string {
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((part): part is vscode.ChatResponseMarkdownPart => part instanceof vscode.ChatResponseMarkdownPart)
    .map(part => part.value.value)
    .join('');
}
```

**Testing:**

- [ ] History works on VS Code < 1.96
- [ ] History works on VS Code >= 1.96
- [ ] Multi-turn conversations preserve context

---

### 1.3: Use Secure Random ID Generation (30 mins)

**Issue:** I6 — Tool call ID mapping uses weak random IDs
**Current State:** `randomBytes(8).toString('hex')` — 64-bit entropy
**Deliverable:** Cryptographically strong IDs: `crypto.randomUUID()` — 128-bit entropy

**Implementation:**

```typescript
import { randomUUID } from 'node:crypto';

// Instead of:
// const vsCodeId = randomBytes(8).toString('hex');

// Use:
const vsCodeId = randomUUID();
```

**Testing:**

- [ ] Tool call ID mapping preserves uniqueness
- [ ] IDs are cryptographically random

---

### 1.4: Use Z.ai Token Counting API (2 hours)

**Issue:** I4 — Token counting uses wrong encoding (cl100k_base vs GLM)
**Current State:** Approximation using OpenAI tokenizer
**Deliverable:** Use Z.ai API for accurate token counting with fallback

**Implementation:**

```typescript
private async countTokens(messages: ZMessage[]): Promise<number> {
  try {
    // Try Z.ai's token counting endpoint
    const response = await got.post(`${this.getConfiguredBaseUrl()}/chat/completions`, {
      headers: { /* auth headers */ },
      json: {
        model: 'glm-5', // Any model
        messages,
        count_tokens: true, // Z.ai extension
      },
    }).json() as any;

    return response.tokens ?? response.usage?.prompt_tokens ?? 0;
  } catch {
    // Fallback to tiktoken approximation
    return this.estimateTokensWithTiktoken(messages);
  }
}
```

**Testing:**

- [ ] Token counting matches Z.ai API
- [ ] Fallback to tiktoken works if API unavailable
- [ ] Token limits enforced correctly

---

### 1.5: Add User Warning for MCP on Older VS Code (30 mins)

**Issue:** I2 — MCP registration fails silently
**Current State:** Warning logged only in extension logs
**Deliverable:** User-facing warning about MCP availability

**Implementation:**

```typescript
const mcpAvailable = Boolean(vscode.lm?.registerMcpServerDefinitionProvider);
if (!mcpAvailable) {
  logOutputChannel?.warn('[Z] MCP servers require VS Code 1.95+');

  // Optionally notify user on first run without MCP
  const shownMcpWarning = context.globalState.get('z-mcp-warning-shown');
  if (!shownMcpWarning) {
    await vscode.window.showWarningMessage(
      'Z.ai Vision/Search tools require VS Code 1.95 or later. Please update VS Code.',
      'Update VS Code',
      'Dismiss',
    );
    context.globalState.update('z-mcp-warning-shown', true);
  }
}
```

**Testing:**

- [ ] Warning shown once on startup with old VS Code
- [ ] No warning on new VS Code

---

### 1.6: Use crypto.randomUUID() for Strong IDs (30 mins)

**Issue:** I6 — Weak random ID generation
**Current State:** `randomBytes(8)` = 64-bit entropy
**Deliverable:** `randomUUID()` = 128-bit, collision-proof

**Files to Modify:**

- `src/provider.ts` — Replace ID generation

---

## Phase 2: Architecture & Integration (Week 2, ~9 hours)

### Objective

Improve architecture by leveraging llm-stream-parser and consolidating logic.

### 2.1: Create Z.ai Normalizer Module in llm-stream-parser (4 hours)

**Issue:** Architecture — Manual normalization duplicates logic
**Deliverable:** `@selfagency/llm-stream-parser/normalizers/z-ai.ts` module

**Purpose:**

- Convert Z.ai SSE format to canonical OutputPart format
- Handle tool calls, thinking content, usage metrics
- Support across multiple Z.ai extensions

**Implementation Spec:**

```typescript
// In llm-stream-parser/src/normalizers/z-ai.ts

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

export function normalizeZAiChunk(raw: ZAiRawChunk): {
  content?: string;
  toolCalls?: Array<{ name: string; arguments: string }>;
  thinking?: string;
  usage?: { inputTokens: number; outputTokens: number };
  finished: boolean;
} {
  // Normalize Z.ai format to canonical OutputPart
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
    finished: choice?.finish_reason === 'stop' || choice?.finish_reason === 'tool_calls',
  };
}

export function createZAiStreamProcessor(): LLMStreamProcessor {
  return new LLMStreamProcessor({
    maxToolCalls: 128,
    maxToolResultChars: 20000,
    normalizer: normalizeZAiChunk,
  });
}
```

**Files to Create:**

- `src/normalizers/z-ai.ts` — Z.ai normalizer
- Update `src/normalizers/index.ts` to export

**Testing:**

- [ ] SSE chunks normalized correctly
- [ ] Tool calls preserved
- [ ] Usage metrics extracted
- [ ] Thinking content captured

---

### 2.2: Integrate Normalizer into z-models-vscode (3 hours)

**Objective:** Use normalizer to simplify provider code

**Changes to `src/provider.ts`:**

```typescript
import { normalizeZAiChunk, createZAiStreamProcessor } from '@selfagency/llm-stream-parser/normalizers/z-ai';

// Simplify streaming handler
for await (const chunk of apiStream) {
  const normalized = normalizeZAiChunk(chunk);

  // Process through processor
  const output = processor.process(normalized);

  // Emit to VS Code
  if (output.content) stream.markdown(output.content);
  if (output.thinking) {
    // Optionally log or display thinking
    this.log.info(`[Z] Thinking: ${output.thinking}`);
  }
  for (const toolCall of output.toolCalls) {
    stream.tool({ name: toolCall.name, input: JSON.parse(toolCall.arguments) });
  }
}
```

**Simplifications:**

- Remove `parseTextEmbeddedToolCalls()` function (replaced by processor)
- Remove `stripControlTokens()` (handled by normalizer)
- Remove tool call ID mapping logic (processor handles dedup)

---

### 2.3: Expose Thinking Content to Chat (2 hours)

**Issue:** I2 (medium) — Reasoning output not shown to user
**Deliverable:** Display thinking blocks in chat

**Implementation:**

```typescript
// Option 1: Add collapsible thinking blocks
if (output.thinking) {
  stream.markdown(`\n\n<details><summary>🧠 Model Thinking</summary>\n\n${output.thinking}\n\n</details>\n\n`);
}

// Option 2: Log to output channel (less intrusive)
if (output.thinking) {
  this.log.info(`[Z Reasoning] ${output.thinking.slice(0, 500)}...`);
}
```

**Testing:**

- [ ] Thinking content appears in chat or logs
- [ ] Formatted clearly without breaking chat flow

---

## Phase 3: Testing & Quality (Week 3, ~12 hours)

### Objective

Expand test coverage for critical scenarios and improve code quality.

### 3.1: Add Streaming & Tool Call Tests (5 hours)

**Scenarios to cover:**

```typescript
describe('Streaming', () => {
  it('should accumulate and emit tool calls incrementally', () => {
    // Feed partial tool call JSON, verify emitted when complete
  });

  it('should deduplicate identical tool calls', () => {
    // Send same tool call twice, verify only one emitted
  });

  it('should handle malformed tool call gracefully', () => {
    // Invalid JSON in arguments, verify error handled
  });

  it('should respect cancellation during stream', () => {
    // Cancel token mid-stream, verify cleanup
  });

  it('should handle vision model fallback', () => {
    // Selected model no vision, image attached, verify fallback
  });
});
```

**Test utilities to create:**

- Mock Z.ai SSE generator
- Fake cancellation token
- Vision model registry mock

---

### 3.2: Add Vision & MCP Integration Tests (4 hours)

```typescript
describe('Vision & MCP', () => {
  it('should use vision model when image attached', () => {
    // Attach image, verify glm-4.6v selected
  });

  it('should handle vision model unavailable', () => {
    // No vision models, image attached, verify error message
  });

  it('should register MCP servers on supported VS Code', () => {
    // Check MCP registration on 1.95+
  });

  it('should warn on MCP unavailable', () => {
    // Check warning on < 1.95
  });
});
```

---

### 3.3: Add Error Scenario Tests (3 hours)

```typescript
describe('Error Handling', () => {
  it('should convert API errors to user-friendly messages', () => {
    // 401 → "Invalid API key"
    // 429 → "Rate limited"
  });

  it('should log full error details for debugging', () => {
    // Verify log contains stack trace
  });

  it('should retry on transient failures', () => {
    // Mock 503, verify retry logic
  });
});
```

---

### 3.4: Check Code Quality (3-4 hours)

**Checklist:**

- [ ] No `any` types except where unavoidable
- [ ] All error paths tested
- [ ] Coverage target: 80%+
- [ ] Type-checking clean: `pnpm check-types`
- [ ] Linting clean: `pnpm lint`
- [ ] Formatting clean: `oxfmt src --check`

**Files to audit for `any`:**

- `src/provider.ts` — API response types
- `src/mcp-server-definition-provider.ts` — MCP types

---

## Phase 4: Documentation & Polish (Week 4, ~15 hours)

### Objective

Improve documentation, security, and prepare for v1.0 release.

### 4.1: Update README & User Docs (3 hours)

**Sections:**

- Installation and setup
- Model picker vs. @z participant
- Troubleshooting common issues
- MCP server setup (Vision, Search, Reader)
- Token limits per model
- Privacy & security

---

### 4.2: Security & Compliance Audit (2 hours)

**Checklist:**

- [ ] API keys never logged
- [ ] No secrets in error messages
- [ ] HTTPS enforced
- [ ] Retry logic respects backoff
- [ ] Rate limiting implemented
- [ ] XSS prevention in tool call display

---

### 4.3: Performance Optimization (3 hours)

**Areas:**

- Model list caching (30 min cache TTL) ✅ Already done
- Parallel model token limit fetches
- Debounce rapid config changes
- Optimize SSE parsing for large responses

---

### 4.4: Prepare Release (4 hours)

**Checklist:**

- [ ] Update CHANGELOG.md with all fixes
- [ ] Update version to 1.0.0 in package.json
- [ ] Tag commit: `git tag v1.0.0`
- [ ] Build for release: `pnpm run package`
- [ ] Test packaged .vsix locally
- [ ] Publish to VS Code Marketplace: `pnpm run deploy`
- [ ] Create GitHub release with notes
- [ ] Announce in changelog/blog

---

### 4.5: Final QA & Integration Testing (2 hours)

**Test Plan:**

- [ ] Install from Marketplace, verify works
- [ ] Test with real Z.ai API key
- [ ] Multi-turn conversations maintain context
- [ ] Vision images processed correctly
- [ ] Tool calling works end-to-end
- [ ] Usage stats track correctly
- [ ] Cancellation stops requests
- [ ] MCP servers register properly

---

### 4.6: Dependency Updates & CI (1 hour)

**Checklist:**

- [ ] Update TypeScript to latest stable (if needed)
- [ ] Update devDependencies to latest
- [ ] Ensure CI pipeline passes
- [ ] Configure release automation in GitHub Actions

---

## Timeline & Milestones

| Week           | Phase                    | Duration      | Milestone              | Status           |
| -------------- | ------------------------ | ------------- | ---------------------- | ---------------- |
| **Pre-Week 1** | Phase 0: Critical Fixes  | ~3h           | v0.1.8-rc1             | Blocks Phase 1   |
| **Week 1**     | Phase 1: Important Fixes | ~8h           | v0.2.0-beta            | Better UX        |
| **Week 2**     | Phase 2: Architecture    | ~9h           | v0.3.0-beta            | Cleaner codebase |
| **Week 3**     | Phase 3: Testing         | ~12h          | v0.4.0-rc1             | 80%+ coverage    |
| **Week 4**     | Phase 4: Polish          | ~15h          | **v1.0.0**             | Production ready |
| **Total**      | **All Phases**           | **~47 hours** | **Production Release** | ✅ Ready         |

---

## Estimated Resource Requirements

| Role                   | Hours            | Tasks                                           |
| ---------------------- | ---------------- | ----------------------------------------------- |
| **Senior Engineer**    | 30               | Architecture, critical fixes, normalizer design |
| **Mid-level Engineer** | 12               | Tool call parser, testing, documentation        |
| **QA**                 | 8                | Test plan execution, bug verification           |
| **Docs/PM**            | 3                | Release notes, changelog, communication         |
| **Total**              | **53 FTE-hours** | ~2.5 weeks of 1 full-time engineer              |

---

## Risk & Mitigation

| Risk                                | Likelihood | Impact | Mitigation                             |
| ----------------------------------- | ---------- | ------ | -------------------------------------- |
| LLMStreamProcessor API changes      | Low        | High   | Pin version, test compatibility        |
| Z.ai API token endpoint unavailable | Low        | Medium | Implement robust fallback to hardcoded |
| VS Code 1.96 breaking changes       | Medium     | High   | Test on both old and new versions      |
| Tool call parser edge cases         | Medium     | Medium | Expand test coverage, use processor    |
| Performance regression in streaming | Low        | High   | Benchmark before/after each phase      |

---

## Success Criteria

✅ **Phase 0 Complete:**

- Cancellation tokens honored
- Token limits fetched from API
- All tests pass

✅ **Phase 1 Complete:**

- Tool call parser integrated with processor
- ChatResponseTurn2 supported
- MCP warning shown on old VS Code
- User-friendly token counting

✅ **Phase 2 Complete:**

- Z.ai normalizer added to llm-stream-parser
- Thinking content exposed
- Codebase simplified (removed 300+ lines of duplication)

✅ **Phase 3 Complete:**

- Test coverage 80%+
- All error scenarios covered
- Code quality audit passed

✅ **Phase 4 Complete:**

- v1.0.0 released to Marketplace
- Documentation complete
- Security audit passed
- Performance baseline established

---

## Appendix: Detailed Phase Breakdown

### Pre-Phase 1 Checklist

- [ ] Phase 0 critical fixes merged
- [ ] All tests passing
- [ ] Create feature branch: `feature/important-fixes-v0.2`
- [ ] Set up issue tracking for Phase 1 tasks

### Pre-Phase 2 Checklist

- [ ] Phase 1 fixes merged to main
- [ ] Normalizer design reviewed with @selfagency/llm-stream-parser maintainers
- [ ] Create PR to llm-stream-parser with z-ai normalizer

### Pre-Phase 3 Checklist

- [ ] Phase 2 architecture refactor merged
- [ ] Z.ai normalizer in llm-stream-parser released (v0.1.6+)
- [ ] Integration tests pass with new normalizer

### Pre-Phase 4 Checklist

- [ ] Phase 3 testing complete
- [ ] Coverage report generated
- [ ] Security audit report documented
- [ ] Performance baselines measured

---

## Next Steps (Immediate)

1. **Week 1 Monday:** Start Phase 0 (critical fixes)
2. **Week 1 Thursday:** Phase 0 complete, merge to main
3. **Week 2:** Begin Phase 1 (important fixes)
4. **Week 3:** Start Phase 2 (normalizer + integration)
5. **Week 4:** Phase 3 & 4 (testing + release)

---

## Contact & Support

- **Code Review Location:** `/Users/daniel/Developer/llm-stream-parser/Z_MODELS_CODE_REVIEW.md`
- **Questions:** Open issues on the repository
- **Timeline Adjustments:** Flag dependencies or blockers ASAP
