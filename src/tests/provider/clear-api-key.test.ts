// The clear-key path, proven at the unit level.
//
// An end-to-end test could not discriminate this: every observable path converged
// on "no key" whether or not ApiKeyManager's in-memory cache was cleared. The
// stale cache is only visible from inside, which is exactly what a unit test is
// for.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKeyManager } from '../../agentsy-native.js';
import { ZChatModelProvider } from '../../provider.js';

function makeContext() {
  const store = new Map<string, string>();
  return {
    store,
    context: {
      secrets: {
        get: vi.fn(async (key: string) => store.get(key)),
        store: vi.fn(async (key: string, value: string) => {
          store.set(key, value);
        }),
        delete: vi.fn(async (key: string) => {
          store.delete(key);
        }),
        onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
      },
      subscriptions: [] as unknown[],
    } as any,
  };
}

describe('clearing the API key', () => {
  let harness: ReturnType<typeof makeContext>;

  beforeEach(() => {
    harness = makeContext();
  });

  it('removes the secret AND the ApiKeyManager cache', async () => {
    const manager = new ApiKeyManager(harness.context, {
      secretKey: 'Z_API_KEY',
      contextKey: 'zModels.hasApiKey',
      displayName: 'Z.ai API Key',
      promptMessage: 'Enter your Z.ai API key',
    });

    // A user enters their key through the prompt, which is the path that
    // populates ApiKeyManager's in-memory cache.
    await manager.setApiKey('user-key-value-1234567890');
    expect(await manager.getApiKey()).toBe('user-key-value-1234567890');

    const provider = new ZChatModelProvider(harness.context, undefined, false, undefined, manager);

    await provider.clearApiKey();

    // The bug this pins: clearing only secret storage left the cached key in
    // place, so the provider rebuilt its HTTP client from the cache and kept
    // sending a key the user had just deleted.
    expect(await manager.getApiKey()).toBeUndefined();
    expect(await harness.context.secrets.get('Z_API_KEY')).toBeUndefined();
    expect(harness.store.has('Z_API_KEY')).toBe(false);
  });

  it('drops the HTTP client and the cached model list', async () => {
    const manager = new ApiKeyManager(harness.context, {
      secretKey: 'Z_API_KEY',
      contextKey: 'zModels.hasApiKey',
      displayName: 'Z.ai API Key',
      promptMessage: 'Enter your Z.ai API key',
    });
    await manager.setApiKey('user-key-value-1234567890');

    const provider = new ZChatModelProvider(harness.context, undefined, false, undefined, manager);
    await provider['initClient'](true);

    // Force a client and a populated catalog, the state a live session is in.
    provider['client'] = { chat: {}, models: {} } as any;
    provider['fetchedModels'] = [{ id: 'glm-5.3' }] as any;
    provider['modelCacheTimestamp'] = Date.now();

    await provider.clearApiKey();

    expect(provider['client']).toBeNull();
    expect(provider['fetchedModels']).toBeNull();
    expect(provider['modelCacheTimestamp']).toBe(0);
  });

  it('tells VS Code the catalog changed', async () => {
    const manager = new ApiKeyManager(harness.context, {
      secretKey: 'Z_API_KEY',
      contextKey: 'zModels.hasApiKey',
      displayName: 'Z.ai API Key',
      promptMessage: 'Enter your Z.ai API key',
    });
    const provider = new ZChatModelProvider(harness.context, undefined, false, undefined, manager);

    let fired = 0;
    provider.onDidChangeLanguageModelChatInformation(() => {
      fired += 1;
    });

    await provider.clearApiKey();
    expect(fired).toBe(1);
  });

  it('still clears when no ApiKeyManager is supplied', async () => {
    const provider = new ZChatModelProvider(harness.context, undefined, false);
    await harness.context.secrets.store('Z_API_KEY', 'orphan-key');

    await provider.clearApiKey();

    expect(harness.store.has('Z_API_KEY')).toBe(false);
    expect(provider['client']).toBeNull();
  });

  it('reinitializeClient rebuilds from the current secret', async () => {
    const manager = new ApiKeyManager(harness.context, {
      secretKey: 'Z_API_KEY',
      contextKey: 'zModels.hasApiKey',
      displayName: 'Z.ai API Key',
      promptMessage: 'Enter your Z.ai API key',
    });
    const provider = new ZChatModelProvider(harness.context, undefined, false, undefined, manager);

    await manager.setApiKey('first-key-value-123456789');
    expect(await provider.reinitializeClient()).toBe(true);

    await manager.setApiKey('second-key-value-12345678');
    expect(await provider.reinitializeClient()).toBe(true);
    expect(await manager.getApiKey()).toBe('second-key-value-12345678');
  });
});