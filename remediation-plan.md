# Plan: Z Models VS Code Remediation

Bring the extension into alignment with current VS Code AI extensibility + Z.ai guidance by fixing contribution points, implementing real MCP server definition registration, normalizing endpoint behavior, and reconciling tests/docs with actual runtime behavior.

## Steps

1. **Phase 1 — Manifest + activation contract hardening (blocking)**
   1. Update package.json with missing contributions:
      - `contributes.languageModelChatProviders` (vendor `z`, optional `managementCommand`)
      - `contributes.chatParticipants` (id `z-models-vscode.z`)
      - `contributes.commands` for `z-chat.manageApiKey`
      - `contributes.mcpServerDefinitionProviders` (new MCP provider id)
   2. Replace legacy MCP activation events (`onModelContextProvider:*`) with current, matching activation strategy.
   3. Ensure all IDs match exactly between package.json and extension.ts.

2. **Phase 2 — Replace MCP placeholders with supported MCP registration (depends on 1)**
   1. Add `/Users/daniel/Developer/z-models-vscode/src/mcp-server-definition-provider.ts`.
   2. Implement `vscode.lm.registerMcpServerDefinitionProvider` contract:
      - `onDidChangeMcpServerDefinitions`
      - `provideMcpServerDefinitions`
      - `resolveMcpServerDefinition`
   3. Emit HTTP MCP definitions from settings toggles:
      - Search: `https://api.z.ai/api/mcp/web_search_prime/mcp`
      - Reader: `https://api.z.ai/api/mcp/web_reader/mcp`
      - Zread: `https://api.z.ai/api/mcp/zread/mcp`
      - Vision: use documented strategy (HTTP/stdio mode decision below)
   4. Remove or retire placeholder logic in mcp-servers.ts.
   5. Register new MCP provider in extension.ts.

3. **Phase 3 — Endpoint/provider normalization (parallel with Phase 2 except final wiring)**
   1. Add endpoint settings in package.json, e.g.:
      - `zModels.api.endpointMode` (`zaiGeneral`, `zaiCoding`, `bigmodel`)
      - `zModels.api.baseUrlOverride` (optional)
   2. Update provider.ts to derive base URL from settings in both init paths.
   3. Keep secure secrets flow and align UX strings with selected endpoint mode.
   4. Decide model strategy:
      - dynamic discovery, or
      - curated list + explicit documentation.

4. **Phase 4 — Chat participant and tool-calling correctness (depends on 1–3)**
   1. Validate participant metadata parity (manifest vs runtime).
   2. Re-check tool-call/result mapping and capabilities in provider.ts.
   3. Ensure error handling is actionable and non-sensitive.

5. **Phase 5 — Test remediation + CI green (depends on 1–4)**
   1. Fix missing API mocks in vscode.mock.ts (notably `workspace.getConfiguration`).
   2. Refactor provider for injection-friendly testability if needed (config reader/client factory).
   3. Update tests:
      - provider.test.ts
      - extension.test.ts
      - add MCP provider tests
   4. Validate:
      - `pnpm run compile`
      - `pnpm test`
      - `pnpm run test:extension` (where supported)

6. **Phase 6 — Documentation truth alignment (parallel after 3 stabilizes)**
   1. Update README.md claims to match implemented behavior.
   2. Document endpoint mode semantics + setup.
   3. Document MCP requirements, quotas, and vision caveats.
   4. Add troubleshooting for API key, endpoint mismatch, MCP auth/config, and quota exhaustion.

## Relevant files

- package.json
- extension.ts
- provider.ts
- mcp-servers.ts
- `/Users/daniel/Developer/z-models-vscode/src/mcp-server-definition-provider.ts` (new)
- vscode.mock.ts
- provider.test.ts
- extension.test.ts
- README.md

## Verification

1. Runtime IDs and manifest IDs are fully consistent.
2. Provider appears in model picker; `@z` participant appears and responds.
3. MCP servers are listed/managed via MCP UI and respect settings toggles.
4. Unit + compile pass; integration test command passes in supported environment.
5. README behavior claims match actual implementation.

## Decisions to lock before implementation

- Vision MCP mode: HTTP-only first vs optional stdio mode.
- Model strategy: true dynamic discovery vs curated list.
- Default endpoint: recommend `https://api.z.ai/api/coding/paas/v4` for this extension’s coding-focused use case, with override support.
