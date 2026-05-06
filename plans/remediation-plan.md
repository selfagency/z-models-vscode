# Z.ai for Copilot (z-models-vscode) — Remediation Plan v2.3

**Repository:** [selfagency/z-models-vscode](https://github.com/selfagency/z-models-vscode)
**Version Reviewed:** 1.0.0
**Dependencies Updated:** Focused `@agentsy/*` package ecosystem (current) ✅
**References Audited:**

- [microsoft/vscode-copilot-chat](https://github.com/microsoft/vscode-copilot-chat) — BYOK provider system, `LanguageModelThinkingPart`, `LanguageModelResponsePart2`
- [docs.z.ai Chat Completion API](https://docs.z.ai/api-reference/llm/chat-completion.md) — full OpenAPI spec
- [docs.z.ai Thinking Mode guide](https://docs.z.ai/guides/capabilities/thinking-mode.md)
- [docs.z.ai Tokenizer API](https://docs.z.ai/api-reference/tools/tokenizer.md)
- [docs.z.ai Context Caching guide](https://docs.z.ai/guides/capabilities/cache.md)
- [agentsy documentation](https://agentsy.self.agency/) — current package guidance (see: [Getting started](https://agentsy.self.agency/getting-started.html), [Package catalog](https://agentsy.self.agency/packages.html), [Migration guide](https://agentsy.self.agency/migrating-from-llm-stream-parser.html))

---

## Summary & Status

The v1.0.0 upgrade resolved all 38 issues from the prior remediation plan. This audit against current upstream
references identified **17 new issues** in the areas of VS Code API compliance, Z.ai API correctness, missing
model data, and stream-processing correctness. **Phase 1 (immediate) fixes are now COMPLETE** (4/4 issues):

**Current completion snapshot:** the implementation work is now effectively complete for the core Z.ai provider
and VS Code integration path. The main remaining register item is `L-03` (feature-detect `LanguageModelChatMessage2`),
plus any intentionally deferred future-adoption items called out in the package plan.

This revision reconciles prior planning artifacts and is now the canonical source of truth for execution:

- `plans/upgrade.plan.md` incomplete tasks are explicitly mapped in **Upgrade Plan Carryover Reconciliation**.
- `plans/api-analysis.md` recommendations are fully represented by remediation IDs (C-01..L-05).
- Legacy migration assumptions from pre-focused package guidance are marked as superseded.

✅ **Phase 1 Complete:**

- C-01: Fixed `search_engine: 'search-prime'` → `'search_pro_jina'`
- H-04: Added `Accept-Language: en-US,en` header to all API requests
- H-03: Added 13 missing GLM model token limits (glm-4.5 series, glm-4.6V variants, etc.)
- H-06: Smart-defaulted `clear_thinking` based on endpoint type

**@agentsy/\* Integration:**
The current codebase uses focused packages (`@agentsy/vscode`, `@agentsy/processor`, `@agentsy/normalizers`, etc.) rather than the legacy monolith. `@agentsy/vscode` is the flagship integration package; it already includes its own chat renderer, agent loop, provider base class, API-key/settings helpers, usage helpers, and MCP helpers. Current guidance recommends the smallest package set per feature, but a full Agentsy implementation should still make deliberate use of adapters and agent loops where they replace bespoke glue:

**Streaming & Rendering:**

- `@agentsy/vscode` provides `createVSCodeChatRenderer` for VS Code integration with native handling of proposed APIs (thinking, tool invocation, usage reporting) where available
- `@agentsy/processor` provides `LLMStreamProcessor` for event-driven stream orchestration
- `@agentsy/normalizers` provides provider-specific normalization helpers (`normalizeZAiChunk`, etc.)
- See [Getting started](https://agentsy.self.agency/getting-started.html) and [Package catalog](https://agentsy.self.agency/packages.html) for usage examples

**Agent Loop (optional future enhancement):**

- `@agentsy/agent` provides `createAgentLoop()` for multi-turn agentic patterns with built-in step tracking, stop conditions, and conversation management
- This could simplify complex reasoning scenarios (e.g., `reasoning_content` preservation across tool-use turns, C-02 remediation) if introduced in the future

For the current extension, `createVSCodeAgentLoop()` from `@agentsy/vscode` is the first stop for VS Code-specific loop orchestration; `@agentsy/agent` is the lower-level reusable loop layer when we want loop behavior outside the VS Code shell.

**Adapter layer clarification:**

- `@agentsy/adapters` is a generic integration-wrapper package, not a Z.ai-specific adapter surface.
- Z.ai-specific normalization lives in `@agentsy/normalizers` (`normalizeZAiChunk`).
- If we later want to reduce bespoke glue code, `@agentsy/adapters` is where the provider-facing wrapper around normalization + processor orchestration would belong.

### Package surface review

The full published Agentsy package surface has now been reviewed against the repo:

| Package                | Status                        | Current role in this repo                                                                    | Next step                                                                                                                       |
| ---------------------- | ----------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `@agentsy/vscode`      | Complete / primary            | API key management, cancellation helpers, usage helpers, MCP helpers, VS Code chat rendering | Keep as the integration boundary; consider `BaseLanguageModelChatProvider` only if we want to standardize the shell further.    |
| `@agentsy/normalizers` | Complete                      | Z.ai stream normalization                                                                    | Keep as-is.                                                                                                                     |
| `@agentsy/processor`   | Complete (via adapters)       | Orchestration layer used through adapter callbacks                                           | Keep this layered usage; only move to direct processor wiring if extra low-level hooks are needed.                              |
| `@agentsy/adapters`    | Complete                      | `createGenericAdapter` used directly in provider streaming                                   | Keep as provider-facing glue boundary; not Z.ai-specific.                                                                       |
| `@agentsy/tool-calls`  | Partial                       | Indirect via adapters/processor; no direct helper usage yet                                  | Adopt direct helper APIs (`ToolCallAccumulator`, `buildToolResultMessage`) if we want to remove custom tool-call state next.    |
| `@agentsy/structured`  | Not yet adopted               | JSON repair / validation candidate                                                           | Adopt only if it replaces local parsing/repair logic cleanly.                                                                   |
| `@agentsy/thinking`    | Indirect                      | Used through processor/adapters parsing stack                                                | Keep indirect usage unless a direct parser API is needed for bespoke flows.                                                     |
| `@agentsy/formatting`  | Indirect                      | Covered through `@agentsy/vscode` internals                                                  | No direct action needed unless custom rendering returns.                                                                        |
| `@agentsy/renderers`   | Indirect                      | Covered through `@agentsy/vscode` internals                                                  | No direct action needed unless custom rendering returns.                                                                        |
| `@agentsy/context`     | Deferred                      | Not required yet                                                                             | Hold unless prompt-context tag management becomes a feature.                                                                    |
| `@agentsy/agent`       | Partial (via VS Code wrapper) | Agent-loop behavior is used through `createVSCodeAgentLoop`                                  | Adopt lower-level `createAgentLoop` directly only if/when we need custom multi-step orchestration beyond VS Code wrapper needs. |
| `@agentsy/ui`          | Deferred                      | Not required yet                                                                             | Hold unless we add conversation-store-driven UI.                                                                                |
| `@agentsy/ag-ui`       | Deferred                      | Not required yet                                                                             | Hold; not needed for the current VS Code extension.                                                                             |

For the full adoption breakdown, see [`plans/agentsy-adoption-plan.md`](./agentsy-adoption-plan.md).

---

## Issue Register

### 🔴 CRITICAL — Fix before next release

---

#### C-01: `web_search.search_engine` set to invalid enum value `'search-prime'`

**File:** `src/provider.ts` — `parseModelOptions()`, line ~810
**Impact:** Every invocation of web search will send an invalid API request. The Z.ai OpenAPI spec defines
`search_engine` as a required enum with exactly one valid value: `'search_pro_jina'`. Sending `'search-prime'`
will result in a 422 validation error from the API, silently disabling web search for all users.

**Evidence from API spec:**

```yaml
search_engine:
  type: string
  description: 'Type of search engine. Default is `search_pro_jina`. Supports: `search_pro_jina`.'
  enum:
    - search_pro_jina
  required: true
```

**Current code:**

```typescript
const webSearchConfig = {
  enable: true,
  search_engine: 'search-prime', // ← INVALID
  search_result: true,
};
```

**Fix:** Replace `'search-prime'` with `'search_pro_jina'`. Update the `ZSupportedModelOptions` type
documentation to reflect the only valid value.

---

#### C-02: `reasoning_content` not preserved in assistant history messages

**File:** `src/provider.ts` — `toZMessages()`, line ~1490
**Impact:** Interleaved Thinking and Preserved Thinking both require that `reasoning_content` from assistant
turns be forwarded back to the model in subsequent requests. The Z.ai docs are explicit:

> "All consecutive `reasoning_content` blocks must exactly match the original sequence generated by the
> model. Missing, truncated, rewritten, or reordered blocks may degrade performance or prevent the feature
> from taking effect."

Currently `toZMessages()` maps `LanguageModelTextPart`, `LanguageModelDataPart`, `LanguageModelToolCallPart`,
and `LanguageModelToolResultPart` — but has no path to include a previous assistant message's reasoning
content in the outgoing `ZMessage[]`. This breaks the coding plan endpoint (where Preserved Thinking is
enabled by default) and causes incorrect model behavior for all GLM-5/4.7 series models.

**Fix:** When `clear_thinking` is `false` (or on the coding endpoint), accumulate `reasoning_content`
from each streaming response. When building subsequent messages in `toZMessages()`, include
`reasoning_content` on assistant-role `ZMessage` objects. This requires:

1. Adding `reasoning_content?: string` to the `ZMessage` assistant-message variant.
2. Storing accumulated `reasoning_content` from the previous streaming response on the class instance.
3. Populating it when constructing assistant messages in `toZMessages()`.

---

### 🟡 HIGH — Fix within current sprint

---

#### H-01: `LanguageModelThinkingPart` never emitted via `progress.report()`

**File:** `src/provider.ts` — `provideLanguageModelChatResponse()`, line ~1410
**Impact:** VS Code's Copilot Chat UI can render model reasoning/thinking content inline when a provider
emits `LanguageModelThinkingPart` (a proposed API). The `microsoft/vscode-copilot-chat` BYOK reference
implementation calls `progress.report(new LanguageModelThinkingPart(delta))` whenever `delta.thinking`
is received. Our implementation logs `reasoning_content` to the output channel only — the thinking
content is never surfaced in the Copilot Chat panel.

**Current code:**

```typescript
streamProcessor.on('thinking', delta => {
  this.log.debug('[Z] thinking delta length: ' + (delta?.length ?? 0));
  // ← nothing reported to progress
});
```

**Fix:** Use focused `@agentsy/*` package guidance only. Preferred approach is `createVSCodeChatRenderer`
from `@agentsy/vscode` (or equivalent current renderer export) because it handles proposed API capability
detection for thinking/data parts automatically. Manual `progress.report()` with feature guards is acceptable
when tighter control is needed.

```typescript
import { createVSCodeChatRenderer } from '@agentsy/vscode';

const renderer = createVSCodeChatRenderer({
  stream, // ChatResponseStream from VS Code
  showThinking: true,
  thinkingStyle: 'progress', // 'blockquote' or 'progress'
});

await renderer.write(content);
await renderer.end();
```

If manual control is needed, emit `LanguageModelThinkingPart` when the `thinking` event fires (with version guard):

```typescript
streamProcessor.on('thinking', delta => {
  if (delta && (vscode as any).LanguageModelThinkingPart) {
    progress.report(new (vscode as any).LanguageModelThinkingPart(delta));
  }
});
```

Add `languageModelThinkingPart` to `enabledApiProposals` in `package.json`.

---

#### H-02: `provideLanguageModelChatResponse` progress typed as `LanguageModelResponsePart` instead of `LanguageModelResponsePart2`

**File:** `src/provider.ts` — `provideLanguageModelChatResponse()` signature, line ~1210
**Impact:** `LanguageModelResponsePart2` (proposed) extends the union type to include
`LanguageModelThinkingPart` and `LanguageModelDataPart`. Using the narrower `LanguageModelResponsePart`
prevents TypeScript from enforcing correct usage of the newer parts and will conflict with the VS Code
runtime's expected provider signature once the proposed API stabilises.

**Current signature:**

```typescript
async provideLanguageModelChatResponse(
  ...
  progress: Progress<LanguageModelResponsePart>,
  ...
): Promise<void>
```

**Fix:** Keep this aligned with focused `@agentsy/*` guidance. If using `createVSCodeChatRenderer`,
the renderer abstracts most proposed API type handling. If manually managing progress types, update
the signature to:

```typescript
Progress<LanguageModelResponsePart | LanguageModelThinkingPart | LanguageModelDataPart>;
```

Or use a conditional type alias for backwards compatibility:

```typescript
type ChatProgress = (vscode as any).LanguageModelResponsePart2
  ? Progress<(vscode as any).LanguageModelResponsePart2>
  : Progress<LanguageModelResponsePart>;
```

Recommended approach: migrate core streaming logic to use `createVSCodeChatRenderer` which handles
this transparently.

---

#### H-03: `KNOWN_MODEL_TOKEN_LIMITS` missing ~11 model entries

**File:** `src/provider.ts` — `KNOWN_MODEL_TOKEN_LIMITS`, line ~72
**Impact:** When `/models/{id}` fails to return `context_window` or `max_completion_tokens`, the extension
falls back to `KNOWN_MODEL_TOKEN_LIMITS`. For uncatalogued models this silently uses
`DEFAULT_MAX_OUTPUT_TOKENS = 16384`, under-reporting available tokens.

**Models missing from current table (per Z.ai API spec):**

| Model ID                     | Max Output Tokens | Max Input Tokens |
| ---------------------------- | ----------------- | ---------------- |
| `glm-4.5`                    | 96,000            | 200,000          |
| `glm-4.5-air`                | 96,000            | 200,000          |
| `glm-4.5-x`                  | 96,000            | 200,000          |
| `glm-4.5-airx`               | 96,000            | 200,000          |
| `glm-4.5-flash`              | 96,000            | 200,000          |
| `glm-4.5v`                   | 16,000            | 8,000            |
| `glm-4.6v`                   | 32,000            | 128,000          |
| `glm-4.6v-flash`             | 32,000            | 128,000          |
| `glm-4.6v-flashx`            | 32,000            | 128,000          |
| `glm-4.7-flash`              | 128,000           | 200,000          |
| `glm-4.7-flashx`             | 128,000           | 200,000          |
| `glm-4-32b-0414-128k`        | 16,000            | 128,000          |
| `autoglm-phone-multilingual` | 4,000             | 64,000           |

**Fix:** Add all rows above to `KNOWN_MODEL_TOKEN_LIMITS`.

---

#### H-04: `Accept-Language` header not sent on API requests

**File:** `src/provider.ts` — `createHttpClient()`, line ~550
**Impact:** The Z.ai OpenAPI spec defines `Accept-Language` as a header parameter on all POST endpoints
with default `en-US,en`. Without it, error messages and certain response metadata may be returned in
the API's default language.

**Fix:** Add `'Accept-Language': 'en-US,en'` to the base headers in `createHttpClient()`:

```typescript
headers: {
  'Authorization': `Bearer ${apiKey}`,
  'User-Agent': this.userAgent,
  'Content-Type': 'application/json',
  'Accept-Language': 'en-US,en',
},
```

---

#### H-05: `video_url` and `file_url` multimodal content types not handled

**File:** `src/provider.ts` — `toZMessages()`, line ~1580; `hasImageInput()`, line ~310
**Impact:** The Z.ai vision API supports three multimodal content types: `image_url`, `video_url`, and
`file_url`. `hasImageInput()` only checks for `image/` MIME types, and `toZMessages()` only constructs
`image_url` chunks. Users sending video or file attachments via VS Code's file attachment UI will have
those attachments silently dropped without error.

**Fix:**

1. Extend `hasImageInput()` to detect video and file MIME types (rename to `hasMultimodalInput()`).
2. In `toZMessages()`, add branches for `video/*` MIME types (emit `video_url` chunks) and document
   MIME types (emit `file_url` chunks), matching Z.ai schema field names exactly.
3. Update all callers of `hasImageInput()`.

---

#### H-06: `clear_thinking` default incorrect on Coding Plan endpoint

**File:** `src/provider.ts` — `parseModelOptions()`, line ~760
**Impact:** Per Z.ai docs: "Preserved Thinking is **enabled by default** on the **Coding Plan endpoint**
and **disabled by default** on the **standard API endpoint**." Our code defaults `clear_thinking` to
`undefined` (the API treats absent as `true`). On `zaiCoding` / `bigmodelCoding` endpoints, this
actively disables Preserved Thinking — the primary differentiating feature of those endpoints.

**Fix:** Detect the active endpoint in `parseModelOptions()` and smart-default `clear_thinking`:

```typescript
const isOnCodingEndpoint = this.getConfiguredBaseUrl().includes('/coding/');
const defaultClearThinking = isOnCodingEndpoint ? false : true;
// Only apply this default when user has NOT explicitly set clearThinking
```

---

### 🟢 MEDIUM — Fix within current milestone

---

#### M-01: `request_id` not sent on API requests

**File:** `src/provider.ts` — `provideLanguageModelChatResponse()`, line ~1280
**Impact:** Z.ai API accepts a `request_id` string (unique per-request) for tracing and support.
Without it, correlating VS Code extension requests with Z.ai platform logs requires the platform-
generated ID, which is only visible in API responses.

**Fix:** Generate a UUID per-request using the already-imported `randomUUID()` and include it in the
request payload. Log the `request_id` at INFO level to facilitate support tickets.

---

#### M-02: `finish_reason` values `length`, `sensitive`, `model_context_window_exceeded`, `network_error` not handled

**File:** `src/provider.ts` — stream loop, line ~1450
**Impact:** The Z.ai API can terminate streams with non-standard `finish_reason` values. Currently
only `stop` and `tool_calls` trigger finalization logic. Other values are silently ignored, giving
users no diagnostic signal.

**Z.ai `finish_reason` enum (complete):**

- `stop` — normal completion ✅ handled
- `tool_calls` — tool call termination ✅ handled
- `length` — max tokens hit; partial content returned ❌ not handled
- `sensitive` — content filtered ❌ not handled
- `model_context_window_exceeded` — input too large ❌ not handled
- `network_error` — upstream failure during generation ❌ not handled

**Fix:**

```typescript
switch (finishReason) {
  case 'length':
    this.log.warn('[Z] Response truncated: token limit reached');
    break;
  case 'sensitive':
    this.log.warn('[Z] Response filtered: sensitive content detected');
    break;
  case 'model_context_window_exceeded':
    throw new LanguageModelError('Context window exceeded. Reduce conversation length.', 'ContextExceeded');
  case 'network_error':
    throw new Error('Z.ai network error during generation. Please retry.');
}
```

---

#### M-03: Default-thinking model families not reflected in request logic

**File:** `src/provider.ts` — `parseModelOptions()`, line ~740
**Impact:** Per Z.ai docs: GLM-5.1, GLM-5, GLM-5-Turbo, GLM-5V-Turbo, and GLM-4.7 series have
thinking **enabled by default** (cannot be disabled by setting `type: 'disabled'`). The current code
only activates the `thinking` parameter when `explicitThinking` is true, which is fine for controlling
whether to enable it — but provides no indication that these models will think regardless. This also
intersects with C-02: if thinking is running on these models but `clear_thinking` is not appropriately
set, `reasoning_content` will not be preserved correctly.

**Fix:** Add a helper:

```typescript
function modelThinksCompulsorily(modelId: string): boolean {
  return /^glm-(5\.1|5-turbo|5v-turbo|5$|4\.7)/i.test(modelId);
}
```

Use in `parseModelOptions()` to: (a) skip setting `type: 'disabled'` if the model thinks compulsorily
and log a warning, (b) ensure `clear_thinking` defaulting in H-06 accounts for compulsory models.

---

#### M-04: Z.ai Tokenizer API not used — tiktoken `cl100k_base` is incorrect for GLM models

**File:** `src/provider.ts` — `provideTokenCount()`, line ~1660
**Impact:** `provideTokenCount()` uses the `cl100k_base` tiktoken encoding (designed for GPT-3.5/4).
GLM models use a different tokenizer. Z.ai provides a native tokenizer at `POST /paas/v4/tokenizer`
which supports `glm-4.6`, `glm-4.6v`, and `glm-4.5`. Using the wrong tokenizer produces inaccurate
context window estimates.

**Fix:** For models supported by the Z.ai Tokenizer API, make a `POST /tokenizer` request with the
message payload. For unsupported models, continue using tiktoken as an approximation. Cache per-model
capability to avoid redundant API roundtrips. Add a debug log noting which path was taken.

---

#### M-05: `do_sample` parameter not exposed

**File:** `src/provider.ts` — `ZSupportedModelOptions`, line ~200
**Impact:** `do_sample: false` forces greedy decoding (temperature/top_p have no effect), useful for
deterministic code generation. Not currently exposed in the model options interface.

**Fix:** Add `doSample?: boolean` / `do_sample?: boolean` to `ZSupportedModelOptions` and map to
`do_sample` in the request body.

---

#### M-06: `stop` parameter not exposed

**File:** `src/provider.ts` — `ZSupportedModelOptions`, line ~200
**Impact:** The Z.ai API supports up to 1 stop word. Not currently exposed.

**Fix:** Add `stop?: string[]` to `ZSupportedModelOptions`. Pass through to request body, capping at
1 element and logging a warning if more than 1 is provided.

---

#### M-07: `user_id` parameter not exposed

**File:** `src/provider.ts` — `ZSupportedModelOptions`, line ~200
**Impact:** Z.ai API accepts `user_id` (6–128 chars) for usage attribution in multi-user deployments.
Not currently exposed.

**Fix:** Add `userId?: string` / `user_id?: string` to `ZSupportedModelOptions`. Include in request
body when provided. Document the 6–128 char requirement and the prohibition on including PII.

---

### 🔵 LOW / ENHANCEMENT

---

#### L-01: Interleaved thinking + tool calls — `reasoning_content` must accompany `tool_calls` in history

**File:** `src/provider.ts` — `toZMessages()`, line ~1490
**Impact:** Z.ai Interleaved Thinking docs show that when thinking precedes a tool call, the
`reasoning_content` block must appear _in the same assistant message_ as `tool_calls` when sending
history. Currently assistant messages with `tool_calls` never carry `reasoning_content`. This is a
specific variant of C-02 that impacts multi-turn tool-use scenarios with thinking-enabled models.

**Fix:** When accumulating streamed tool calls and reasoning in a turn, track whether both are present.
When building the assistant history message in `toZMessages()`, co-locate both fields on the same message.

---

#### L-02: `cachedTokens` not surfaced in usage data part

**File:** `src/provider.ts` — `reportUsageMetrics()`, line ~440
**Impact:** `usage.prompt_tokens_details.cached_tokens` is read and debug-logged (line ~1355) but not
included in the `LanguageModelDataPart.json()` usage report emitted at the end of each response.
Cache hit rate is valuable for cost tracking.

**Fix:** Add `cachedTokens` to `this.usageMetrics` and include it in the `reportUsageMetrics()` payload.

---

#### L-03: `LanguageModelChatMessage2` proposed API not used when available

**File:** `src/provider.ts` — `provideLanguageModelChatResponse()` signature
**Impact:** `LanguageModelChatMessage2` (proposed) provides typed content arrays instead of `any[]`,
improving compile-time safety. As the proposed API stabilises this will need to be adopted.

**Fix:** Add a feature-detect for `LanguageModelChatMessage2`. If available, update the parameter type;
otherwise continue with `LanguageModelChatMessage`.

---

#### L-04: MCP HTTP servers missing `Accept-Language` header

**File:** `src/mcp-server-definition-provider.ts` — `resolveMcpServerDefinition()`, line ~85
**Impact:** `McpHttpServerDefinition` objects inject `Authorization` but not `Accept-Language`.
For consistency with the chat API (H-04) and to ensure English error messages from MCP endpoints.

**Fix:** Add `'Accept-Language': 'en-US,en'` alongside `Authorization` in the resolved HTTP headers.

---

#### L-05: `top_p` field on `ZModel` is never populated, causing silent `undefined` pass-through

**File:** `src/provider.ts` — `parseModelOptions()`, line ~720
**Impact:** `ZModel.top_p` is defined in the interface but never populated from the API `/models`
response. The current code defers to `foundModel.top_p` when constructing the request body — this
always evaluates to `undefined`, which is correct behaviour (API applies its own default), but the
dead field creates confusion.

**Fix:** Either remove `top_p` from `ZModel` (document that we let the API default it) or populate
it from the `/models` API response. Either way, add an explicit comment.

---

## Upgrade Plan Carryover Reconciliation

The older `plans/upgrade.plan.md` remains useful for sequencing but is no longer the canonical source.
Its open items are mapped below to this remediation register.

| Upgrade Item                                       | Carryover ID | Remediation Mapping                                  | Status | Notes                                                                                            |
| -------------------------------------------------- | ------------ | ---------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------ |
| Add abort signal support in model listing          | UP-01        | Existing cancellation workstream (Phase 2 hardening) | Open   | Keep explicit validation for list cancellation path.                                             |
| Fetch token limits from API with fallback          | UP-02        | H-03                                                 | Done   | Completed in Phase 1; keep regression test coverage.                                             |
| Replace custom tool-call parser with processor     | UP-03        | H-01, C-02, L-01                                     | Done   | Provider stream path now runs through adapters/processor boundary with passing regression tests. |
| Add ChatResponseTurn2 compatibility                | UP-04        | L-03                                                 | Open   | Track as proposed API compatibility enhancement.                                                 |
| Use secure random UUID IDs                         | UP-05        | M-01                                                 | Done   | `request_id` now generated and logged per request.                                               |
| Use Z.ai tokenizer API (fallback to tiktoken)      | UP-06        | M-04                                                 | Done   | Implemented with model-aware capability cache and fallback path.                                 |
| Add user warning for MCP on older VS Code          | UP-07        | L-04                                                 | Done   | MCP header alignment complete; compatibility messaging can remain follow-up polish.              |
| Expand streaming/tool-call tests                   | UP-08        | C-02, H-01, M-02, L-01                               | Done   | Regression tests now cover these flows and pass.                                                 |
| Release readiness checks (`test`, typecheck, lint) | UP-09        | Phase-gate verification                              | Done   | All checks pass locally in current branch.                                                       |

### Superseded from `upgrade.plan.md`

- Creating/extending normalizers in legacy external package namespaces is superseded.
- Legacy package-path migration wording is superseded by focused `@agentsy/*` package usage.
- Historical roadmap week labels are informational only; execution should follow remediation phases/IDs.

---

## Prioritized Remediation Roadmap

### Phase 1 — Immediate (before next tag)

| ID   | Title                                                            | Effort | Status |
| ---- | ---------------------------------------------------------------- | ------ | ------ |
| C-01 | Fix `search_engine` from `'search-prime'` to `'search_pro_jina'` | 15 min | Done   |
| H-04 | Add `Accept-Language: en-US,en` header                           | 10 min | Done   |
| H-03 | Add missing model token limits                                   | 30 min | Done   |
| H-06 | Smart-default `clear_thinking` on coding endpoint                | 1 hr   | Done   |

### Phase 2 — High priority (current sprint)

| ID   | Title                                                       | Effort | Status |
| ---- | ----------------------------------------------------------- | ------ | ------ |
| C-02 | Preserve `reasoning_content` in assistant history           | 3 hr   | Done   |
| H-01 | Emit `LanguageModelThinkingPart` via `progress.report()`    | 2 hr   | Done   |
| H-02 | Update progress type to include `LanguageModelThinkingPart` | 1 hr   | Done   |
| H-05 | Handle `video_url` and `file_url` multimodal content        | 2 hr   | Done   |
| M-02 | Handle non-standard `finish_reason` values                  | 1 hr   | Done   |

### Phase 3 — Medium priority (next sprint)

| ID   | Title                                                        | Effort | Status |
| ---- | ------------------------------------------------------------ | ------ | ------ |
| M-03 | Reflect compulsory-thinking models in request logic          | 1 hr   | Done   |
| M-04 | Use Z.ai Tokenizer API with tiktoken fallback                | 3 hr   | Done   |
| M-01 | Add `request_id` per-request                                 | 30 min | Done   |
| M-05 | Expose `do_sample` parameter                                 | 30 min | Done   |
| M-06 | Expose `stop` parameter                                      | 30 min | Done   |
| M-07 | Expose `user_id` parameter                                   | 30 min | Done   |
| L-01 | Preserve `reasoning_content` alongside tool calls in history | 2 hr   | Done   |

### Phase 4 — Low / polish

| ID   | Title                                          | Effort | Status |
| ---- | ---------------------------------------------- | ------ | ------ |
| L-02 | Surface `cachedTokens` in usage data part      | 30 min | Done   |
| L-03 | Add `LanguageModelChatMessage2` feature-detect | 1 hr   | Done   |
| L-04 | Add `Accept-Language` to MCP HTTP headers      | 10 min | Done   |
| L-05 | Clarify `top_p` default handling               | 30 min | Done   |

### Phase-gate verification (release carryover)

| Carryover ID | Gate               | Status |
| ------------ | ------------------ | ------ |
| UP-09        | `pnpm test` passes | Done   |
| UP-09        | Type-check passes  | Done   |
| UP-09        | Lint passes        | Done   |

---

## Verification Matrix by Issue ID (including carryover)

| Fix   | New Tests Required                                                                                |
| ----- | ------------------------------------------------------------------------------------------------- |
| C-01  | `parseModelOptions` with `webSearch: true` produces `search_engine: 'search_pro_jina'`            |
| C-02  | `toZMessages` includes `reasoning_content` on assistant messages when `clear_thinking: false`     |
| H-01  | `provideLanguageModelChatResponse` calls `progress.report` with `LanguageModelThinkingPart` delta |
| H-03  | `getKnownTokenLimits('glm-4.5')` returns `{ maxOutputTokens: 96000 }`                             |
| H-04  | HTTP client default headers include `Accept-Language: en-US,en`                                   |
| H-05  | Video MIME type in `LanguageModelDataPart` produces `video_url` content chunk in `toZMessages`    |
| H-06  | Coding endpoint URL causes `clear_thinking` to default to `false`                                 |
| M-02  | `finish_reason: 'model_context_window_exceeded'` in stream throws `LanguageModelError`            |
| M-04  | Token count uses Z.ai Tokenizer API for `glm-4.6`; falls back to tiktoken for unsupported models  |
| UP-01 | Cancel model list request mid-fetch and assert HTTP request abort occurs                          |
| UP-04 | Conversation history conversion handles both legacy and newer VS Code turn structures             |
| UP-08 | Tool call streaming regression suite covers partial JSON, deduplication, and malformed chunks     |
| UP-09 | CI gate job runs test + type-check + lint as release precondition                                 |

---

## Future Architecture Considerations

**Agentic Loop Migration (Phase 3+):**
The @agentsy agent loop abstraction (`createAgentLoop()`) offers a cleaner architecture for handling:

- Multi-turn reasoning with automatic history management
- Tool call orchestration with built-in state tracking
- Reasoning content accumulation and forwarding (simplifies C-02)
- Stop conditions (doom loop detection, finish reason matching)
- Interrupt controller support for cancellation

**Recommendation:** After Phase 2 fixes stabilize, evaluate migrating the core `provideLanguageModelChatResponse` stream handling to use `createAgentLoop`. This would:

1. Centralize reasoning_content preservation (C-02, L-01)
2. Improve tool-use reliability with built-in loop detection
3. Enable AG-UI protocol events for IDE-side progress UI
4. Reduce manual state management (step counting, tool call tracking)
5. Provide a foundation for future multi-step agentic workflows

This is a structural refactoring with high payoff for maintainability and feature velocity, best scheduled for Phase 3 after all immediate correctness fixes are complete.

---

## Prior Plan Status

All 38 issues from the v0.1.1 remediation plan were resolved in the v1.0.0 upgrade. This document
supersedes the previous plan entirely.
