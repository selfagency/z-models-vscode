# Z for Copilot

[![Tests](https://github.com/selfagency/z-models-vscode/actions/workflows/ci.yml/badge.svg)](https://github.com/selfagency/z-models-vscode/actions/workflows/ci.yml) [![codecov](https://codecov.io/gh/selfagency/z-models-vscode/graph/badge.svg?token=0gHudqeY4p)](https://codecov.io/gh/selfagency/z-models-vscode)

<p align="center">
  <img src="logo.png" alt="Z.ai Logo" width="128" height="auto">
</p>

<p align="center">
  <strong>Access Z.ai (Zhipu) models within GitHub Copilot Chat</strong>
</p>

<p align="center">
  <a href="https://z.ai">🌐 Z.ai</a> •
  <a href="https://docs.z.ai/api-reference">📖 API Docs</a> •
  <a href="https://z.ai/manage-apikey/apikey-list">🔑 Get API Key</a>
</p>

## ✨ Features

- 🧠 **All Z Models** - Every Z chat-capable model fetched dynamically from the API
- 🔀 **Model Picker** - Select Z models via the model selector dropdown on any Copilot Chat conversation
- 💬 **Chat Participant** - Invoke `@z` directly in Copilot Chat for a dedicated, history-aware Z conversation
- 🔧 **Tool Calling** - Function calling support for agentic workflows
- 🖼️ **Vision** - Image input support for models that support it
- 🔒 **Secure** - API key stored using VS Code's encrypted secrets API
- ⚡ **Streaming** - Real-time response streaming for faster interactions

## 🔧 Requirements

- **VS Code** 1.109.0 or higher
- **GitHub Copilot Chat** extension installed
- A valid **Z.ai API key**

## 🚀 Installation

1. **Install from VS Code Marketplace** (or install the `.vsix` file)
2. **Open Command Palette** (`Ctrl+Shift+P` / `Cmd+Shift+P`)
3. **Run:** `Z: Manage API Key`
4. **Enter your API key** from [z.ai](https://z.ai/manage-apikey/apikey-list)

## 🔑 Getting Your API Key

1. Go to [Z.ai Console](https://z.ai/manage-apikey/apikey-list)
2. Sign up or log in with your account
3. Navigate to **API Keys** section
4. Click **Create new key**
5. Copy the key and paste it into VS Code when prompted

## 💬 Usage

### Model Picker

To use a Z model in an existing Copilot Chat conversation without the `@z` handle:

1. Open **GitHub Copilot Chat** panel in VS Code
2. Click the **model selector** dropdown
3. Choose a **Z.ai** model
4. Start chatting!

### Chat Participant

Type `@z` in any Copilot Chat input to direct the conversation to Z.ai. The participant is sticky — once invoked, it stays active for the thread.

```text
@z explain the architecture of this project
```

### Advanced `modelOptions` support

This provider supports the following `modelOptions` keys (used internally by VS Code model requests and useful for extension contributors):

- `temperature: number`
- `topP: number`
- `safePrompt: boolean`

Thinking controls:

- `thinking: boolean` (`false` maps to `thinking.type = "disabled"`)
- `thinkingType: "enabled" | "disabled"`
- `clearThinking: boolean` (alias: `clear_thinking`)

Structured output:

- `jsonMode: boolean` (maps to `response_format: { type: "json_object" }`)
- `responseFormat: "json_object" | { type: "json_object" }`

Web search tool:

- `webSearch: boolean | object` (alias: `web_search`)
  - `true` enables default web search tool config
  - object passes through as `web_search` tool configuration

Notes:

- Requests use streaming (`stream: true`) and tool streaming (`tool_stream: true`) when tools are present.
- Tool calls are assembled incrementally from SSE deltas and emitted as soon as arguments become valid JSON.
- Cache usage is automatic server-side; cached prompt token counts are logged when returned by the API (`usage.prompt_tokens_details.cached_tokens`).

## 🛡️ Privacy & Security

- Your API key is stored securely using VS Code's encrypted secrets API
- No data is stored by this extension - all requests go directly to Z.ai
- See [Z.ai Privacy Policy](https://docs.z.ai/legal-agreement/privacy-policy) for details

## 🎛️ MCP Servers

This extension supports Model Context Protocol (MCP) servers for enhanced capabilities:

- **Vision MCP**: Image processing and analysis
- **Search MCP**: Web and code search capabilities
- **Reader MCP**: Document reading and PDF processing
- **ZRead MCP**: Advanced reading and contextual analysis

### Configure MCP Servers

You can enable/disable MCP servers in VS Code settings:

1. Open VS Code Settings (`Ctrl+,` or `Cmd+,`)
2. Search for "Z.ai"
3. Enable/disable individual MCP servers as needed

### Troubleshooting

- **`command 'z-chat.manageApiKey' not found`**
  - Ensure you are running the latest extension build and reload VS Code (`Developer: Reload Window`).
  - This usually indicates extension activation failed before command registration.

- **Selecting Z.ai in Model Manager does nothing**
  - This is typically the same activation issue as above; update/reload the extension first.

- **No registered MCP servers**
  - MCP servers are only returned after a valid API key is available.
  - MCP registration depends on VS Code builds that include MCP provider APIs. In builds without that API, the extension still works for chat/models, but MCP server registration is skipped.

## 🛠️ Development

### Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [pnpm](https://pnpm.io/) (version pinned in `package.json`)
- [VS Code](https://code.visualstudio.com/) 1.109.0+

### Build

```bash
pnpm install
pnpm run compile        # type-check + lint + bundle
pnpm run watch          # parallel watch for type-check and bundle
```

### Testing

```bash
pnpm test               # unit tests (Vitest)
pnpm run test:coverage  # unit tests with coverage
pnpm run test:extension # VS Code integration tests
```

### Debugging

Open the project in VS Code and press **F5** to launch the Extension Development Host with the extension loaded.

## 📄 License

MIT License - See [LICENSE](LICENSE) for details.

Maintained by [Daniel Sieradski](https://self.agency) ([@selfagency](https://github.com/selfagency)).
