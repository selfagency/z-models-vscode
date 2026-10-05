# Z.ai for Copilot — Modernization Plan (v0.3.0)

**Date:** 2026-10-05
**Current:** v0.2.1 (tagged) / package.json says `0.2.0` (drift)
**Live models:** coding + general endpoints both return 11 models, incl. `glm-5.3`, `glm-5.3-flash`, `glm-5.3-flashx`

## Evidence gathered

| Source | Result |
|---|---|
| GitHub issues #15–#23 | 6 total: 3 open (#20, #21, #23), 3 closed (#12, #15, #16) |
| Marketplace API | 5,046 installs, 3 ratings, 3.67 avg / 4.54 weighted. Listing rendered client-side; review text not served by any public endpoint |
| Marketplace review (Shichao Liu, 10h old) | *"This is essentially a pure DDoS client. It creates a usage-query widget every minute, causing the number of query requests to continually increase."* (ZH: 纯粹的DDOS Client，会每1分钟创建一个用量查询控件，查询请求会越来越多) — **independent confirmation of RC-2 from a second reporter, on a public surface** |
| `GET /api/{coding/,}paas/v4/models` | Live probe with repo `.env` key: 11 ids, objects `{id, object, created, owned_by}` only |
| `GET /.../models/glm-5.3` | `{"id":"glm-5.3","object":"model","created":...,"owned_by":"z-ai"}` — **no `context_window`, no `max_tokens`** |
| `POST /.../tokenizer` | `{"error":{"code":"1113","message":"Insufficient balance..."}}` |
| `GET /api/monitor/usage/quota/limit` | Works. `level:"lite"`, limits = `{3,5h} {6,1w} TOKENS_LIMIT` + `{5,1mo} TIME_LIMIT` |
| `@agentsy/*` npm | `core@0.2.0`, `providers@0.2.0`, `context@0.2.4`, `types@0.1.1` published. **`vscode`, `processor`, `normalizers`, `structured`, `agent`, `ag-ui` NOT published** |
| `@selfagency/llm-stream-parser` | `0.3.1`, **DEPRECATED** — "superseded by `@agentsy/processor` and companion packages" |
| `../opilot` | Uses `@agentsy/core/processor` (`LLMStreamProcessor`) + `@agentsy/providers/normalizers` (`normalizeOllamaChatChunk`), wired at `src/provider.ts:790-926` |

## Root causes (verified in code, not inferred)

### RC-1 — Token limits can never come from the API (issues #12, #21)
`src/provider.ts:1231 fetchModelTokenLimits()` calls `GET {baseUrl}/models/{id}` and reads
`response.context_window` / `max_completion_tokens` / `max_tokens`. **Z.ai returns none of those fields.**
Every call falls into the `catch` (404 → `got` throws) → `getKnownTokenLimits(modelId)`.

`KNOWN_MODEL_TOKEN_LIMITS` (`provider.ts:147`) is therefore the *only* source of truth, and it is stale:
- `glm-5.3` → `200_000` (docs: **1M** context, 128K out)
- `glm-5.3-flash` → **absent entirely**
- `glm-5.3-flashx` → **absent entirely**

Absent key → `{}` → `fetchModels` line 1332 falls through to `?? 32768`. So VS Code plans a 32K window for
the flash models and compacts constantly. **This is issue #21 verbatim.**

### RC-2 — Status bar + timer leak (issue #20)
`src/agentsy-native.ts:624 UsageStatusBar.show()`:
```ts
const item = vscode.window.createStatusBarItem(...);  // new item every call
this.statusBarItem = item;
this.disposables.push(item);                          // grows forever
await this.refresh();
this.startAutoRefresh();                              // overwrites refreshTimer
```
`startAutoRefresh()` (`:688`) assigns `this.refreshTimer = setInterval(...)` with no guard, so the previous
interval is orphaned and only the last one is clearable by `dispose()`.

`src/extension.ts:266 refreshUsage()` calls `await usageBar.show()` on **every** 5-minute tick
(`zModels.usage.refreshInterval`), on API-key change, and on `Z: Refresh Usage Stats`. Each `show()` adds
one status bar item + one 60s interval; each interval calls `refreshQuota()` → `UsageService.fetchUsage()`
→ **4 parallel HTTP requests** (`usage-service.ts:106`). After N hours: N×4 orphaned timers.

Reported network symptom (~2,200 extension-host connections) is consistent with ~121 `show()` calls.

**Corroborated by two independent reporters on two surfaces.** Issue #20 (mitchcapper, 2026-08-27) and the
Marketplace review (Shichao Liu) describe the same accumulation from different vantage points: the issue
reports duplicated *status bar items*; the review reports duplicated *polling cadence*. Same cause,
`show()` being called on every refresh tick. Amplification math: each orphaned 60 s timer fires
`refreshQuota()` → `fetchUsage()` → 4 HTTP requests, so N widgets cost N×4 requests/minute and the curve
is linear in uptime. This is now the highest-severity item in the plan — it is a self-inflicted outbound
request flood against the user's own Z.ai quota, and it also burns Coding Plan credits.

**Fix ordering constraint:** A5 (idempotent `show`) is the single highest-leverage change in this plan.
A7/A8 reduce baseline cost; neither stops the accumulation. Ship A5 first even if nothing else lands.

### RC-3 — Status bar is not clickable; README advertises a dead control (issue #20, comment 1)
`UsageStatusBarConfig.onClickRefresh` (`agentsy-native.ts:606`) is declared but **never set** by
`extension.ts`, so `item.command` is never assigned. The config even hardcodes
`'agentsy.refreshUsage'` (`:630`) — a command this extension does not register.

The Marketplace README states: *"Click the status bar item to toggle between hourly and weekly views."*
That is a documented feature that does nothing. Verified: `onClickRefresh` appears only in
`agentsy-native.ts`; `extension.ts` never passes it. Hourly/weekly toggling is reachable only from the
palette via `Z: Toggle Usage View`.

### RC-4 — MCP Web Search endpoint is stale
`src/mcp-server-definition-provider.ts:11` → `https://api.z.ai/api/mcp/web_search/sse`
Docs → `https://api.z.ai/api/mcp/web_search_prime/mcp`, tool renamed `webSearch` → **`webSearchPrime`**.
Reader and Zread URLs still match docs.

### RC-5 — `Z: Manage Settings` is a stub (issue #15 follow-up)
`extension.ts:132` shows a hardcoded info string. Users reported it as the path to fix a broken key.
No settings UI, no key validation, no quota/plan visibility.

### RC-6 — `agentsy-native.ts` is a vendored fork
898 lines re-implementing `ApiKeyManager`, `createVSCodeAgentLoop`, `UsageStatusBar`, MCP helpers.
`@agentsy/vscode` is **not on npm** — hence the fork (`agentsy-adoption-plan.md:33` is stale on this point).
Meanwhile `plans/upgrade.plan.md:128` still prescribes `LLMStreamProcessor`, which `opilot` already does.

### RC-7 — Missing models + wrong vision metadata
`fetchModels` curated fallback (`:1299`) lists only `glm-5.1`. `inferVisionFromModelId`
(`model-info.ts:25`) does not match `glm-5.3-flash`, the first natively-multimodal model in the GLM-5 line.
`getVisionFallbackModelId()` prefers `glm-4.6v`, which the coding endpoint no longer lists.

### RC-8 — Vision MCP pinned below latest
`VISION_MCP_ARGS = ['-y', '@z_ai/mcp-server@0.1.4']`; `0.1.5` is published. Docs require `>=0.1.2`
for GLM-5.3-Flash capability, so 0.1.4 is functional but not current.

### RC-9 — Version drift
`package.json.version = 0.2.0`, tag `v0.2.1` exists, marketplace serves `0.2.1`. Commit `92c0f78`
claimed to align this and did not land.

### RC-10 — README drift
**RETRACTED.** Verified against `git show HEAD:README.md`: both requirement lines already read
`1.120.0`, and the feature list already says "including Coding Plan and general Z.ai API endpoints".
The `1.109.0` / "intentionally scoped to coding" text came from a stale search-engine cache of the
GitHub page, not from the repository. No README change needed for the version.

---

## Work plan

Legend: **P0** ships first (user-visible breakage), **P1** next, **P2** cleanup.

### Phase A — P0 correctness (issue #21, #12, #20)

**A1. Stop pretending `/models/{id}` returns limits.** *(provider.ts:1227-1271)*
Delete the `context_window`/`max_completion_tokens` branch. Keep a single, auditable table. It is the
only thing that ever worked.

**A2. Rewrite `KNOWN_MODEL_TOKEN_LIMITS` from live data + docs.** *(provider.ts:147-178)*

| model | maxInputTokens | maxOutputTokens | source |
|---|---|---|---|
| `glm-5.3` | 1_000_000 | 128_000 | docs.glm-5.3 §Feature Changes |
| `glm-5.3-flash` | 1_000_000 | 128_000 | docs glm-5.3-flash overview |
| `glm-5.3-flashx` | 1_000_000 | 128_000 | same family |
| `glm-5.2` | 1_000_000 | 128_000 | keep |
| `glm-5.1`, `glm-5`, `glm-5-turbo` | 200_000 | 128_000 | keep |
| `glm-4.7*` | 200_000 | 128_000 | keep |
| rest | unchanged | | |

Add a `// Verified 2026-10-05 against docs + live /models` header and a **doc URL per family**, so the
next refresh has a target. Also add `glm-5v-turbo` (already present) left alone.

**A3. Normalize model IDs before lookup.** `getKnownTokenLimits` does exact lowercase match, so
`glm-5.3-flash` never matches a `glm-5.3` entry. Add suffix-aware fallback: try exact, then longest
prefix family (`glm-5.3` → `glm-5.3-flash`), then `{}`. Handle `[1m]` suffix by stripping it.

**A4. Add a CI guard against silent window shrinkage.** New test: for every id in
`KNOWN_MODEL_TOKEN_LIMITS` and every id the live endpoint is documented to return, assert
`maxInputTokens >= 200_000`. Fails the build if a future edit drops a model to the `32768` default.

**A5. Fix the `UsageStatusBar` leak.** *(agentsy-native.ts:616-701)*
- `show()`: reuse `this.statusBarItem` if set; do not push a second disposable.
- `startAutoRefresh()`: `if (this.refreshTimer !== undefined) return;`
- `stopAutoRefresh()` on `hide()` so a hidden bar stops polling.
- `dispose()`: null the item field after disposing.

**A6. Stop double-fetching.** `extension.ts:279-280` calls `show()` (which refreshes) then `refresh()`
immediately. Drop the explicit `refresh()`; `show()` already returns the quota.

**A7. Collapse the two timers.** There are two independent schedules: 5 min (`zModels.usage.refreshInterval`)
and 60 s (internal `refreshIntervalMs`). Pick one. **Recommendation:** keep the single internal 60 s timer,
delete `usageRefreshTimer` and the `setInterval` in `extension.ts` entirely, and drive everything from
`Z: Refresh Usage Stats` + secrets change. Fewer moving parts, and the 4-request fan-out becomes affordable
at 60 s only if we also do A8.

**A8. Cut `fetchUsage()` from 4 requests to 1.** *(usage-service.ts:106-117)*
`quota/limit` is the only call the status bar uses. The three `model-usage` calls feed `UsageData`
fields **nothing renders** — `extension.ts:226-253` reads `tokenQuotas` only. Fetch `quota/limit`, drop
the other three, delete `todayPrompts`/`sevenDay*`/`thirtyDay*` from `UsageData`. If daily/weekly token
stats are wanted later, expose them deliberately.

**A9. Also drop the double auth-format retry.** `fetchEndpoint` tries raw key then `Bearer <key>`.
Verified live: `Bearer` works, raw does not. Remove the loop, use `Bearer` once.

**A10. Fix the missing `onClickRefresh`.** *(extension.ts:255-261)*
Set `onClickRefresh: () => toggleUsageView()` and register the toggle once as a local closure, so the
status bar item becomes clickable and hourly/weekly toggling works from the UI (issue #20, comment 1).
Also widen the status bar text to show the real window (`5-Hour` / `1-Week`) — `mapWindow` currently
labels `unit===3` as `'hourly'` when it is a 5-hour window.

### Phase B — P1 endpoints & capability accuracy

**B1. Move Web Search MCP to `web_search_prime`.** *(mcp-server-definition-provider.ts:11)*
URL → `https://api.z.ai/api/mcp/web_search_prime/mcp`. Note in a comment that the exposed tool is
`webSearchPrime`, and make `VISION_MCP_TOOL_NAME_PATTERN` / `findVisionMcpToolName` aware of both old and
new search tool names so in-flight chat sessions keep resolving.

**B2. Unpin vision MCP to `0.1.5`.** Keep the explicit version (supply-chain hygiene, documented intent),
just move it forward.

**B3. Fix vision capability detection.** *(model-info.ts:24-26)*
`inferVisionFromModelId` must match `glm-5.3-flash` / `glm-5.3-flashx`. Docs: GLM-5.3-Flash is the first
natively multimodal model in the line; GLM-5.3 proper is text-only. So the rule is *flash-family yes,
base 5.3 no* — an inversion of the current default.

**B4. Drop the `glm-4.6v` vision fallback.** *(provider.ts:583-590)* Not in the coding model list.
Prefer `glm-5.3-flash`, then any `supportsVision`, then undefined.

**B5. Replace the curated single-model fallback.** *(provider.ts:1299-1312)* Either enumerate the live
11-model set or return `[]` and let VS Code show "no models". A stale `glm-5.1`-only list is worse than
none. **Recommendation:** return `[]`, delete the block.

**B6. Surface plan level.** The quota response carries `level: "lite"`. Show it in the tooltip
(`Pro 12,000 credits / 60,000 weekly`). Cheap, and it answers the recurring "why is my quota small"
question in the docs.

### Phase C — P1 agent surface (issues #15, #20 UX)

**C1. Make `Z: Manage Settings` real.** *(extension.ts:132)*
Replace the info string with a QuickPick: endpoint mode (`zaiCoding` / `zaiGeneral` / `bigmodel*`),
refresh interval, MCP toggles, tool toggles, plus **Validate key** (one `GET /models` call, report the
returned model count and plan level) and **Clear stored key**.

**C2. Add `Z: Reset Usage Display`.** Toggling is currently the only escape from a wedged bar.

### Phase D — P2 agentsy consolidation

**D1. `agentsy-native.ts` is a fork, not a dependency.** `@agentsy/vscode` is unpublished, so the fork
stands. Do **not** delete it. Instead:
- Extract the genuinely Z-specific pieces (`UsageStatusBar`, the MCP server table) into
  `src/usage-status-bar.ts` and `src/mcp/definitions.ts`.
- Leave `ApiKeyManager`, `createVSCodeAgentLoop`, `createMcpServerDefinitionProvider`, `McpServerRegistry`
  in one clearly-marked file with a header explaining "vendored from @agentsy/vscode because that package
  is unpublished; delete when it ships."
- This makes the fork auditable instead of looking like bespoke code.

**D2. Align the stream path with `opilot`.** `opilot` (`src/provider.ts:790-926`) instantiates
`LLMStreamProcessor` from `@agentsy/core/processor` directly and feeds it `normalizeOllamaChatChunk` output.
This repo goes through `createGenericAdapter` (providers) + a bespoke `parseTextEmbeddedToolCalls`
(`provider.ts:203-320`, 118 lines) that re-implements `<|tool_call_begin|>` parsing.

`@agentsy/core/processor` already exports `createZAiInlineToolCallParser()` and `ZAiInlineToolCallParser`
for exactly this wire format. **Plan:** replace `parseTextEmbeddedToolCalls` with the agentsy parser,
collapse `createGenericAdapter` + `ToolCallAccumulator` + the inline parser into one
`LLMStreamProcessor` instance (as `opilot` does), and delete ~150 lines of bespoke parsing.

Keep `normalizeZAiChunk` + `normalizeZAiRawChunk` (the Z.ai-specific shape shim is legitimately ours).

**D3. `@selfagency/llm-stream-parser` is deprecated and already unused here.** Confirmed: not in
`package.json`, not in `pnpm-lock.yaml`. No action. Record the fact so nobody reintroduces it.

**D4. Refresh `plans/agentsy-adoption-plan.md`.** It claims `@agentsy/vscode` is "Complete / primary"
and `@agentsy/normalizers` is a separate package. Both are wrong today (unpublished; merged into
`@agentsy/providers`).

### Phase E — P2 hygiene

**E1. Fix version drift.** Bump `package.json` to `0.3.0`, tag `v0.3.0`. `92c0f78` attempted this
and did not land.

**E2. Reconcile READMEs.** Not needed — see RC-10 retraction. `Z: Manage Settings` now opens a real
picker, so the README's settings section needs a short description of what it can change.

**E3. Add lifecycle regression tests.** The specific ones issue #20's reporter asked for:
`show()` × N → 1 item, 1 timer; `hide()` → `show()` → still 1; `dispose()` → 0 timers.
Test file: `src/tests/usage-status-bar.test.ts`.

**E4. `.fallowrc.json` `entry` points at `src/index.ts` / `src/main.ts`, which do not exist.** Dead
config; point it at `src/extension.ts` or drop the file.

---

## Issues disposition

| Issue | Title | Disposition |
|---|---|---|
| #20 | Usage bar multiplies | **A5 first, unconditionally**, then A6–A10, C2. Root-caused in code, reproduced in isolation, and independently confirmed by a Marketplace reviewer. Reporter's proposed fix matches A5. |
| #21 | Can't use max context for GLM 5.3 flash | **A1–A4.** Root cause was not "flash missing from a list" but "`/models/{id}` returns no limit fields, and flash was missing from the fallback". Fixed; table now generated from models.dev. |
| #12 | glm-5.2 shows 49K | Closed but **still broken** for flash models via the same path. A1–A4 close the class. |
| #23 | Port to Visual Studio 2026 18.10 | **Out of scope.** A separate VSIX + `VSIXManifest` migration. Not a VS Code extension bug. |
| #15 | Extension no longer loads | Closed by `check-bundle.mjs` + `noExternal`. C1 removes the misleading command that sent the user there. |
| #16 | Missing `@agentsy/core` | Closed. Guard in place. D1 must not regress `noExternal`. |

## Bugs found during implementation (not in the original plan)

| Bug | Evidence | Fix |
|---|---|---|
| Web Search MCP pointed at a dead URL | `POST /api/mcp/web_search/sse` -> **404**; `web_search_prime/mcp` -> **200** | B1 |
| `search_engine: 'search_pro_jina'` is not in the API enum | OpenAPI spec `enum: [search-prime]`; `search_pro_jina` appears only in prose | now sends `search-prime` |
| Search results read from the wrong response field | Spec field is `search_result` (singular); code read `search_results`, so the tool always reported "No search results found" | reads `search_result`, falls back to the plural |
| `usage.enabled` setting declared but never read | no read site anywhere in `src/` | now gates the status bar |
| `vitest` collected `.opencode/node_modules/zod` test files | 3 spurious suite failures | `.opencode/**` added to `test.exclude` |
| Vision fallback pointed at a model the API no longer serves | `/models` returns **no vision models at all** | B4 prefers `glm-5.3-flash` |
| Status bar click was documented but inert | `onClickRefresh` never set; the command it referenced does not exist | A10 wires `clickCommand` |

## Risks

- **The limits table is third-party.** models.dev aggregates provider metadata; Z.ai exposes none itself.
  It can be wrong or lag. Mitigation: `pnpm run models:sync` regenerates it, the file header records the
  source and verification date, and the A4 test fails if a live model stops resolving.
- **A7 changes polling cadence semantics.** The 5-minute timer is gone; `zModels.usage.refreshInterval`
  now drives the single internal timer via `setRefreshInterval`, so the setting stays functional rather
  than becoming dead. Live-tuning it restarts the interval in place.
- **B1 changes a URL users may have cached.** Copilot re-reads MCP definitions on change, and the
  `webSearch` -> `webSearchPrime` rename is a server-side tool-name change; the tool-name pattern accepts
  both forms.
- **D2 is the largest diff** (~150 lines removed, stream path rewritten). Deferred to its own PR.

## Verification

**Executed 2026-10-05, all green:**

| Gate | Result |
|---|---|
| `pnpm run check-types` | clean |
| `pnpm run lint` | clean |
| `pnpm test` | 17 files, **189 tests passed** (was 175) |
| `pnpm run compile` | `dist/extension.js` 709.90 KB; `check-bundle.mjs` confirms self-contained |

Live probes backing the fixes:

| Probe | Result |
|---|---|
| `POST /api/mcp/web_search/sse` | **404** (dead) |
| `POST /api/mcp/web_search_prime/mcp` | **200** |
| `POST /api/mcp/web_reader/mcp` | **200** |
| `POST /api/mcp/zread/mcp` | **200** |
| `GET /models` (both endpoints) | same 11 ids, no vision models, no limit metadata |
| `GET /models/glm-5.3` | `{id, object, created, owned_by}` only |
| `GET /api/monitor/usage/quota/limit` | works with `Bearer`, `level: lite`, 2 token windows |
| `GET https://models.dev/api.json` | 4 z.ai providers, `limit.context` / `limit.output` / `modalities.input` present |

**Needs a running Extension Development Host:** confirm one status bar item after an hour of uptime,
confirm the model picker reports a 1M window for `glm-5.3-flash`, click the status bar item to toggle
windows, confirm `Z: Refresh Usage Stats` does not grow the Network panel's request count.

## Deferred (not done here)

- **D1 / D2** — splitting `agentsy-native.ts` and replacing `parseTextEmbeddedToolCalls` with
  `@agentsy/core/processor`. D2 is a ~150-line stream rewrite and belongs behind its own PR after this
  one ships. The `LLMStreamProcessor` migration in `plans/upgrade.plan.md` remains unstarted.
- **`@agentsy/context`** — declared in `package.json`, imported nowhere. Safe to drop, left alone rather
  than removed inside a bugfix PR.
- **Issue #23** — Visual Studio 2026 port. Separate deliverable.
- **`plans/agentsy-adoption-plan.md`** — stale (`@agentsy/vscode` is unpublished, `@agentsy/normalizers`
  merged into `@agentsy/providers`). Left untouched pending the D2 decision.
- **README settings section** — `Z: Manage Settings` is now a real picker; its README section still
  describes the old stub.
