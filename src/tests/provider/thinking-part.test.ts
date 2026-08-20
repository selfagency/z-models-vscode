import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { createProgressStreamAdapter, LanguageModelThinkingPart } from '../../provider.js';

type ProgressLike = { report: (part: unknown) => void };

type VscodeWithThinking = {
  LanguageModelThinkingPart?: new (value: string) => unknown;
};

describe('createProgressStreamAdapter — thinking part emission', () => {
  it('uses the real VS Code LanguageModelThinkingPart when available', () => {
    // The vscode namespace exposes LanguageModelThinkingPart via the test mock,
    // which stands in for the real proposed API. The adapter should emit an
    // instance of THAT class, not the provider's local fallback.
    const RealThinkingPart = (vscode as unknown as VscodeWithThinking).LanguageModelThinkingPart;

    const report = vi.fn();
    const adapter = createProgressStreamAdapter({ report } as unknown as ProgressLike);
    adapter.thinkingProgress?.({ text: 'deep reasoning' });

    expect(report).toHaveBeenCalledTimes(1);
    const emitted = report.mock.calls[0][0] as { value: string };
    expect(emitted).toBeInstanceOf(RealThinkingPart);
    expect(emitted).not.toBeInstanceOf(LanguageModelThinkingPart);
    expect(emitted.value).toBe('deep reasoning');
  });

  it('falls back to the local LanguageModelThinkingPart when the VS Code API is absent', () => {
    const vscodeModule = vscode as unknown as VscodeWithThinking;
    const original = vscodeModule.LanguageModelThinkingPart;
    // Namespace is read-only; simulate absence by redefining via Object.defineProperty.
    Object.defineProperty(vscodeModule, 'LanguageModelThinkingPart', { value: undefined, configurable: true });

    try {
      const report = vi.fn();
      const adapter = createProgressStreamAdapter({ report } as unknown as ProgressLike);
      adapter.thinkingProgress?.({ text: 'internal reasoning' });

      expect(report).toHaveBeenCalledTimes(1);
      const emitted = report.mock.calls[0][0] as { value: string };
      expect(emitted).toBeInstanceOf(LanguageModelThinkingPart);
      expect(emitted.value).toBe('internal reasoning');
    } finally {
      Object.defineProperty(vscodeModule, 'LanguageModelThinkingPart', { value: original, configurable: true });
    }
  });
});
