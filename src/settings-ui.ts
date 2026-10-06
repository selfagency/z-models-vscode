import * as vscode from 'vscode';
import { UsageService } from './usage-service.js';

type LogChannel = { info(msg: string): void; warn(msg: string): void };

type Deps = {
  context: vscode.ExtensionContext;
  log: LogChannel;
  getApiKey: () => Promise<string | undefined>;
  /**
   * Clears the key through the provider so the HTTP client and the cached model
   * list are dropped too. Deleting the secret directly leaves the provider
   * holding a client that still sends the old key.
   */
  clearApiKey: () => Promise<void>;
};

// Separators have no `run`; `picked?.run?.()` handles that at the call site.
type SettingsItem = vscode.QuickPickItem & {
  run?: () => Promise<void>;
};

const ENDPOINTS: Record<string, string> = {
  zaiCoding: 'https://api.z.ai/api/coding/paas/v4',
  zaiGeneral: 'https://api.z.ai/api/paas/v4',
  bigmodel: 'https://open.bigmodel.cn/api/paas/v4',
  bigmodelCoding: 'https://open.bigmodel.cn/api/coding/paas/v4',
};

const TOGGLES: Array<{ key: string; label: string }> = [
  { key: 'mcpServers.vision', label: 'Vision MCP server' },
  { key: 'mcpServers.search', label: 'Search MCP server' },
  { key: 'mcpServers.reader', label: 'Reader MCP server' },
  { key: 'mcpServers.zread', label: 'Zread MCP server' },
  { key: 'tools.webSearch', label: 'Web search tool' },
  { key: 'tools.webFetch', label: 'Web fetch tool' },
];

function isEnabled(key: string): boolean {
  return vscode.workspace.getConfiguration('zModels').get<boolean>(key, true) !== false;
}

function toggleItem(key: string, label: string): SettingsItem {
  return {
    label: `${isEnabled(key) ? '$(check)' : '$(circle-slash)'} ${label}`,
    description: isEnabled(key) ? 'Enabled' : 'Disabled',
    detail: `zModels.${key}`,
    run: async () => {
      await vscode.workspace.getConfiguration('zModels').update(key, !isEnabled(key));
    },
  };
}

/**
 * `Z: Manage Settings` UI.
 *
 * Replaces the previous stub that only echoed a hardcoded endpoint string. Every
 * entry here changes real state; the API-key entries cover the failures a user
 * cannot otherwise diagnose (a rejected key, or a key on a plan with no quota).
 */
export async function showSettingsUI(deps: Deps): Promise<void> {
  const config = vscode.workspace.getConfiguration('zModels');
  const interval = config.get<number>('usage.refreshInterval', 5);
  const endpointMode = config.get<string>('api.endpointMode', 'zaiCoding');

  const items: SettingsItem[] = [
    {
      label: '$(server) API endpoint',
      description: ENDPOINTS[endpointMode] ?? endpointMode,
      run: async () => {
        const picked = await vscode.window.showQuickPick(
          Object.entries(ENDPOINTS).map(([id, url]) => ({ label: id, description: url, picked: id === endpointMode })),
          { title: 'Z.ai API endpoint' },
        );
        if (picked) await config.update('api.endpointMode', picked.label);
      },
    },
    {
      label: '$(clock) Usage refresh interval',
      description: `${interval} min`,
      detail: 'How often the status bar re-reads your quota.',
      run: async () => {
        const value = await vscode.window.showInputBox({
          title: 'Usage refresh interval in minutes',
          value: String(interval),
          validateInput: v =>
            Number.isFinite(Number(v)) && Number(v) >= 1 ? undefined : 'Enter a number of minutes, at least 1.',
        });
        if (value) await config.update('usage.refreshInterval', Math.max(1, Math.floor(Number(value))));
      },
    },
    {
      label: '$(pulse) Usage status bar',
      description: isEnabled('usage.enabled') ? 'Enabled' : 'Disabled',
      run: async () => {
        await config.update('usage.enabled', !isEnabled('usage.enabled'));
      },
    },
    { label: '', kind: vscode.QuickPickItemKind.Separator, description: 'MCP servers' },
    ...TOGGLES.filter(t => t.key.startsWith('mcp')).map(t => toggleItem(t.key, t.label)),
    { label: '', kind: vscode.QuickPickItemKind.Separator, description: 'First-party tools' },
    ...TOGGLES.filter(t => t.key.startsWith('tools')).map(t => toggleItem(t.key, t.label)),
    { label: '', kind: vscode.QuickPickItemKind.Separator, description: 'API key' },
    {
      label: '$(verified) Validate stored API key',
      description: 'Calls the live quota endpoint to check the key works.',
      run: () => validateApiKey(deps),
    },
    {
      label: '$(key) Replace API key',
      run: async () => {
        await vscode.commands.executeCommand('z-chat.manageApiKey');
      },
    },
    {
      label: '$(trash) Clear stored API key',
      run: async () => {
        await deps.clearApiKey();
        await vscode.window.showInformationMessage(
          'Z.ai API key cleared. Run "Z: Manage API Key" to add a new one.',
        );
      },
    },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Z.ai Settings',
    placeHolder: 'Select a setting to change',
  });
  await picked?.run?.();
}

/**
 * Probe the quota endpoint with the stored key. Distinguishes "key rejected" from
 * "key works but has no quota windows", which look identical from the chat surface.
 */
async function validateApiKey(deps: Deps): Promise<void> {
  const apiKey = await deps.getApiKey();
  if (!apiKey) {
    await vscode.window.showWarningMessage('No Z.ai API key is stored. Run "Z: Manage API Key" first.');
    return;
  }

  const result = await new UsageService(apiKey).fetchUsage();
  if (!result.success) {
    deps.log.warn(`[Z] API key validation failed: ${result.error}`);
    await vscode.window.showErrorMessage(`Z.ai API key check failed: ${result.error}`);
    return;
  }

  const windows = result.data?.tokenQuotas.length ?? 0;
  const plan = result.data?.planLevel ?? 'unknown';
  deps.log.info(`[Z] API key validation succeeded: plan=${plan} quotaWindows=${windows}`);

  await vscode.window.showInformationMessage(
    windows > 0
      ? `Z.ai API key is valid. Plan: ${plan}, ${windows} quota window(s).`
      : `Z.ai API key authenticated, but no quota windows were returned. The key is likely not on a Coding Plan.`,
  );
}