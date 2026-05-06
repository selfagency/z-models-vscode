# Agentsy package adoption plan

**Repository:** `selfagency/z-models-vscode`
**Scope:** Review of the published Agentsy package surface at `https://agentsy.self.agency/packages.html`
**Goal:** Make the extension use the right Agentsy layer for each responsibility without forcing unnecessary abstraction

---

## What the catalog says

Agentsy currently exposes these relevant package layers:

- **Integration layer:** `@agentsy/vscode`
- **Runtime / orchestration:** `@agentsy/processor`, `@agentsy/normalizers`, `@agentsy/agent`, `@agentsy/adapters`, `@agentsy/renderers`
- **Core parsing / shaping:** `@agentsy/thinking`, `@agentsy/tool-calls`, `@agentsy/structured`, `@agentsy/context`, `@agentsy/formatting`, `@agentsy/recovery`, `@agentsy/xml-filter`, `@agentsy/sse`, `@agentsy/types`
- **State / protocol:** `@agentsy/ui`, `@agentsy/ag-ui`

The extension should treat `@agentsy/vscode` as the integration shell and adopt lower-level packages only where they remove bespoke parsing, state, or rendering code.

The linked source trees show the split clearly:

- `packages/normalizers/src/zai.ts` contains the Z.ai-specific normalizer.
- `packages/adapters/src/adapters/*` contains generic integration helpers, including OpenAI-compatible adapter helpers, not Z.ai-specific parsing.

So the correct question is not “does `adapters` contain Z.ai code?” but “can the generic adapter layer help this repo package its stream pipeline more cleanly?”

---

## Current adoption status

| Package | Status | Current use in repo | Assessment | Next step |
|---|---|---|---|---|
| `@agentsy/vscode` | Complete / primary | `ApiKeyManager`, `cancellationTokenToAbortSignal`, `createVSCodeAgentLoop`, usage helpers, MCP integration helpers | Correct layer for the extension. This package is the flagship integration surface and now owns the VS Code-specific loop rendering path in the provider. | Keep as the integration boundary; `BaseLanguageModelChatProvider` remains optional unless we want a larger provider-shell refactor. |
| `@agentsy/normalizers` | Complete | `normalizeZAiChunk` | Correctly used for provider-specific stream normalization. | Keep. Add tests when new Z.ai chunk shapes appear. |
| `@agentsy/processor` | Complete (via adapters) | Used through `@agentsy/adapters` in provider stream handling | Correctly consumed through adapter boundary instead of bespoke processor wiring in provider code. | Keep this layered usage unless we need direct event hooks beyond adapter callbacks. |
| `@agentsy/adapters` | Complete | `createGenericAdapter` is now used directly in provider stream handling | Generic integration wrapper layer now actively used to package normalized chunk processing and tag/tool parsing behavior. | Keep and expand only if we later adopt raw-stream helper paths too. |
| `@agentsy/tool-calls` | Not adopted yet | No direct use | Good fit for native tool-call accumulation and tool payload helpers. | Adopt `ToolCallAccumulator` and `buildToolResultMessage` where they replace manual payload assembly/state. |
| `@agentsy/structured` | Not adopted yet | No direct use | Useful for JSON parsing/repair and schema validation, especially around tool arguments. | Use `parseJson` / validation helpers if we want to replace local `JSON.parse` recovery logic. |
| `@agentsy/thinking` | Not adopted yet | No direct use | Useful if we centralize reasoning extraction instead of handling it inline. | Adopt if the processor pipeline is reintroduced and we want tagged-thinking extraction as a dedicated concern. |
| `@agentsy/formatting` | Indirect only | Used internally by `@agentsy/vscode` | Fits presentation-safe content shaping. | No direct adoption needed unless we build custom rendering paths again. |
| `@agentsy/renderers` | Indirect only | Used internally by `@agentsy/vscode` | Shared renderer primitives are already covered by the VS Code integration layer. | No direct adoption needed for the current extension shape. |
| `@agentsy/context` | Deferred | No direct use | Helpful for XML-context prompt hygiene, not a current blocker. | Defer unless prompt/context tag handling becomes a feature. |
| `@agentsy/agent` | Deferred | No direct use | Best for multi-step loops and stop-condition orchestration. | Defer until the extension intentionally becomes more agentic / loop-driven. |
| `@agentsy/ui` | Deferred | No direct use | Conversation store and processor binding helpers are not needed yet. | Defer unless we add stateful conversation visualization or store-driven workflows. |
| `@agentsy/ag-ui` | Deferred | No direct use | AG-UI bridge utilities are out of scope for the current extension. | Defer. |

---

## Full Agentsy implementation target

If the goal is a *full* Agentsy implementation, the intended stack is:

1. **`@agentsy/normalizers`** for provider wire-format normalization.
2. **`@agentsy/processor`** for event-driven stream orchestration.
3. **`@agentsy/tool-calls`** for native tool accumulation and tool-result shaping.
4. **`@agentsy/adapters`** when we want to package the provider-facing glue behind a reusable adapter boundary.
5. **`@agentsy/vscode`** for the VS Code integration shell, including its own `createVSCodeChatRenderer`, `createVSCodeAgentLoop`, `ApiKeyManager`, and `BaseLanguageModelChatProvider` helpers.

That means “full use” does **not** mean every package must be used directly in the extension entry point. It means each layer should be used where it belongs:

- `vscode` owns the VS Code integration boundary.
- `adapters` owns reusable provider-facing glue.
- `agent` owns iterative loop behavior when the extension needs multi-step orchestration.
- `processor` / `normalizers` / `tool-calls` own the lower-level stream and payload mechanics.

For the extension itself, the practical goal is to use `@agentsy/vscode` plus the lower layers only when they replace bespoke code, not to mirror the package graph mechanically.

---

## Recommended adoption order

### 1) Lock in the integration boundary

Keep `@agentsy/vscode` as the extension-facing layer for:

- API key management
- cancellation conversion
- usage/status helpers
- MCP integration helpers
- VS Code chat rendering helpers

This is already the right package for a VS Code extension. The main remaining question is whether the provider shell itself should be refactored to extend `BaseLanguageModelChatProvider`.

### 2) Decide whether to keep or remove bespoke stream orchestration

The repo currently still contains provider-specific stream handling for Z.ai chunk shapes, tool-call accumulation, and reasoning emission.

If we want to reduce custom code, the next best adoption step is:

- use `@agentsy/normalizers` for provider payload normalization
- use `@agentsy/processor` for incremental event orchestration
- use `@agentsy/adapters` if we want to package the provider-facing normalization + processor glue behind a reusable boundary
- use `@agentsy/thinking` for reasoning extraction
- use `@agentsy/tool-calls` for native tool-call accumulation and tool-result message construction

For a full Agentsy implementation, the preferred layering is:

- normalize at the boundary
- process in the middle
- adapt where the provider API needs packaging
- render through `@agentsy/vscode` or a VS Code-specific loop if that simplifies the shell

If we keep the bespoke Z.ai flow, that is acceptable too — but then the adoption plan should clearly treat those packages as optional upgrades, not missing requirements.

### 3) Adopt tool-call helpers where they remove manual state

`@agentsy/tool-calls` is the most obvious remaining win.

Best candidates:

- replace the manual native tool-call accumulator with `ToolCallAccumulator`
- use `buildNativeToolsArray` when converting tool schemas into provider-native payloads
- use `buildToolResultMessage` when generating tool-result messages for provider-agnostic code paths
- use `extractXmlToolCalls` only if XML / Hermes-style tool prompting becomes a supported mode

Important: this repo should **not** force XML tool prompting just because the package exists. Z.ai native tool calls are the primary path, so the package should be adopted only where it helps native or generic tool handling.

### 4) Pull in structured parsing only if it replaces custom repair logic

`@agentsy/structured` is useful if we want to replace local JSON repair helpers with package-backed parsing and schema validation.

That is a good fit for:

- tool-call argument parsing
- malformed JSON recovery
- structured-response validation

### 5) Defer agentic state packages until the UX needs them

`@agentsy/agent`, `@agentsy/ui`, and `@agentsy/ag-ui` are all valid packages, but they are not necessary for the current extension shape.

Use them only if we intentionally move toward:

- multi-step tool-use loops
- shared conversation state stores
- AG-UI protocol bridging
- more agent-like orchestration in the extension UI

### 6) Keep Z.ai adapter usage honest

There is **not** a Z.ai-specific adapter entry in the published `@agentsy/adapters` surface. The Z.ai-specific package is `@agentsy/normalizers` (`normalizeZAiChunk`).

That means the practical adoption pattern for this repo is:

- Z.ai wire format → `@agentsy/normalizers`
- stream orchestration → `@agentsy/processor`
- optional packaging of the above behind a generic integration boundary → `@agentsy/adapters`

So `@agentsy/adapters` is useful, but it is not the place where Z.ai-specific normalization lives.

---

## What is complete vs remaining

### Complete now

- `@agentsy/vscode` is the correct integration package and is already used for the extension shell
- `@agentsy/normalizers` is already used for Z.ai stream normalization
- `@agentsy/adapters` is now used directly as the provider-facing integration wrapper layer
- `createVSCodeAgentLoop` is now used directly for VS Code-oriented loop rendering in provider streaming
- `@agentsy/renderers` and `@agentsy/formatting` are covered indirectly through the VS Code renderer layer
- `@agentsy/context`, `@agentsy/agent`, `@agentsy/ui`, and `@agentsy/ag-ui` are correctly deferred for now

### Still remaining

- adopt `@agentsy/tool-calls` where it can replace custom tool-call state
- consider `@agentsy/structured` if it can remove custom JSON repair code
- consider `@agentsy/thinking` only if reasoning extraction becomes a standalone concern again
- decide whether the provider should migrate to `BaseLanguageModelChatProvider` or keep the current bespoke provider shell
- decide whether to adopt lower-level `@agentsy/agent` loops in addition to `createVSCodeAgentLoop` for future multi-step orchestration needs

---

## Suggested decision rule

Use a package only when it does one of these better than the current code:

1. reduces custom parsing state
2. removes brittle stream glue
3. improves VS Code integration safety
4. makes the provider easier to test or extend
5. preserves Z.ai-specific behavior without extra complexity

If a package does not clearly improve one of those axes, defer it.
