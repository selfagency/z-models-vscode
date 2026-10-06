import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { type IQuotaDataSource, type UsageQuota, UsageStatusBar } from '../usage-status-bar.js';

/**
 * Lifecycle regression tests for issue #20 / the Marketplace "pure DDoS client"
 * report. The original implementation called `createStatusBarItem()` and started
 * an unguarded interval on every `show()`, and `show()` was invoked on each
 * refresh tick — so status bar items and poll timers multiplied with uptime,
 * each timer fanning out to Z.ai quota requests.
 */

type MockItem = {
  text: string;
  tooltip: string;
  command?: string;
  show: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
};

const createStatusBarItem = vscode.window.createStatusBarItem as unknown as ReturnType<typeof vi.fn>;

function quota(overrides: Partial<UsageQuota> = {}): UsageQuota {
  return { used: 50, total: 100, unit: 'tokens', window: 'hourly', percentUsed: 0.5, ...overrides };
}

function makeSource(): IQuotaDataSource & { calls: number } {
  const source = {
    calls: 0,
    async getQuota() {
      return quota();
    },
    async refreshQuota() {
      source.calls++;
      return quota();
    },
  };
  return source;
}

describe('UsageStatusBar lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates exactly one status bar item across repeated show() calls', async () => {
    const bar = new UsageStatusBar({ displayName: 'Z.ai', quotaDataSource: makeSource() });

    await bar.show();
    await bar.show();
    await bar.show();

    expect(createStatusBarItem).toHaveBeenCalledTimes(1);
  });

  it('starts only one refresh timer across repeated show() calls', async () => {
    const source = makeSource();
    const bar = new UsageStatusBar({
      displayName: 'Z.ai',
      refreshIntervalMs: 1000,
      quotaDataSource: source,
    });

    await bar.show();
    await bar.show();
    await bar.show();

    // Baseline taken after the shows: each show() refreshes once by design, so
    // only the timer-driven increments are compared here.
    const beforeTick = source.calls;
    vi.advanceTimersByTime(1000);
    expect(source.calls - beforeTick).toBe(1);

    vi.advanceTimersByTime(3000);
    expect(source.calls - beforeTick).toBe(4);
  });

  it('stops polling while hidden and resumes after show()', async () => {
    const source = makeSource();
    const bar = new UsageStatusBar({
      displayName: 'Z.ai',
      refreshIntervalMs: 1000,
      quotaDataSource: source,
    });

    await bar.show();
    const beforeHide = source.calls;

    bar.hide();
    vi.advanceTimersByTime(5000);
    expect(source.calls).toBe(beforeHide);

    await bar.show();
    const afterShow = source.calls;
    expect(afterShow).toBe(beforeHide + 1);
    vi.advanceTimersByTime(1000);
    expect(source.calls).toBe(afterShow + 1);
    // show() after hide() must reuse the same item.
    expect(createStatusBarItem).toHaveBeenCalledTimes(1);
  });

  it('dispose() stops the timer and disposes the item', async () => {
    const source = makeSource();
    const bar = new UsageStatusBar({
      displayName: 'Z.ai',
      refreshIntervalMs: 1000,
      quotaDataSource: source,
    });

    await bar.show();
    const item = createStatusBarItem.mock.results[0]!.value as MockItem;

    bar.dispose();
    const afterDispose = source.calls;
    vi.advanceTimersByTime(5000);

    expect(source.calls).toBe(afterDispose);
    expect(item.dispose).toHaveBeenCalled();
  });

  it('dispose() is safe without a prior show()', () => {
    const bar = new UsageStatusBar({ displayName: 'Z.ai', quotaDataSource: makeSource() });
    expect(() => bar.dispose()).not.toThrow();
  });

  it('sets the configured click command so the item is interactive', async () => {
    const bar = new UsageStatusBar({
      displayName: 'Z.ai',
      clickCommand: 'z-chat.toggleUsageView',
      quotaDataSource: makeSource(),
    });

    await bar.show();
    const item = createStatusBarItem.mock.results[0]!.value as MockItem;
    expect(item.command).toBe('z-chat.toggleUsageView');
  });

  it('renders the API window label and plan-independent percentage', async () => {
    const source: IQuotaDataSource = {
      async getQuota() {
        return quota();
      },
      async refreshQuota() {
        return quota({ windowLabel: '5-Hour', percentUsed: 0.42 });
      },
    };
    const bar = new UsageStatusBar({ displayName: 'Z.ai', quotaDataSource: source });

    await bar.show();
    const item = createStatusBarItem.mock.results[0]!.value as MockItem;

    expect(item.text).toBe('$(pulse) Z.ai: 42% of 5-Hour');
    expect(item.tooltip).toContain('5-Hour window');
    expect(item.tooltip).toContain('42%');
  });

  it('includes the plan level and reset time in the tooltip when present', async () => {
    const source: IQuotaDataSource = {
      async getQuota() {
        return quota();
      },
      async refreshQuota() {
        return quota({ windowLabel: '1-Week', planLevel: 'pro', percentUsed: 0.12, expiresAt: new Date(1800000000000) });
      },
    };
    const bar = new UsageStatusBar({ displayName: 'Z.ai', quotaDataSource: source });

    await bar.show();
    const item = createStatusBarItem.mock.results[0]!.value as MockItem;

    expect(item.tooltip).toContain('Z.ai PRO plan');
    expect(item.tooltip).toContain('1-Week window');
    expect(item.tooltip).toContain('Resets');
  });

  it('falls back to the coarse window when no label is provided', async () => {
    const bar = new UsageStatusBar({ displayName: 'Z.ai', quotaDataSource: makeSource() });
    await bar.show();
    const item = createStatusBarItem.mock.results[0]!.value as MockItem;
    expect(item.text).toBe('$(pulse) Z.ai: 50% of hourly');
  });
});