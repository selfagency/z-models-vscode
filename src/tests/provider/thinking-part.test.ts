// biome-ignore lint/suspicious/noExplicitAny: Necessary for testing private methods.

import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { createProgressStreamAdapter, LanguageModelThinkingPart } from '../../provider.js';

describe('createProgressStreamAdapter — thinking part emission', () => {
  it('uses the real VS Code LanguageModelThinkingPart when available', () => {
    // The vscode namespace exposes LanguageModelThinkingPart via the test mock,
    // which stands in for the real proposed API. The adapter should emit an
    // instance of THAT class, not the provider's local fallback.
    const RealThinkingPart = (vscode as any).LanguageModelThinkingPart;

    const report = vi.fn();
    const adapter = createProgressStreamAdapter({ report } as any);
    const tp = adapter.thinkingProgress!;
    tp({ text: 'deep reasoning' });

    expect(report).toHaveBeenCalledTimes(1);
    const emitted = report.mock.calls[0][0];
    expect(emitted).toBeInstanceOf(RealThinkingPart);
    expect(emitted).not.toBeInstanceOf(LanguageModelThinkingPart);
    expect(emitted.value).toBe('deep reasoning');
  });

  it('falls back to the local LanguageModelThinkingPart when the VS Code API is absent', () => {
    const vscodeModule = vscode as any;
    const original = vscodeModule.LanguageModelThinkingPart;
    // Namespace is read-only; simulate absence by redefining via Object.defineProperty.
    Object.defineProperty(vscodeModule, 'LanguageModelThinkingPart', { value: undefined, configurable: true });

    try {
      const report = vi.fn();
      const adapter = createProgressStreamAdapter({ report } as any);
      const tp = adapter.thinkingProgress!;
      tp({ text: 'internal reasoning' });

      expect(report).toHaveBeenCalledTimes(1);
      expect(report.mock.calls[0][0]).toBeInstanceOf(LanguageModelThinkingPart);
      expect(report.mock.calls[0][0].value).toBe('internal reasoning');
    } finally {
      Object.defineProperty(vscodeModule, 'LanguageModelThinkingPart', { value: original, configurable: true });
    }
  });
});
