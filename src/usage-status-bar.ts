import * as vscode from 'vscode';
import type { UsageData } from './usage-service.js';

/**
 * Status bar item showing Z.ai quota usage.
 * Click toggles between hourly and weekly view.
 */
export class UsageStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private currentUsage: UsageData | null = null;
  private currentError: string | null = null;
  private viewMode: 'hourly' | 'weekly' = 'hourly';

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'z-chat.toggleUsageView';
    this.showNoKey();
    this.item.show();
  }

  // ── State transitions ────────────────────────────────────────────────

  updateUsage(usage: UsageData): void {
    this.currentUsage = usage;
    this.currentError = null;
    this.render();
  }

  showError(error: string): void {
    this.currentError = error;
    this.item.text = 'Z · !';
    this.item.tooltip = `Z.ai Usage: ${error}`;
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  }

  showLoading(): void {
    this.item.text = '$(sync~spin) Z · ...';
    this.item.tooltip = 'Fetching Z.ai usage data…';
    this.item.backgroundColor = undefined;
  }

  showNoKey(): void {
    this.item.text = 'Z · —';
    this.item.tooltip = 'API key not configured';
    this.item.backgroundColor = undefined;
  }

  /** Toggle between hourly and weekly view on click. */
  toggleView(): void {
    this.viewMode = this.viewMode === 'hourly' ? 'weekly' : 'hourly';
    this.render();
  }

  dispose(): void {
    this.item.dispose();
  }

  // ── Private helpers ──────────────────────────────────────────────────

  private render(): void {
    if (!this.currentUsage) return;
    const usage = this.currentUsage;
    const hourlyQuota = this.pickHourlyQuota(usage);
    const weeklyQuota = this.pickWeeklyQuota(usage);
    const hourPct = hourlyQuota?.percentage ?? 0;
    const weekPct = weeklyQuota?.percentage ?? hourPct;

    if (this.viewMode === 'hourly') {
      this.item.text = `$(graph) Z · ${hourPct}% of 5 Hours`;
    } else {
      this.item.text = `$(graph) Z · ${weekPct}% of Week`;
    }

    this.item.tooltip = this.buildTooltip(usage);

    const warnPct = this.viewMode === 'hourly' ? hourPct : weekPct;
    if (warnPct >= 95) {
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (warnPct >= 80) {
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      this.item.backgroundColor = undefined;
    }
  }

  private pickHourlyQuota(usage: UsageData) {
    // Prefer explicit hour-based windows (unit=3), then choose the smallest hour window.
    const hourly = usage.tokenQuotas
      .filter(q => q.unit === 3)
      .sort((a, b) => a.number - b.number);
    if (hourly.length > 0) return hourly[0];

    // Fallback: keep prior behavior for unexpected payloads.
    return usage.tokenQuotas
      .slice()
      .sort((a, b) => a.unit * a.number - b.unit * b.number)[0];
  }

  private pickWeeklyQuota(usage: UsageData) {
    // Prefer explicit week-based windows (unit=6), then choose the smallest week window.
    const weekly = usage.tokenQuotas
      .filter(q => q.unit === 6)
      .sort((a, b) => a.number - b.number);
    if (weekly.length > 0) return weekly[0];

    // Fallback: if no weekly data exists, reuse hourly quota.
    return this.pickHourlyQuota(usage);
  }

  private buildTooltip(usage: UsageData): string {
    const lines: string[] = [];

    const plan = this.fmtPlan(usage.planLevel);
    if (plan) {
      lines.push(`Z.ai ${plan} plan`, '');
    } else {
      lines.push('Z.ai plan', '');
    }

    for (const q of usage.tokenQuotas) {
      lines.push(`${q.windowName}: ${q.percentage}%`);
      lines.push(this.progressBar(q.percentage, 20));
      if (q.nextResetTime) lines.push(`Resets ${this.fmtReset(q.nextResetTime)}`);
      lines.push('');
    }

    for (const tl of usage.timeLimits) {
      lines.push(`${tl.windowName}: ${tl.currentValue}/${tl.usage} (${tl.percentage}%)`);
    }

    lines.push('', `Updated ${this.fmtRelative(usage.lastUpdated)}`);
    return lines.join('\n');
  }

  private fmtPlan(level?: string): string {
    if (!level) return '';
    return level.charAt(0).toUpperCase() + level.slice(1).toLowerCase();
  }

  private progressBar(pct: number, width: number): string {
    const safeWidth = Math.max(1, width);
    const clampedPct = Math.max(0, Math.min(100, pct));
    const filled = Math.round((clampedPct / 100) * safeWidth);
    // Use ASCII chars for consistent visual width in tooltip fonts.
    return `[${'#'.repeat(filled)}${'-'.repeat(safeWidth - filled)}]`;
  }

  private fmtReset(ms: number): string {
    const diffMs = ms - Date.now();
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
