/**
 * Usage status bar.
 *
 * Split out of `agentsy-native.ts` so the Z.ai-specific quota wiring is not
 * buried in the vendored @agentsy/vscode surface. The upstream implementation
 * had a leak where `show()` created a new status bar item and interval on every
 * call; the version here is deliberately diverged and fixed, so this file is
 * maintained locally rather than kept in sync with upstream.
 */
import * as vscode from 'vscode';

// ── Usage quota + status bar ──────────────────────────────────────────────
export interface UsageQuota {
  used: number;
  total: number;
  unit: 'tokens' | 'credits' | 'requests';
  window: 'hourly' | 'daily' | 'weekly' | 'monthly';
  /**
   * Human-readable window as reported by the API, e.g. "5-Hour" or "1-Week".
   * Preferred over `window` for display because the API's windows do not map
   * cleanly onto hour/day granularity (a unit-3 window is a 5-hour window).
   */
  windowLabel?: string;
  /** Plan level reported by the API, e.g. "lite" / "pro" / "max". */
  planLevel?: string;
  percentUsed: number;
  expiresAt?: Date;
}

export interface IQuotaDataSource {
  getQuota(): Promise<UsageQuota>;
  refreshQuota(): Promise<UsageQuota>;
  dispose?(): void;
}

export interface UsageStatusBarConfig {
  displayName: string;
  tooltipTemplate?: string;
  warningThreshold?: number;
  errorThreshold?: number;
  refreshIntervalMs?: number;
  /**
   * VS Code command invoked when the status bar item is clicked. Required for the
   * item to be interactive — without it the click is silently ignored.
   */
  clickCommand?: string;
  quotaDataSource: IQuotaDataSource;
  colorScheme?: { normal: string; warning: string; error: string };
}

const DEFAULT_REFRESH_INTERVAL = 60_000;
const DEFAULT_TOOLTIP = '{{window}} window: {{used}} / {{total}} {{unit}} used ({{percent}}%)';
const DEFAULT_WARNING_THRESHOLD = 0.8;
const DEFAULT_ERROR_THRESHOLD = 0.95;

/** Displays quota usage in the VS Code status bar with configurable thresholds. */
export class UsageStatusBar {
  private statusBarItem: vscode.StatusBarItem | undefined;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly config: UsageStatusBarConfig) {}

  /**
   * Show the status bar item. Idempotent: repeated calls reuse the existing item
   * and timer instead of stacking a new item + interval on every invocation.
   * (Stacking was the reported "usage bar multiplies" bug.)
   */
  async show(): Promise<UsageQuota | undefined> {
    try {
      if (!this.statusBarItem) {
        const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        if (!item) return undefined;
        this.statusBarItem = item;
        if (this.config.clickCommand) {
          item.command = this.config.clickCommand;
        }
      }

      const quota = await this.refresh();
      this.statusBarItem.show();
      this.startAutoRefresh();
      return quota;
    } catch {
      // No-op if VS Code is unavailable.
      return undefined;
    }
  }

  async refresh(): Promise<UsageQuota | undefined> {
    try {
      const quota = await this.config.quotaDataSource.refreshQuota();
      this.updateDisplay(quota);
      return quota;
    } catch {
      return undefined;
    }
  }

  updateDisplay(quota: UsageQuota): void {
    if (!this.statusBarItem) return;
    const item = this.statusBarItem;
    const percent = Math.round(quota.percentUsed * 100);
    const window = quota.windowLabel ?? quota.window;
    item.text = `$(pulse) ${this.config.displayName}: ${percent}% of ${window}`;
    const template = this.config.tooltipTemplate ?? DEFAULT_TOOLTIP;
    const plan = quota.planLevel ? `Z.ai ${quota.planLevel.toUpperCase()} plan\n` : '';
    const reset = quota.expiresAt
      ? `\nResets ${quota.expiresAt.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`
      : '';
    item.tooltip =
      plan +
      template
        .replace('{{used}}', quota.used.toLocaleString())
        .replace('{{total}}', quota.total.toLocaleString())
        .replace('{{unit}}', quota.unit)
        .replace('{{percent}}', String(percent))
        .replace('{{window}}', window) +
      reset;
    item.color = this.pickColor(quota.percentUsed);
  }

  private pickColor(percentUsed: number): string | undefined {
    const colorScheme = this.config.colorScheme;
    if (!colorScheme) return undefined;
    const warning = this.config.warningThreshold ?? DEFAULT_WARNING_THRESHOLD;
    const error = this.config.errorThreshold ?? DEFAULT_ERROR_THRESHOLD;
    if (percentUsed >= error) return colorScheme.error;
    if (percentUsed >= warning) return colorScheme.warning;
    return colorScheme.normal;
  }

  /** Hide the item and stop polling. Safe to call repeatedly. */
  hide(): void {
    this.stopAutoRefresh();
    this.statusBarItem?.hide();
  }

  /**
   * Change the auto-refresh cadence. Takes effect immediately if polling is
   * currently running; if the bar is hidden, the new interval applies on the
   * next show().
   */
  setRefreshInterval(ms: number): void {
    if (this.config.refreshIntervalMs === ms) return;
    this.config.refreshIntervalMs = ms;
    if (this.refreshTimer === undefined) return;
    this.stopAutoRefresh();
    this.startAutoRefresh();
  }

  dispose(): void {
    this.stopAutoRefresh();
    this.statusBarItem?.dispose();
    this.statusBarItem = undefined;
    this.config.quotaDataSource.dispose?.();
  }

  private startAutoRefresh(): void {
    if (this.refreshTimer !== undefined) return;
    const interval = this.config.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL;
    this.refreshTimer = setInterval(() => {
      void this.refresh();
    }, interval);
  }

  private stopAutoRefresh(): void {
    if (this.refreshTimer !== undefined) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }
}
