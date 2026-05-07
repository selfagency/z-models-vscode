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

describe('ZChatModelProvider — error handling', () => {
  let provider: ZChatModelProvider;

  beforeEach(() => {
    provider = new ZChatModelProvider(mockContext);
  });

  describe('extractUserFriendlyErrorMessage', () => {
    it('extracts error.message from JSON response', () => {
      const details = JSON.stringify({ error: { message: 'API key is invalid' } });
      const { userMessage } = (provider as any).extractUserFriendlyErrorMessage(401, details);
      expect(userMessage).toBe('API key is invalid');
    });

    it('extracts top-level message field from JSON', () => {
      const details = JSON.stringify({ message: 'Rate limit exceeded' });
      const { userMessage } = (provider as any).extractUserFriendlyErrorMessage(429, details);
      expect(userMessage).toBe('Rate limit exceeded');
    });

    it('extracts detail field from JSON when available', () => {
      const details = JSON.stringify({ detail: 'Service temporarily unavailable' });
      const { userMessage } = (provider as any).extractUserFriendlyErrorMessage(503, details);
      expect(userMessage).toBe('Service temporarily unavailable');
    });

    it('returns status-specific message for 401 when no JSON extraction works', () => {
      const details = 'invalid request';
      const { userMessage } = (provider as any).extractUserFriendlyErrorMessage(401, details);
      expect(userMessage).toContain('Invalid API key');
    });

    it('returns status-specific message for 403 when no JSON extraction works', () => {
      const details = 'forbidden';
      const { userMessage } = (provider as any).extractUserFriendlyErrorMessage(403, details);
      expect(userMessage).toContain('Access denied');
    });

    it('returns status-specific message for 404 when no JSON extraction works', () => {
      const details = 'not found';
      const { userMessage } = (provider as any).extractUserFriendlyErrorMessage(404, details);
      expect(userMessage).toContain('endpoint was not found');
    });

    it('returns status-specific message for 429 when no JSON extraction works', () => {
      const details = 'too many requests';
      const { userMessage } = (provider as any).extractUserFriendlyErrorMessage(429, details);
      expect(userMessage).toContain('temporarily overloaded');
    });

    it('returns status-specific message for 500 when no JSON extraction works', () => {
      const details = 'internal error';
      const { userMessage } = (provider as any).extractUserFriendlyErrorMessage(500, details);
      expect(userMessage).toContain('encountered an error');
    });

    it('returns status-specific message for 503 when no JSON extraction works', () => {
      const details = 'service unavailable';
      const { userMessage } = (provider as any).extractUserFriendlyErrorMessage(503, details);
      expect(userMessage).toContain('temporarily unavailable');
    });

    it('returns generic message for unknown status code', () => {
      const details = 'unknown';
      const { userMessage } = (provider as any).extractUserFriendlyErrorMessage(418, details);
      expect(userMessage).toContain('Request failed');
    });

    it('includes original details in logDetails for debugging', () => {
      const details = 'debug info';
      const { logDetails } = (provider as any).extractUserFriendlyErrorMessage(500, details);
      expect(logDetails).toBe('debug info');
    });

    it('handles empty details string', () => {
      const { userMessage } = (provider as any).extractUserFriendlyErrorMessage(429, '');
      expect(userMessage).toContain('temporarily overloaded');
    });

    it('handles undefined details', () => {
      const { userMessage } = (provider as any).extractUserFriendlyErrorMessage(429, undefined);
      expect(userMessage).toContain('temporarily overloaded');
    });
  });

  describe('toLanguageModelError', () => {
    it('returns NoPermissions error for 401', () => {
      const error = (provider as any).toLanguageModelError(401, '', 'invalid key');
      expect(error.constructor.name).toBe('LanguageModelError');
      expect(error.message).toContain('Invalid API key');
    });

    it('returns NoPermissions error for 403', () => {
      const error = (provider as any).toLanguageModelError(403, '', 'forbidden');
      expect(error.constructor.name).toBe('LanguageModelError');
      expect(error.message).toContain('Access denied');
    });

    it('returns NotFound error for 404', () => {
      const error = (provider as any).toLanguageModelError(404, '', 'not found');
      expect(error.constructor.name).toBe('LanguageModelError');
      expect(error.message).toContain('endpoint was not found');
    });

    it('returns Blocked error for 429', () => {
      const error = (provider as any).toLanguageModelError(429, '', 'overloaded');
      expect(error.constructor.name).toBe('LanguageModelError');
      expect(error.message).toContain('temporarily overloaded');
    });

    it('returns generic Error for unknown status', () => {
      const error = (provider as any).toLanguageModelError(418, '', 'teapot');
      expect(error.constructor.name).toBe('Error');
      expect(error.message).toContain('Request failed');
    });

    it('extracts error message from JSON error response', () => {
      const details = JSON.stringify({ error: { message: 'Custom error from API' } });
      const error = (provider as any).toLanguageModelError(500, details);
      expect(error.message).toBe('Custom error from API');
    });
  });
});
