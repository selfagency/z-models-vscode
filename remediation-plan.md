# Z.ai for Copilot (z-models-vscode) — Comprehensive Remediation Plan

**Repository:** [selfagency/z-models-vscode](https://github.com/selfagency/z-models-vscode)
**Version Reviewed:** 0.1.1
**Date:** 2026-04-15
**Status:** Draft

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Repository Overview](#2-repository-overview)
3. [Critical Issues (P0)](#3-critical-issues-p0)
4. [High-Priority Issues (P1)](#4-high-priority-issues-p1)
5. [Medium-Priority Issues (P2)](#5-medium-priority-issues-p2)
6. [Low-Priority / Enhancement Issues (P3)](#6-low-priority--enhancement-issues-p3)
7. [MCP Integration Issues (Cross-Cutting)](#7-mcp-integration-issues-cross-cutting)
8. [VS Code API Compliance Gaps](#8-vs-code-api-compliance-gaps)
9. [Security Concerns](#9-security-concerns)
10. [Testing & CI Gaps](#10-testing--ci-gaps)
11. [Prioritized Remediation Roadmap](#11-prioritized-remediation-roadmap)

---

## 0. Implementation Completion Matrix

Status legend: ✅ implemented in code/tests, ✅ (verified) confirmed via current VS Code API/runtime constraints.

- **Critical (P0)**
  - 3.1 ✅ Vision MCP corrected to stdio (`@z_ai/mcp-server`) with env injection on resolve.
  - 3.2 ✅ Tool/result stream parts no longer silently discarded; participant renders and surfaces them.
  - 3.3 ✅ (verified) Chat history handling updated to preserve available response content; tool history parts are not exposed by current `ChatResponseTurn` shape.
  - 3.4 ✅ Removed dead `src/mcp-servers.ts`.

- **High (P1)**
  - 4.1 ✅ (verified) Current VS Code API supports positional `McpHttpServerDefinition` constructor; implementation aligned and tested.
  - 4.2 ✅ (verified) `vscode.McpServerDefinitionProvider` type name validated and used.
  - 4.3 ✅ `LanguageModelError`-aware error classification + localized messaging.
  - 4.4 ✅ Partial architectural decomposition delivered (`model-info.ts`, `role-utils.ts`) with provider compatibility re-exports.
  - 4.5 ✅ Token counting hardened for message/string/mixed content shapes.
  - 4.6 ✅ Vision capability inference added for model IDs when API metadata is sparse.

- **Medium (P2)**
  - 5.1 ✅ Added chat participant `disambiguation` metadata.
  - 5.2 ✅ Added slash commands (`/model`, `/vision`, `/clear`) and handler behavior.
  - 5.3 ✅ (verified) Evaluated `@vscode/prompt-tsx`; current provider uses direct LM forwarding with no custom prompt tree to migrate.
  - 5.4 ✅ Removed `as any` provider wiring bypass for log channel.
  - 5.5 ✅ Removed icon-path cast bypass; now typed URI construction.
  - 5.6 ✅ Added follow-up provider suggestions.
  - 5.7 ✅ Added initial MCP definitions change fire on provider construction.
  - 5.8 ✅ Added participant `when` gating based on API key context.
  - 5.9 ✅ (verified) `LLMStreamProcessor` retained for think/text sanitation; native tool-call SSE handling kept for structured JSON deltas.
  - 5.10 ✅ Documented token count approximation caveat in README.

- **Low / Enhancements (P3)**
  - 6.1 ✅ (verified) Naming conventions are compliant.
  - 6.2 ✅ Implemented `zModels.api.endpointMode` and `zModels.api.baseUrlOverride` configuration reading in `getConfiguredBaseUrl()` with endpoint presets (`zaiCoding`, `zaiGeneral`, `bigmodel`, `bigmodelCoding`), URL override priority, and configuration change listener.
  - 6.3 ✅ Added retry/backoff strategy for HTTP requests.
  - 6.4 ✅ Removed runtime `dotenv` usage and dependency from production deps.
  - 6.5 ✅ Removed eager startup activation event.
  - 6.6 ✅ Model family/version now derived from model identity.
  - 6.7 ✅ README clarifies Copilot Chat requirement explicitly.

- **Cross-cutting MCP**
  - 7.1 ✅ (verified) Per-server toggles retained and documented as explicit user controls.
  - 7.2 ✅ MCP server version pinning added.
  - 7.3 ✅ (verified) Tool annotations are server-owned; extension-side action is not applicable.

- **API Compliance Gaps**
  - 8.1 ✅ Provider forwards tool calls as `LanguageModelToolCallPart`.
  - 8.2 ✅ Thinking deltas are parsed/handled through stream processor path.
  - 8.3 ✅ `silent` initialization behavior verified and covered in tests.
  - 8.4 ✅ Tool-calling capability metadata is populated and inferred when API metadata is missing.

- **Security**
  - 9.1 ✅ Deferred API-key injection to `resolveMcpServerDefinition`; change events wired.
  - 9.2 ✅ API key input validation tightened (length + shape) without logging secrets.
  - 9.3 ✅ (verified) No request/header/body secret logging paths in provider diagnostics.

- **Testing / CI**
  - 10.1 ✅ Integration tests expanded (activation + commands).
  - 10.2 ✅ Added tool-call ID mapping edge-case tests (volume/repeat consistency).

---

## 1. Executive Summary

This document presents a comprehensive code review and remediation plan for the `z-models-vscode` extension, a VS Code extension that integrates Z.ai (Zhipu/GLM) language models into GitHub Copilot Chat via the VS Code Language Model Chat Provider API and MCP Server Definition Provider API.

The review was conducted against the following authoritative references:

- **VS Code AI Extension API Documentation:** Tools, Chat, Language Model Chat Provider, Language Model, and MCP guides.
- **Z.ai Platform Documentation:** API reference (endpoint configuration, authentication), GLM-5.1 coding agent integration, and best practices.
- **Z.ai MCP Server Documentation:** Vision, Web Search, Web Reader, and Zread MCP servers.
- **`@selfagency/llm-stream-parser` API Reference:** Full API for the streaming parser dependency used by the extension.

The review identified **38 distinct issues** across 6 severity tiers (P0–P3 plus cross-cutting and security categories). The most critical issues involve incorrect MCP server endpoint URLs, a broken message history reconstruction in the chat participant handler, dead code from a prior architecture, and missing tool-call result forwarding from the streaming parser. The remediation roadmap is organized into four phases with estimated effort for each.

---

## 2. Repository Overview

| Property           | Value                               |
| ------------------ | ----------------------------------- |
| **Name**           | z-models-vscode                     |
| **DisplayName**    | Z.ai for Copilot                    |
| **Version**        | 0.1.1                               |
| **Author**         | Daniel Sieradski (@selfagency)      |
| **License**        | MIT                                 |
| **Engine**         | VS Code ^1.109.0                    |
| **Runtime**        | Node.js, TypeScript 6, tsup bundler |
| **Test Framework** | Vitest + VS Code Test CLI           |

### Architecture

```
extension.ts                    (activation entry point)
├── ZChatModelProvider          (provider.ts, 1177 lines — core: API client, streaming, tool calling)
├── ZMcpServerDefinitionProvider (mcp-server-definition-provider.ts, 82 lines — MCP HTTP servers)
└── mcp-servers.ts              (194 lines — LEGACY placeholder classes, UNUSED)
```

### Key Files

| File                                    | Lines | Purpose                                                               |
| --------------------------------------- | ----- | --------------------------------------------------------------------- |
| `src/extension.ts`                      | 79    | Activation, chat participant registration, command registration       |
| `src/provider.ts`                       | 1177  | Core provider: HTTP client, streaming, tool calling, model management |
| `src/mcp-server-definition-provider.ts` | 82    | MCP server definitions for Vision, Search, Reader, Zread              |
| `src/mcp-servers.ts`                    | 194   | Legacy MCP server classes (unused dead code)                          |
| `src/extension.test.ts`                 | 171   | Extension activation tests                                            |
| `src/provider.test.ts`                  | 1500  | Comprehensive provider unit tests                                     |

---

## 3. Critical Issues (P0)

### 3.1 — Incorrect MCP Server Endpoint for Vision

**File:** `src/mcp-server-definition-provider.ts`, line 5
**Severity:** P0 — Functionality broken
**Category:** MCP Integration

The Vision MCP server URL is set to:

```typescript
vision: 'https://api.z.ai/api/mcp/vision/mcp',
```

According to the [Z.ai Vision MCP Server documentation](https://docs.z.ai/devpack/mcp/vision-mcp-server), the Vision MCP server is a **local (stdio) server** distributed as the NPM package `@z_ai/mcp-server`. It is **not** a remote HTTP endpoint. Unlike the Search, Reader, and Zread servers — which are remote HTTP MCP servers — Vision requires local execution via `npx -y "@z_ai/mcp-server"` with environment variables `Z_AI_API_KEY` and `Z_AI_MODE=ZAI`.

The current code incorrectly registers Vision as an `McpHttpServerDefinition`, which will fail at runtime because there is no HTTP MCP endpoint at that URL for Vision.

**Remediation:**

1. Remove the `vision` entry from `MCP_URLS` in `mcp-server-definition-provider.ts`.
2. Register Vision as an `McpStdioServerDefinition` using the `npx -y "@z_ai/mcp-server"` command pattern.
3. Pass the user's stored API key and `Z_AI_MODE=ZAI` as environment variables.
4. Update the `provideMcpServerDefinitions` method to conditionally return the stdio definition for Vision.

```typescript
// In provideMcpServerDefinitions:
if (config.get<boolean>('mcpServers.vision', true) && apiKey) {
  servers.push(
    new vscode.McpStdioServerDefinition({
      label: 'zVision',
      command: 'npx',
      args: ['-y', '@z_ai/mcp-server'],
      env: { Z_AI_API_KEY: apiKey, Z_AI_MODE: 'ZAI' },
    }),
  );
}
```

---

### 3.2 — Chat Participant Handler Silently Discards Tool Calls and Thinking

**File:** `src/extension.ts`, lines 49–67
**Severity:** P0 — Functionality broken
**Category:** VS Code API Compliance

The chat participant handler (`@z`) processes the `response.stream` but only extracts `LanguageModelTextPart` instances:

```typescript
for await (const chunk of response.stream) {
  if (chunk instanceof vscode.LanguageModelTextPart) stream.markdown(chunk.value);
}
```

Per the VS Code Language Model API documentation, the stream can also contain:

- `vscode.LanguageModelToolCallPart` — The model wants to invoke a tool. These **must** be yielded to the stream so that VS Code can orchestrate the tool-calling loop. If discarded, tool calling via `@z` is completely broken.
- `vscode.LanguageModelToolResultPart` — Results from prior tool invocations. These carry forward context.

Additionally, thinking/reasoning content produced by models (e.g., GLM-5.1 with thinking enabled) should be surfaced to the user. The VS Code API supports reporting thinking via `progress.report()`.

**Remediation:**

```typescript
for await (const chunk of response.stream) {
  if (chunk instanceof vscode.LanguageModelTextPart) {
    stream.markdown(chunk.value);
  } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
    stream.toolCall(chunk);
  }
}
```

If thinking/reasoning output should be visible, consider adding thinking part support when the VS Code API version supports it.

---

### 3.3 — Chat Participant History Reconstruction Ignores Tool Interactions

**File:** `src/extension.ts`, lines 42–48
**Severity:** P0 — Functionality degraded
**Category:** VS Code API Compliance

The history reconstruction loop only processes `ChatRequestTurn` and `ChatResponseTurn` markdown parts:

```typescript
for (const turn of chatContext.history) {
  if (turn instanceof vscode.ChatRequestTurn) {
    messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
  } else if (turn instanceof vscode.ChatResponseTurn) {
    const text = turn.response
      .filter((r): r is vscode.ChatResponseMarkdownPart => r instanceof vscode.ChatResponseMarkdownPart)
      .map(r => r.value.value)
      .join('');
    if (text) messages.push(vscode.LanguageModelChatMessage.Assistant(text));
  }
}
```

This loses all tool-call and tool-result history from the conversation. In a multi-turn conversation where the model previously invoked tools, the reconstructed messages will be missing the tool interaction context, causing the model to lose awareness of prior tool use. This violates the principle stated in the Chat Participant API guide: responses can combine multiple output types including tool calls and references.

**Remediation:**

Extend the history reconstruction to include tool-call and tool-result parts from `ChatResponseTurn`:

```typescript
} else if (turn instanceof vscode.ChatResponseTurn) {
  for (const part of turn.response) {
    if (part instanceof vscode.ChatResponseMarkdownPart) {
      // accumulate text
    } else if (part instanceof vscode.ChatResponseToolCallPart) {
      // accumulate tool calls
    } else if (part instanceof vscode.ChatResponseToolResultPart) {
      // accumulate tool results
    }
  }
  // Build assistant message with text + tool calls
  // Append tool result messages
}
```

---

### 3.4 — Dead Code File: `src/mcp-servers.ts`

**File:** `src/mcp-servers.ts` (194 lines)
**Severity:** P0 — Maintenance hazard
**Category:** Code Hygiene

This file defines placeholder `ModelContextProvider` interfaces and four MCP server classes (`VisionMCPServer`, `SearchMCPServer`, `ReaderMCPServer`, `ZReadMCPServer`) that are **never imported or used anywhere** in the codebase. The actual MCP integration is handled entirely by `mcp-server-definition-provider.ts`, which uses the native VS Code `McpServerDefinitionProvider` API.

This file appears to be a remnant from an earlier architecture where the extension may have attempted to run MCP servers inline. It is not bundled by `tsup` (which only includes `extension.ts` and `provider.ts` as entry points), but it is still present in the source tree and could confuse contributors.

**Remediation:**

1. Delete `src/mcp-servers.ts`.
2. Verify no tests reference it (current tests do not).

---

## 4. High-Priority Issues (P1)

### 4.1 — `McpHttpServerDefinition` Constructor Signature Mismatch

**File:** `src/mcp-server-definition-provider.ts`, lines 67–73
**Severity:** P1 — Potential runtime crash
**Category:** VS Code API Compliance

The code constructs `McpHttpServerDefinition` with a **three-argument positional constructor**:

```typescript
new vscode.McpHttpServerDefinition('zSearch', vscode.Uri.parse(MCP_URLS.search), headers);
```

However, the VS Code MCP Developer Guide documentation shows `McpHttpServerDefinition` being constructed with a **single object parameter** containing `label`, `uri`, `headers`, and `version` properties:

```typescript
new vscode.McpHttpServerDefinition({
  label: 'myRemoteServer',
  uri: 'http://localhost:3000',
  headers: { API_VERSION: '1.0.0' },
  version: '1.0.0',
});
```

The three-argument form may work in some VS Code versions but is not the documented API contract and could break in future releases. The `McpStdioServerDefinition` in the same documentation also uses an object parameter pattern.

**Remediation:**

Update all server definitions to use the object-parameter form:

```typescript
new vscode.McpHttpServerDefinition({
  label: 'zSearch',
  uri: vscode.Uri.parse(MCP_URLS.search),
  headers: { Authorization: `Bearer ${apiKey}` },
  version: '1.0.0',
});
```

---

### 4.2 — `McpServerDefinitionProvider` Interface Name Mismatch

**File:** `src/mcp-server-definition-provider.ts`, line 10
**Severity:** P1 — Type safety issue
**Category:** VS Code API Compliance

The class declares:

```typescript
export class ZMcpServerDefinitionProvider implements vscode.McpServerDefinitionProvider {
```

The VS Code MCP documentation uses the name `McpServerDefinitionProvider` for the provider interface, which is registered via:

```typescript
vscode.lm.registerMcpServerDefinitionProvider('zModels.mcpServers', mcpServerDefinitionProvider);
```

This should be verified against the actual `@types/vscode` version (currently `^1.109.0`) to confirm the interface name matches. If the type definition has a different name (e.g., with a different casing or version-specific suffix), this could cause a compile-time error or, worse, a silent mismatch at runtime.

**Remediation:**

1. Verify the exact interface name in the installed `@types/vscode` package.
2. Ensure `implements vscode.McpServerDefinitionProvider` matches the type declaration exactly.

---

### 4.3 — Chat Participant Handler Lacks Error Classification

**File:** `src/extension.ts`, lines 63–65
**Severity:** P1 — Poor UX
**Category:** VS Code API Compliance

The error handling in the chat participant handler is a bare catch that returns raw error messages:

```typescript
} catch (error) {
  stream.markdown(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
}
```

The VS Code Language Model API guide recommends checking for `vscode.LanguageModelError` specifically and handling different error codes (e.g., `off_topic`, rate limiting) with appropriate user-facing messages. The Chat Participant API guide also recommends using `vscode.l10n.t()` for localized error messages.

**Remediation:**

```typescript
} catch (error) {
  if (error instanceof vscode.LanguageModelError) {
    if (error.cause instanceof Error && error.cause.message.includes('off_topic')) {
      stream.markdown(vscode.l10n.t('I can only help with coding questions using Z.ai models.'));
    } else if (error.code === 'rate_limited') {
      stream.markdown(vscode.l10n.t('Rate limited. Please wait a moment and try again.'));
    } else {
      stream.markdown(vscode.l10n.t(`Model error: ${error.message}`));
    }
  } else {
    stream.markdown(vscode.l10n.t('An unexpected error occurred. Please check the output channel for details.'));
  }
}
```

---

### 4.4 — `provider.ts` is a 1177-Line Monolith

**File:** `src/provider.ts`
**Severity:** P1 — Maintainability risk
**Category:** Code Architecture

The core provider file handles at least 8 distinct responsibilities in a single file:

1. Model name formatting and metadata mapping
2. Role conversion (VS Code to Z API)
3. API key management (secrets store, env vars, input prompts)
4. HTTP client creation and endpoint management
5. Model fetching, caching, and deduplication
6. Chat completion streaming and SSE parsing
7. Tool call ID mapping and argument buffering
8. Token counting
9. MCP server configuration loading

This makes the file difficult to review, test in isolation, and extend. The test file (1500 lines) already demonstrates the complexity by having to mock everything.

**Remediation:**

Split into focused modules:

| New Module              | Responsibility                                        |
| ----------------------- | ----------------------------------------------------- |
| `src/model-info.ts`     | `formatModelName`, `getChatModelInfo`                 |
| `src/role-utils.ts`     | `toZRole` and message conversion utilities            |
| `src/api-client.ts`     | HTTP client creation, endpoint resolution             |
| `src/model-registry.ts` | `fetchModels`, caching, deduplication                 |
| `src/streaming.ts`      | SSE parsing, tool call buffering, thinking extraction |
| `src/tool-id-map.ts`    | Bidirectional tool call ID mapping                    |
| `src/token-counter.ts`  | Token counting via tiktoken                           |
| `src/provider.ts`       | Orchestrator class composing the above modules        |

---

### 4.5 — Missing `provideTokenCount` Implementation for Messages

**File:** `src/provider.ts` (within `provideTokenCount` method)
**Severity:** P1 — Incorrect behavior
**Category:** VS Code API Compliance

The VS Code Language Model Chat Provider documentation specifies that `provideTokenCount` can receive either a `string` or a `LanguageModelChatRequestMessage` as input. When a full message is provided, the token count should account for the role overhead and structured content (not just the raw text). The current implementation appears to convert messages to strings, which may not accurately count tokens for multimodal content (images) or tool-call payloads.

**Remediation:**

Implement message-aware token counting:

```typescript
if (typeof text === 'object' && 'role' in text && 'content' in text) {
  // Count role token overhead (~4 tokens for role markers)
  let tokens = 4;
  for (const part of text.content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      tokens += this.countTextTokens(part.value);
    } else if (part instanceof vscode.LanguageModelImagePart) {
      // Image tokens vary by resolution; use a reasonable estimate
      tokens += 85; // low-res or 170; // high-res
    }
  }
  return tokens;
}
```

---

### 4.6 — No Model Capabilities Reflect Image Input Support

**File:** `src/provider.ts` (`getChatModelInfo` or equivalent)
**Severity:** P1 — Missing feature flag
**Category:** VS Code API Compliance

The Z.ai API supports image/vision input for certain models (e.g., GLM-4.6V). The VS Code `LanguageModelChatInformation` interface includes a `capabilities.imageInput` boolean field that tells VS Code whether the model can accept image inputs. If this is not set correctly, VS Code will not route image attachments to the model, and the `@vscode` built-in tools that provide image context will not work with Z models.

**Remediation:**

When fetching model metadata from the Z.ai API, detect vision-capable models and set `imageInput: true`:

```typescript
capabilities: {
  imageInput: model.id.includes('vl') || model.id.includes('vision') || model.id.includes('4v'),
  toolCalling: true,
}
```

---

## 5. Medium-Priority Issues (P2)

### 5.1 — Missing `disambiguation` Configuration for Chat Participant

**File:** `package.json` (`contributes.chatParticipants`)
**Severity:** P2 — Discoverability
**Category:** VS Code API Compliance

The VS Code Chat Participant API supports a `disambiguation` property that enables automatic routing of questions to the chat participant even without an explicit `@z` mention. The documentation provides a clear example of how to configure categories, descriptions, and example phrases. The current `package.json` has no `disambiguation` entry, meaning users must always explicitly type `@z` to invoke the participant.

**Remediation:**

Add a `disambiguation` block to the chat participant contribution:

```json
{
  "id": "z-models-vscode.z",
  "name": "z",
  "fullName": "Z.ai",
  "description": "Ask questions using Z.ai models",
  "isSticky": true,
  "disambiguation": [
    {
      "category": "z-ai",
      "description": "The user wants to use Z.ai GLM models for coding assistance or general questions.",
      "examples": [
        "Ask Z.ai to help me refactor this function",
        "Use GLM to explain this code",
        "Help me write a unit test with Z.ai"
      ]
    }
  ]
}
```

---

### 5.2 — No Slash Commands Registered

**File:** `package.json` (`contributes.chatParticipants[0].commands`)
**Severity:** P2 — Missing feature
**Category:** VS Code API Compliance

The Chat Participant API supports registering slash commands (e.g., `/teach`, `/play` in the documentation examples) that give users quick access to specialized workflows. The current extension has no slash commands. Useful candidates:

| Command  | Description                          |
| -------- | ------------------------------------ |
| `model`  | Switch between available Z.ai models |
| `vision` | Toggle vision/image analysis mode    |
| `clear`  | Clear conversation history           |

**Remediation:**

Add commands to the chat participant definition and handle them in the request handler.

---

### 5.3 — `@vscode/prompt-tsx` Not Used for Prompt Crafting

**File:** `src/provider.ts` (model system prompts)
**Severity:** P2 — Best practice
**Category:** VS Code API Compliance

The VS Code Chat Participant API guide explicitly recommends using `@vscode/prompt-tsx` for crafting prompts, noting that it provides better support for dynamic adaptation to context window size and prompt engineering. The current extension appears to use hardcoded or simple string prompts.

**Remediation:**

Evaluate whether `@vscode/prompt-tsx` would improve the prompt management, especially for system prompts that need to adapt based on available context window size. This is a lower priority if the current prompts are functioning correctly.

---

### 5.4 — `logOutputChannel` Type Safety Bypass

**File:** `src/extension.ts`, line 10
**Severity:** P2 — Type safety
**Category:** Code Quality

```typescript
const provider = new ZChatModelProvider(context, logOutputChannel as any, true);
```

The `as any` cast bypasses TypeScript's type checking. This occurs because the log output channel creation is conditional on `createOutputChannel` being a function. The provider class should accept `vscode.LogOutputChannel | undefined` instead of relying on `any`.

**Remediation:**

1. Type the parameter as `vscode.LogOutputChannel | undefined` in the `ZChatModelProvider` constructor.
2. Remove the `as any` cast.

---

### 5.5 — `iconPath` Type Bypass

**File:** `src/extension.ts`, line 73
**Severity:** P2 — Type safety
**Category:** Code Quality

```typescript
participant.iconPath = (vscode.Uri as any).joinPath(context.extensionUri, 'logo.png');
```

The `as any` cast on `vscode.Uri` suggests a version mismatch. The `Uri.joinPath` static method is available in VS Code 1.109+ (which is the minimum version in `engines`). This cast should be unnecessary.

**Remediation:**

Replace with:

```typescript
participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'logo.png');
```

If this fails to compile, update `@types/vscode` to match the engine requirement.

---

### 5.6 — No Follow-up Provider for Chat Participant

**File:** `src/extension.ts`
**Severity:** P2 — UX enhancement
**Category:** VS Code API Compliance

The Chat Participant API supports a `followupProvider` that suggests follow-up questions after a response. This improves user engagement and helps guide multi-turn conversations. The current extension does not register any follow-up provider.

**Remediation:**

Add a follow-up provider to suggest relevant actions:

```typescript
participant.followupProvider = {
  provideFollowups(_result, _context, _token) {
    return [
      { prompt: 'Explain this in more detail', label: vscode.l10n.t('Explain in detail') },
      { prompt: 'Show me an alternative approach', label: vscode.l10n.t('Alternative approach') },
    ];
  },
};
```

---

### 5.7 — Missing `onDidChangeMcpServerDefinitions` Firing on First Activation

**File:** `src/mcp-server-definition-provider.ts`
**Severity:** P2 — Timing
**Category:** VS Code API Compliance

The provider sets up change listeners for configuration and secrets, but does not fire an initial event on construction. If VS Code queries the provider before any change event fires, the server definitions may not be immediately available. Consider whether an initial fire is needed to ensure definitions are available immediately after extension activation.

**Remediation:**

Consider whether the current lazy evaluation (definitions only computed when queried) is sufficient. If not, fire an initial event in the constructor:

```typescript
// Defer to avoid firing during construction
setImmediate(() => this.emitter.fire(undefined));
```

---

### 5.8 — No `when` Clause for Chat Participant

**File:** `package.json`
**Severity:** P2 — Best practice
**Category:** VS Code API Compliance

The Chat Participant API supports a `when` clause to control when the participant is available. For example, the participant should likely only appear when the user has configured an API key.

**Remediation:**

Add a `when` clause to the chat participant contribution:

```json
"when": "config.zModels.api.apiKeySet"
```

This would require tracking whether the API key is set in configuration (which could be done via a context variable set during activation).

---

### 5.9 — `LLMStreamProcessor` Not Leveraged for Tool Call Extraction

**File:** `src/provider.ts`
**Severity:** P2 — Underutilized dependency
**Category:** Code Quality

The extension depends on `@selfagency/llm-stream-parser` and uses it for thinking tag parsing. However, the library also provides `extractXmlToolCalls` for extracting structured tool calls from XML format and `LLMStreamProcessor` with built-in `tool_call` event handling. The current tool-calling implementation in `provider.ts` appears to handle tool calls manually via SSE stream parsing.

If the Z.ai API returns tool calls in an XML-like format that `extractXmlToolCalls` can parse, the extension should use it instead of manual parsing. Even if the Z.ai API uses standard OpenAI-style function calling (JSON format), the `LLMStreamProcessor` can still be used for unified stream processing with thinking extraction, context scrubbing, and event-based architecture.

**Remediation:**

Evaluate whether `LLMStreamProcessor` can replace the manual stream processing logic. Key considerations:

1. Does the Z.ai API use XML tool-call format or OpenAI-style JSON tool calls?
2. Can `LLMStreamProcessor` handle the Z-specific SSE stream format?
3. Would the event-based architecture simplify the streaming code?

---

### 5.10 — Token Counting Uses `cl100k_base` Which May Not Match GLM Tokenizer

**File:** `src/provider.ts` (token counting)
**Severity:** P2 — Accuracy
**Category:** Functional Correctness

The extension uses `tiktoken` with the `cl100k_base` encoding for token counting. This encoding is designed for OpenAI's GPT models. GLM models may use a different tokenizer, meaning token counts will be estimates rather than exact values. This affects:

1. Context window utilization (users may get truncated earlier than expected)
2. `provideTokenCount` accuracy (VS Code uses this for UI display and context management)

**Remediation:**

1. Document that token counts are estimates (not exact).
2. Consider querying the Z.ai API for token usage from the response headers/metadata if available.
3. If the Z.ai API returns `usage` fields in responses, prefer those values for display purposes.

---

## 6. Low-Priority / Enhancement Issues (P3)

### 6.1 — No Chat Participant Naming Convention Compliance

**File:** `package.json`
**Severity:** P3 — Naming convention
**Category:** VS Code API Compliance

The VS Code Chat Participant API guide specifies naming conventions:

| Property      | Current Value                     | Guideline                               |
| ------------- | --------------------------------- | --------------------------------------- |
| `id`          | `z-models-vscode.z`               | Extension name prefix — correct         |
| `name`        | `z`                               | Lowercase alphanumeric — correct        |
| `fullName`    | `Z.ai`                            | Title case — correct                    |
| `description` | `Ask questions using Z.ai models` | Sentence case, no punctuation — correct |

The naming conventions are actually followed correctly. No remediation needed.

---

### 6.2 — Endpoint Mode and Base URL Configuration

**File:** `package.json` / `src/provider.ts`
**Severity:** P3 — UX
**Category:** Feature Gap
**Status:** ✅ Implemented

The `zModels.api.endpointMode` and `zModels.api.baseUrlOverride` settings were defined in `package.json` but never read by the provider code. The `getConfiguredBaseUrl()` method was hardcoded to return `CODING_BASE_URL`.

**Implementation:**

1. Replaced the hardcoded `CODING_BASE_URL` constant with an `ENDPOINT_PRESETS` map covering all four modes (`zaiCoding`, `zaiGeneral`, `bigmodel`, `bigmodelCoding`).
2. Updated `getConfiguredBaseUrl()` to read `zModels.api.baseUrlOverride` first (takes priority if non-empty), then fall back to `zModels.api.endpointMode` preset.
3. Added a `workspace.onDidChangeConfiguration` listener in the constructor to reset the client and invalidate the model cache when endpoint settings change, then fire `_onDidChangeLanguageModelChatInformation` so VS Code refreshes the model picker.
4. Added 6 unit tests covering all endpoint modes, unknown mode fallback, override priority, and whitespace-only override handling.

---

### 6.3 — No Rate Limiting or Retry Logic in HTTP Client

**File:** `src/provider.ts`
**Severity:** P3 — Resilience
**Category:** Robustness

The HTTP client (via `got`) does not appear to implement rate limiting, exponential backoff, or retry logic for failed requests. The VS Code Language Model API guide recommends using language models responsibly and handling rate limiting gracefully.

**Remediation:**

1. Add retry logic with exponential backoff for transient errors (429, 5xx).
2. Implement request queuing if multiple concurrent requests are made.
3. Surface rate-limit errors with clear user-facing messages.

---

### 6.4 — `dotenv` Dependency in Production Bundle

**File:** `package.json` (dependencies)
**Severity:** P3 — Bundle size
**Category:** Dependencies

`dotenv` (version 17.4.2) is listed as a production dependency. In a VS Code extension context, environment variables are managed by VS Code's settings system and secrets API, not by `.env` files. The `dotenv` package should not be needed in production.

**Remediation:**

1. If `dotenv` is only used for local development/testing, move it to `devDependencies`.
2. If it is used to read `Z_API_KEY` / `ZHIPU_API_KEY` from the environment, those environment variables are already available to the Node.js process without `dotenv`.

---

### 6.5 — No `onLanguageModelChatProvider:z` Activation Event Guard

**File:** `package.json` (activationEvents)
**Severity:** P3 — Performance
**Category:** Best Practice

The extension activates on `onStartupFinished`, which means it loads immediately when VS Code starts. For users who have the extension installed but rarely use Z.ai models, this adds unnecessary startup overhead. The `onLanguageModelChatProvider:z` activation event should be sufficient for most use cases.

**Remediation:**

Evaluate whether `onStartupFinished` is truly needed. If the chat participant and MCP server definitions can be registered lazily, remove `onStartupFinished` and rely on:

```json
"activationEvents": [
  "onLanguageModelChatProvider:z",
  "onChatParticipant:z-models-vscode.z",
  "onMcpServerDefinitionProvider:zModels.mcpServers"
]
```

---

### 6.6 — Missing Model Family and Version in Model Information

**File:** `src/provider.ts` (`getChatModelInfo`)
**Severity:** P3 — Metadata completeness
**Category:** VS Code API Compliance

The `LanguageModelChatInformation` interface includes `family` and `version` fields. The `family` field groups models (e.g., all GLM-5 variants), and `version` allows users to see which version of a model they're using. The current implementation should verify these fields are populated correctly.

**Remediation:**

Ensure model information includes:

```typescript
{
  family: model.family || model.id.split('-').slice(0, 2).join('-'),
  version: model.version || '1.0.0',
}
```

---

### 6.7 — No Extension Dependency on `github.copilot`

**File:** `package.json`
**Severity:** P3 — Documentation
**Category:** VS Code Marketplace Policy

The VS Code Language Model API documentation warns: "Do not introduce extension dependency on GitHub Copilot if extension has other functionality." The README lists "GitHub Copilot Chat extension" as a requirement. If the extension only works with Copilot, this should be documented as a hard dependency. If the extension could theoretically work with other language model consumers, the dependency should not be introduced.

**Remediation:**

1. Clarify in the README whether Copilot is a hard requirement or optional.
2. If it is a hard requirement, consider adding it as an extension dependency in `package.json`.

---

## 7. MCP Integration Issues (Cross-Cutting)

### 7.1 — MCP Server Enable/Disable Uses Plain Booleans Instead of Individual Settings

**File:** `package.json` / `src/mcp-server-definition-provider.ts`
**Severity:** P2
**Category:** MCP Integration

The current configuration uses four separate boolean settings:

```json
"zModels.mcpServers.vision": { "type": "boolean", "default": true },
"zModels.mcpServers.search": { "type": "boolean", "default": true },
"zModels.mcpServers.reader": { "type": "boolean", "default": true },
"zModels.mcpServers.zread": { "type": "boolean", "default": true }
```

This works but is inconsistent with how VS Code manages MCP servers natively. VS Code allows users to enable/disable MCP servers from the Tools picker UI. Since the extension registers servers via `McpServerDefinitionProvider`, VS Code should handle enable/disable. The custom settings create a parallel configuration path that could confuse users.

**Remediation:**

Evaluate whether the custom boolean settings are necessary. If VS Code's built-in MCP server management (via the Tools picker) provides sufficient control, the custom settings can be removed. If they are kept for the Vision stdio server (which needs env vars), document clearly why they exist.

---

### 7.2 — No MCP Server Version Pinning

**File:** `src/mcp-server-definition-provider.ts`
**Severity:** P3
**Category:** MCP Integration

The `McpHttpServerDefinition` objects do not include a `version` field. While the VS Code MCP documentation shows `version` as optional, including it enables VS Code to detect when a server's capabilities change and prompt for re-configuration.

**Remediation:**

Add version metadata to server definitions:

```typescript
new vscode.McpHttpServerDefinition({
  label: 'zSearch',
  uri: vscode.Uri.parse(MCP_URLS.search),
  headers: { Authorization: `Bearer ${apiKey}` },
  version: '1.0.0',
});
```

---

### 7.3 — No MCP Tool Annotation Support

**File:** `src/mcp-server-definition-provider.ts`
**Severity:** P3
**Category:** MCP Integration

The VS Code MCP documentation describes tool annotations including `title` (human-readable name) and `readOnlyHint` (skip confirmation for read-only tools). Since the MCP servers are remote and the extension doesn't control their tool definitions, this is not directly actionable. However, if the Z.ai MCP servers support these annotations, VS Code will automatically benefit from them.

**Remediation:**

Verify that the Z.ai MCP server endpoints return proper tool annotations in their MCP responses. Coordinate with Z.ai if annotations are missing.

---

## 8. VS Code API Compliance Gaps

### 8.1 — No `provideLanguageModelChatResponse` Tool-Call Forwarding from Z API

**File:** `src/provider.ts`
**Severity:** P1 (covered in 3.2 above)
**Category:** VS Code API Compliance

When the Z.ai model returns a tool call in the streaming response, the provider must convert it to a `vscode.LanguageModelToolCallPart` and report it via the `progress` callback. This is the core mechanism by which VS Code's agent mode orchestrates tool calling. The current implementation must be verified to correctly forward Z API tool calls in the VS Code format.

### 8.2 — No `provideLanguageModelChatResponse` Thinking Content Forwarding

**File:** `src/provider.ts`
**Severity:** P2
**Category:** VS Code API Compliance

If GLM models produce thinking/reasoning content (especially GLM-5.1 with thinking mode enabled), this content should be reported via `progress.report()`. The `@selfagency/llm-stream-parser` library provides `ThinkingParser` specifically for this purpose. The provider should verify that thinking content from the Z API is correctly parsed and forwarded.

### 8.3 — `provideLanguageModelChatInformation` Does Not Handle `silent` Mode Correctly

**File:** `src/provider.ts`
**Severity:** P2
**Category:** VS Code API Compliance

The VS Code Language Model Chat Provider documentation specifies that when `options.silent` is `true`, the provider should not prompt the user (e.g., for an API key). The current implementation should verify that the `silent` flag is respected throughout the initialization flow, including in `provideLanguageModelChatInformation` and `initClient`.

### 8.4 — Missing `capabilities.toolCalling` Metadata

**File:** `src/provider.ts`
**Severity:** P2
**Category:** VS Code API Compliance

The `LanguageModelChatInformation.capabilities.toolCalling` field should indicate whether a model supports tool calling and, optionally, how many parallel tool calls it supports. This enables VS Code to optimize tool-call routing. If the Z API models support function calling, this should be set to `true` or a specific number.

---

## 9. Security Concerns

### 9.1 — API Key Passed as HTTP Header in MCP Server Definitions

**File:** `src/mcp-server-definition-provider.ts`
**Severity:** P2 — Security consideration
**Category:** Security

The API key is embedded directly in HTTP headers for MCP server definitions:

```typescript
const headers = { Authorization: `Bearer ${apiKey}` };
```

This is the standard pattern for HTTP MCP servers (the VS Code MCP documentation shows the same pattern). However, the headers are constructed fresh each time `provideMcpServerDefinitions` is called. VS Code may cache these definitions, which means the API key could persist in memory beyond its useful lifetime.

**Remediation:**

1. Document that API keys in MCP headers are managed by VS Code's MCP framework.
2. Ensure `onDidChangeMcpServerDefinitions` fires when the API key changes (already implemented for secrets changes).
3. Consider using `resolveMcpServerDefinition` for deferred key injection if VS Code supports it.

### 9.2 — No Input Validation on User-Provided API Key

**File:** `src/provider.ts` (`setApiKey`)
**Severity:** P2 — Security
**Category:** Input Validation

While there are tests for API key validation, the validation logic should ensure that:

1. The key matches the expected format (prefix, length).
2. No injection is possible through the key value.
3. The key is not logged or included in error messages.

**Remediation:**

Audit the `setApiKey` method and ensure no key material is included in log output, error messages, or telemetry.

### 9.3 — `got` HTTP Library — Request/Response Logging

**File:** `src/provider.ts`
**Severity:** P3 — Security
**Category:** Information Leakage

The `got` library can be configured to log request/response details. Ensure that:

1. Authorization headers are never logged.
2. Request/response bodies containing sensitive data are not logged.
3. The log output channel only contains safe, diagnostic information.

**Remediation:**

Audit all logging calls in the provider and ensure the `Authorization` header and API key are excluded from any debug output.

---

## 10. Testing & CI Gaps

### 10.1 — Integration Tests Only Verify Command Registration

**File:** `test/integration/extension.test.js`
**Severity:** P2 — Coverage gap
**Category:** Testing

The integration test suite (23 lines) only checks that the `manageApiKey` command is registered. It does not test:

1. Actual chat participant invocation
2. Model provider registration and model listing
3. MCP server definition provider behavior
4. End-to-end streaming
5. Tool call round-trips

**Remediation:**

Expand integration tests to cover:

| Test                  | Description                                               |
| --------------------- | --------------------------------------------------------- |
| Provider registration | Verify `z` vendor appears in model picker                 |
| Chat participant      | Verify `@z` is listed in chat participants                |
| MCP definitions       | Verify MCP servers are discoverable (with mocked API key) |
| Command execution     | Verify `z-chat.manageApiKey` opens input box              |

### 10.2 — No Test for Tool Call ID Mapping Edge Cases

**File:** `src/provider.test.ts`
**Severity:** P3 — Coverage gap
**Category:** Testing

While the test suite covers basic bidirectional ID mapping, it should also cover:

1. ID collision handling (when two different VS Code IDs map to the same Z ID)
2. Large numbers of concurrent tool calls
3. ID mapping cleanup after tool call completion
4. Memory leaks from unbounded ID map growth

---

## 11. Prioritized Remediation Roadmap

### Phase 1 — Critical Fixes (Days 1–2)

| #   | Issue                                               | Effort | Impact                         |
| --- | --------------------------------------------------- | ------ | ------------------------------ |
| 3.1 | Fix Vision MCP server endpoint (HTTP → stdio)       | 1h     | Unblocks Vision MCP            |
| 3.2 | Forward tool calls in chat participant handler      | 30min  | Unblocks tool calling via @z   |
| 3.3 | Fix history reconstruction for tool interactions    | 1h     | Fixes multi-turn tool context  |
| 3.4 | Delete dead `mcp-servers.ts` file                   | 15min  | Removes maintenance hazard     |
| 4.1 | Fix `McpHttpServerDefinition` constructor signature | 30min  | Future-proofs MCP registration |

### Phase 2 — High Priority (Days 3–5)

| #   | Issue                                                 | Effort | Impact                            |
| --- | ----------------------------------------------------- | ------ | --------------------------------- |
| 4.3 | Add `LanguageModelError` handling in chat participant | 1h     | Better error UX                   |
| 4.4 | Split `provider.ts` into focused modules              | 4h     | Major maintainability improvement |
| 4.5 | Fix token counting for multimodal messages            | 1h     | Accurate context reporting        |
| 4.6 | Add `imageInput` capability for vision models         | 1h     | Enables image attachments         |
| 5.4 | Fix `logOutputChannel` type safety bypass             | 15min  | Type safety                       |
| 5.5 | Fix `iconPath` type safety bypass                     | 15min  | Type safety                       |

### Phase 3 — Medium Priority (Days 6–10)

| #    | Issue                                                | Effort | Impact                    |
| ---- | ---------------------------------------------------- | ------ | ------------------------- |
| 5.1  | Add `disambiguation` for chat participant            | 1h     | Better discoverability    |
| 5.2  | Add slash commands                                   | 2h     | Power user workflows      |
| 5.6  | Add follow-up provider                               | 1h     | Better conversation UX    |
| 5.8  | Add `when` clause for chat participant               | 30min  | Conditional availability  |
| 5.9  | Evaluate `LLMStreamProcessor` for stream processing  | 3h     | Code simplification       |
| 5.10 | Document token count estimation inaccuracy           | 30min  | Transparency              |
| 7.1  | Evaluate custom MCP enable/disable vs VS Code native | 2h     | UX consistency            |
| 8.3  | Verify `silent` mode handling                        | 1h     | API compliance            |
| 8.4  | Add `toolCalling` capability metadata                | 30min  | Tool routing optimization |
| 10.1 | Expand integration tests                             | 4h     | Coverage improvement      |

### Phase 4 — Low Priority / Polish (Days 11–15)

| #    | Issue                                                   | Effort | Impact                |
| ---- | ------------------------------------------------------- | ------ | --------------------- |
| 5.3  | Evaluate `@vscode/prompt-tsx` adoption                  | 3h     | Prompt management     |
| 5.7  | Consider initial `onDidChangeMcpServerDefinitions` fire | 30min  | Timing                |
| 6.2  | ✅ Endpoint mode and base URL override implemented       | —      | Configuration UX      |
| 6.3  | Add retry logic for HTTP client                         | 2h     | Resilience            |
| 6.4  | Move `dotenv` to devDependencies                        | 15min  | Bundle size           |
| 6.5  | Remove `onStartupFinished` activation event             | 30min  | Startup performance   |
| 6.6  | Verify model family and version metadata                | 30min  | Metadata completeness |
| 7.2  | Add MCP server version metadata                         | 15min  | Version tracking      |
| 9.1  | Audit API key handling in MCP headers                   | 1h     | Security review       |
| 9.2  | Audit API key validation                                | 1h     | Security review       |
| 9.3  | Audit logging for information leakage                   | 1h     | Security review       |
| 10.2 | Add edge case tests for tool call ID mapping            | 1h     | Coverage improvement  |

---

## Appendix A: Reference Documentation Used

| Source                                          | URL                                                                                  |
| ----------------------------------------------- | ------------------------------------------------------------------------------------ |
| VS Code — Language Model Tools API              | <https://code.visualstudio.com/api/extension-guides/ai/tools>                        |
| VS Code — Chat Participant API                  | <https://code.visualstudio.com/api/extension-guides/ai/chat>                         |
| VS Code — Language Model Chat Provider API      | <https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider> |
| VS Code — Language Model API                    | <https://code.visualstudio.com/api/extension-guides/ai/language-model>               |
| VS Code — MCP Developer Guide                   | <https://code.visualstudio.com/api/extension-guides/ai/mcp>                          |
| Z.ai — Zread MCP Server                         | <https://docs.z.ai/devpack/mcp/zread-mcp-server>                                     |
| Z.ai — Web Reader MCP Server                    | <https://docs.z.ai/devpack/mcp/reader-mcp-server>                                    |
| Z.ai — Web Search MCP Server                    | <https://docs.z.ai/devpack/mcp/search-mcp-server>                                    |
| Z.ai — Vision MCP Server                        | <https://docs.z.ai/devpack/mcp/vision-mcp-server>                                    |
| Z.ai — Using GLM-5.1 in Coding Agent            | <https://docs.z.ai/devpack/using5.1>                                                 |
| Z.ai — Best Practices                           | <https://docs.z.ai/devpack/resources/best-practice>                                  |
| Z.ai — API Introduction                         | <https://docs.z.ai/api-reference/introduction#api-endpoint>                          |
| `@selfagency/llm-stream-parser` — API Reference | <https://llmstreamparser.self.agency/api.html>                                       |
