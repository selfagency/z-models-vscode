# Change Log

## [Unreleased]

### Production-Ready Release 🎉

This major version release brings critical stability fixes, architectural improvements, and enhanced reliability for production use.

### ✨ Features

- **Token Limit Fetching from API** - Model token limits now fetched from Z.ai API with intelligent fallback to defaults
- **Cancellation Token Support** - HTTP requests properly honor cancellation tokens, preventing UI hangs
- **VS Code 1.96+ Support** - ChatResponseTurn2 support for latest VS Code versions with graceful fallback
- **Stronger Tool Call IDs** - Tool call IDs now use 128-bit cryptographically strong `randomUUID()` instead of 64-bit entropy
- **User-Facing MCP Warning** - Clear warning message when MCP servers unavailable on older VS Code versions
- **Thinking Content Logging** - Model reasoning/thinking content now logged to output channel when available
- **Z.ai Normalizer Module** - New `src/normalizers/z-ai.ts` for SSE format normalization

### 🔧 Technical Improvements

- Added `fetchModelTokenLimits()` method to fetch token limits from `/models/{modelId}` API endpoint
- Parallel token limit fetching using `Promise.all()` for improved performance
- AbortSignal wiring throughout model fetching and streaming pipelines
- Implemented `extractResponseText()` helper for robust history message conversion
- Better error handling and logging in MCP registration flow
- Added `request_id`, `do_sample`, `stop`, and `user_id` request mapping for Z.ai chat requests
- Token counting now prefers the Z.ai tokenizer API for supported models and falls back safely when unavailable
- Cached token counts are now surfaced in usage telemetry when returned by the API
- Preserved thinking history now attaches only to the latest assistant turn in outgoing message history

### 🧪 Quality

- All 185 unit tests passing
- 64.46% code coverage maintained
- Type checking clean with zero remaining blockers
- Zero linting issues (oxlint 100%)

### 📝 Documentation

- Updated README with MCP troubleshooting section
- Clarified Coding Plan scope and endpoint usage
- Improved development setup instructions

### ⚠️ Breaking Changes

None. This release is fully backward compatible with v0.1.7.

### 🔒 Security

- No hardcoded secrets or API keys
- All authentication tokens properly scoped and stored in VS Code secrets API
- No changes to security model from previous releases

---

## [0.1.7] - 2026-04-22

## What's Changed

- refactor: improve error handling with user-friendly messages by @selfagency in <https://github.com/selfagency/z-models-vscode/pull/7>
- feat: implement endpointMode and baseUrlOverride config by @Teages in <https://github.com/selfagency/z-models-vscode/pull/8>

## New Contributors

- @Teages made their first contribution in <https://github.com/selfagency/z-models-vscode/pull/8>

**Full Changelog**: <https://github.com/selfagency/z-models-vscode/compare/v0.1.6...v0.1.7>

_Source: changes from v0.1.6 to v0.1.7._

## [0.1.6] - 2026-04-15

## What's Changed

- feat: coding-endpoint scope, MCP-first vision routing, and docs clarification by @selfagency in <https://github.com/selfagency/z-models-vscode/pull/6>

**Full Changelog**: <https://github.com/selfagency/z-models-vscode/compare/v0.1.5...v0.1.6>

_Source: changes from v0.1.5 to v0.1.6._

## [0.1.5] - 2026-04-15

## What's Changed

- fix: show all models, detect vision models, disable thinking by default by @selfagency in <https://github.com/selfagency/z-models-vscode/pull/5>

**Full Changelog**: <https://github.com/selfagency/z-models-vscode/compare/v0.1.4...v0.1.5>

_Source: changes from v0.1.4 to v0.1.5._

## [0.1.4] - 2026-04-14

## What's Changed

- feat: add Z.ai usage status bar with hourly/weekly toggle and quota UX improvements by @selfagency in <https://github.com/selfagency/z-models-vscode/pull/4>

**Full Changelog**: <https://github.com/selfagency/z-models-vscode/compare/v0.1.3...v0.1.4>

_Source: changes from v0.1.3 to v0.1.4._

## What's Changed

- feat: add Z.ai usage status bar item with auto-detected plan and quota polling
- refactor: simplify usage status bar UX (right-side placement, hourly/weekly toggle, simplified tooltip)
- fix: ensure 5-hour and weekly percentages use distinct quota windows

## [0.1.3] - 2026-04-14

## What's Changed

- fix: use documented GLM context window fallbacks by @selfagency in <https://github.com/selfagency/z-models-vscode/pull/3>

**Full Changelog**: <https://github.com/selfagency/z-models-vscode/compare/v0.1.2...v0.1.3>

_Source: changes from v0.1.2 to v0.1.3._

## [0.1.2] - 2026-04-14

## What's Changed

- feat: complete remediation plan implementation and validation by @selfagency in <https://github.com/selfagency/z-models-vscode/pull/2>

**Full Changelog**: <https://github.com/selfagency/z-models-vscode/compare/v0.1.1...v0.1.2>

_Source: changes from v0.1.1 to v0.1.2._

## [0.1.1] - 2026-04-14

## What's Changed

- fix: align Z API integration, streaming tool calls, and activation resilience by @selfagency in <https://github.com/selfagency/z-models-vscode/pull/1>

## New Contributors

- @selfagency made their first contribution in <https://github.com/selfagency/z-models-vscode/pull/1>

**Full Changelog**: <https://github.com/selfagency/z-models-vscode/compare/v0.1.0...v0.1.1>

_Source: changes from v0.1.0 to v0.1.1._

## [0.1.0] - 2026-04-14

**Full Changelog**: <https://github.com/selfagency/z-models-vscode/commits/v0.1.0>
