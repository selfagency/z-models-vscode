import * as vscode from 'vscode';
import type { UsageData } from './usage-service.js';

/**
 * Status bar item showing Z.ai quota usage as `$(graph) Z {n}%`.
 */
export class UsageStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private currentUsage: UsageData | null = null;
  private currentError: string | null = null;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = 'z-chat.showUsageDetails';
    this.showNoKey();
    this.item.show();
  }

  // ── State transitions ────────────────────────────────────────────────

  updateUsage(usage: UsageData): void {
    this.currentUsage = usage;
    this.currentError = null;

    // Pick the shortest-window token quota (usually 5-hour) for the badge
    const primary = this.pickPrimaryQuota(usage);
    const pct = primary?.percentage ?? 0;
    const planLabel = this.fmtPlan(usage.planLevel);

    this.item.text = `$(graph) Z ${pct}%`;
    this.item.tooltip = this.buildTooltip(usage, planLabel);

    if (pct >= 95) {
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (pct >= 80) {
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      this.item.backgroundColor = undefined;
    }
  }

  showError(error: string): void {
    this.currentError = error;
    this.item.text = '$(graph) Z !';
    this.item.tooltip = `Z.ai Usage: error fetching data\n${error}\n\nClick to retry.`;
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  }

  showLoading(): void {
    this.item.text = '$(sync~spin) Z ...';
    this.item.tooltip = 'Fetching Z.ai usage data…';
    this.item.backgroundColor = undefined;
  }

  showNoKey(): void {
    this.item.text = '$(graph) Z —';
    this.item.tooltip = 'Z.ai Usage: API key not configured.\nClick to configure.';
    this.item.backgroundColor = undefined;
  }

  /** Show the details quick-pick menu. */
  async showQuickPick(): Promise<void> {
    const options: vscode.QuickPickItem[] = [];

    if (this.currentUsage) {
      const u = this.currentUsage;
      const plan = this.fmtPlan(u.planLevel);

      // Plan header
      if (plan) {
        options.push({
          label: `$(account) Plan: ${plan}`,
          detail: 'Auto-detected from API',
        });
      }

      // Token quota windows
      for (const q of u.tokenQuotas) {
        options.push({
          label: `$(graph) ${q.windowName} Quota: ${q.percentage}%`,
          detail: this.progressBar(q.percentage, 20) + (q.nextResetTime ? `  resets ${this.fmtReset(q.nextResetTime)}` : ''),
        });
      }

      // MCP tool limits
      for (const tl of u.timeLimits) {
        options.push({
          label: `$(tools) ${tl.windowName}: ${tl.percentage}%`,
          detail: `${tl.currentValue} / ${tl.usage} used (${tl.remaining} remaining)`,
        });
      }

      // Separator
      options.push({ label: '', kind: vscode.QuickPickItemKind.Separator });

      // Stats
      options.push({
        label: `$(calendar) Today`,
        detail: `${u.todayPrompts} prompts • ${this.fmtTokens(u.todayTokens)}`,
      });
      options.push({
        label: `$(history) Last 7 Days`,
        detail: `${u.sevenDayPrompts} prompts • ${this.fmtTokens(u.sevenDayTokens)}`,
      });
      options.push({
        label: `$(clock) Last 30 Days`,
        detail: `${u.thirtyDayPrompts} prompts • ${this.fmtTokens(u.thirtyDayTokens)}`,
      });

      options.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    } else if (this.currentError) {
      options.push({
        label: `$(error) Error: ${this.currentError}`,
        detail: 'Click retry below to try again.',
      });
      options.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    } else {
      options.push({
        label: '$(info) API key not configured',
        detail: 'Click "Configure" below to set your Z.ai API key.',
      });
      options.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    }

    // Actions
    options.push({ label: '$(refresh) Refresh Usage', detail: 'Fetch latest usage data' });
    options.push({ label: '$(key) Configure API Key', detail: 'Manage your Z.ai API key' });

    const picked = await vscode.window.showQuickPick(options, {
      placeHolder: 'Z.ai Usage Tracker',
    });

    if (!picked) return;

    if (picked.label.includes('Refresh')) {
      vscode.commands.executeCommand('z-chat.refreshUsage');
    } else if (picked.label.includes('Configure')) {
      vscode.commands.executeCommand('z-chat.manageApiKey');
    }
  }

  dispose(): void {
    this.item.dispose();
  }

  // ── Private helpers ──────────────────────────────────────────────────

  private pickPrimaryQuota(usage: UsageData) {
    // Prefer the shortest-window (smallest unit*number) token quota
    return usage.tokenQuotas
      .slice()
      .sort((a, b) => a.unit * a.number - b.unit * b.number)[0];
  }

  private buildTooltip(usage: UsageData, planLabel: string): string {
    let tip = '⚡ Z.ai Usage\n─────────────────\n\n';

    if (planLabel) {
      tip += `📦 Plan: ${planLabel}\n\n`;
    }

    for (const q of usage.tokenQuotas) {
      tip += `📊 ${q.windowName} Quota: ${q.percentage}%\n`;
      tip += `   ${this.progressBar(q.percentage, 20)}\n`;
      if (q.nextResetTime) {
        tip += `   Resets ${this.fmtReset(q.nextResetTime)}\n`;
      }
      tip += '\n';
    }

    if (usage.timeLimits.length > 0) {
      tip += '─────────────────\n';
      for (const tl of usage.timeLimits) {
        tip += `🔧 ${tl.windowName}: ${tl.currentValue}/${tl.usage} (${tl.percentage}%)\n`;
      }
      tip += '\n';
    }

    tip += '─────────────────\n';
    tip += `📅 Today: ${usage.todayPrompts} prompts • ${this.fmtTokens(usage.todayTokens)}\n`;
    tip += `📆 7-Day: ${usage.sevenDayPrompts} prompts • ${this.fmtTokens(usage.sevenDayTokens)}\n`;
    tip += `📆 30-Day: ${usage.thirtyDayPrompts} prompts • ${this.fmtTokens(usage.thirtyDayTokens)}\n\n`;
    tip += `Updated ${this.fmtRelative(usage.lastUpdated)}\n`;
    tip += 'Click for details';

    return tip;
  }

  private fmtPlan(level?: string): string {
    if (!level) return '';
    return level.charAt(0).toUpperCase() + level.slice(1).toLowerCase();
  }

  private fmtTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
  }

  private progressBar(pct: number, width: number): string {
    const filled = Math.round((pct / 100) * width);
    return '█'.repeat(filled) + '░'.repeat(width - filled);
  }

  private fmtReset(ms: number): string {
    const now = Date.now();
    const diffMs = ms - now;
    if (diffMs <= 0) return 'now';
    const mins = Math.floor(diffMs / 60000);
    if (mins < 60) return `in ${mins}m`;
    const hrs = Math.floor(mins / 60);
    return `in ${hrs}h ${mins % 60}m`;
  }

  private fmtRelative(date: Date): string {
    const diffMs = Date.now() - date.getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
}
