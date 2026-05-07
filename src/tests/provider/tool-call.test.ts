// biome-ignore lint/suspicious/noExplicitAny: Necessary for testing private methods.

// biome-ignore lint/suspicious/noExplicitAny: Necessary for testing private methods.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZChatModelProvider } from '../../provider.js';

const mockContext = {
  secrets: {
    get: vi.fn().mockResolvedValue(undefined),
    store: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    onDidChange: vi.fn(),
  },
  subscriptions: [],
} as any;

describe('ZChatModelProvider — tool call ID mapping', () => {
  let provider: ZChatModelProvider;

  beforeEach(() => {
    provider = new ZChatModelProvider(mockContext);
  });

  describe('generateToolCallId', () => {
    it('returns a 9-character string', () => {
      expect(provider.generateToolCallId()).toHaveLength(9);
    });

    it('returns only alphanumeric characters', () => {
      const id = provider.generateToolCallId();
      expect(id).toMatch(/^[a-zA-Z0-9]{9}$/);
    });

    it('produces unique IDs across calls', () => {
      const ids = new Set(Array.from({ length: 20 }, () => provider.generateToolCallId()));
      expect(ids.size).toBeGreaterThan(1);
    });
  });

  describe('getOrCreateVsCodeToolCallId', () => {
    it('returns a 9-character alphanumeric ID for a new Z ID', () => {
      const id = provider.getOrCreateVsCodeToolCallId('z-abc');
      expect(id).toMatch(/^[a-zA-Z0-9]{9}$/);
    });

    it('returns the same VS Code ID for the same Z ID (idempotent)', () => {
      const first = provider.getOrCreateVsCodeToolCallId('z-abc');
      const second = provider.getOrCreateVsCodeToolCallId('z-abc');
      expect(first).toBe(second);
    });

    it('creates distinct VS Code IDs for different Z IDs', () => {
      const a = provider.getOrCreateVsCodeToolCallId('z-aaa');
      const b = provider.getOrCreateVsCodeToolCallId('z-bbb');
      expect(a).not.toBe(b);
    });

    it('registers the bidirectional mapping so getZToolCallId resolves back', () => {
      const vsCodeId = provider.getOrCreateVsCodeToolCallId('z-xyz');
      expect(provider.getZToolCallId(vsCodeId)).toBe('z-xyz');
    });
  });

  describe('getZToolCallId', () => {
    it('returns the Z ID for a known VS Code ID', () => {
      const vsCodeId = provider.getOrCreateVsCodeToolCallId('z-known');
      expect(provider.getZToolCallId(vsCodeId)).toBe('z-known');
    });

    it('returns undefined for an unknown VS Code ID', () => {
      expect(provider.getZToolCallId('unknown-id')).toBeUndefined();
    });

    it('returns the Z ID for a known VS Code ID', () => {
      const zId = 'z-id-1';
      const vsCodeId = provider.getOrCreateVsCodeToolCallId(zId);

      const result = provider.getZToolCallId(vsCodeId);
      expect(result).toBe(zId);
    });

    it('returns undefined for an unknown VS Code ID', () => {
      const result = provider.getZToolCallId('unknown-id');
      expect(result).toBeUndefined();
    });

    it('handles empty VS Code ID', () => {
      const result = provider.getZToolCallId('');
      expect(result).toBeUndefined();
    });

    it('handles VS Code ID with special characters', () => {
      const result = provider.getZToolCallId('vs-code-id-!@#$%^&*()');
      expect(result).toBeUndefined();
    });
  });

  describe('clearToolCallIdMappings', () => {
    it('makes previously mapped IDs no longer resolvable', () => {
      const vsCodeId = provider.getOrCreateVsCodeToolCallId('z-to-clear');
      provider.clearToolCallIdMappings();
      expect(provider.getZToolCallId(vsCodeId)).toBeUndefined();
    });

    it('subsequent getOrCreate after clear creates a fresh (possibly different) ID', () => {
      const before = provider.getOrCreateVsCodeToolCallId('z-refresh');
      provider.clearToolCallIdMappings();
      const after = provider.getOrCreateVsCodeToolCallId('z-refresh');
      expect(after).toMatch(/^[a-zA-Z0-9]{9}$/);
      expect(provider.getZToolCallId(before)).toBeUndefined();
    });

    it('handles many mappings without losing round-trip consistency', () => {
      const pairs: Array<{ z: string; vs: string }> = [];
      for (let i = 0; i < 200; i++) {
        const z = `z-${i}`;
        const vs = provider.getOrCreateVsCodeToolCallId(z);
        pairs.push({ z, vs });
      }

      for (const pair of pairs) {
        expect(provider.getZToolCallId(pair.vs)).toBe(pair.z);
      }
    });

    it('keeps same VS Code id when repeated z id is requested many times', () => {
      const first = provider.getOrCreateVsCodeToolCallId('z-collision');
      for (let i = 0; i < 50; i++) {
        expect(provider.getOrCreateVsCodeToolCallId('z-collision')).toBe(first);
      }
    });
  });
});
