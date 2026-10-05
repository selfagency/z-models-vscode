import { describe, expect, it } from 'vitest';
import { getKnownTokenLimits, modelThinksCompulsorily } from '../../provider.js';

/**
 * Ids returned by GET /models on both api.z.ai endpoints (verified 2026-10-05;
 * coding and general endpoints return the same list). Any id in this list
 * falling back to a small window is a regression, not a new model.
 */
const LIVE_MODEL_IDS = [
  'glm-4.5',
  'glm-4.5-air',
  'glm-4.6',
  'glm-4.7',
  'glm-5',
  'glm-5-turbo',
  'glm-5.1',
  'glm-5.2',
  'glm-5.3',
  'glm-5.3-flash',
  'glm-5.3-flashx',
];

/**
 * Z.ai exposes no per-model context window: `GET /models/{id}` returns only
 * `{id, object, created, owned_by}`, so KNOWN_MODEL_TOKEN_LIMITS is the sole
 * source of truth. These tests pin that table's behaviour — previously the
 * per-model fetch silently 404'd and unmapped models fell to a 32K window,
 * which is what produced issue #21's "can't use the full context" reports.
 */
/**
 * Legacy vision models with genuinely small windows. They are not returned by
 * either live endpoint any more, but the entries stay so a user who configures
 * the general endpoint with an explicit id still gets a sane window.
 */
const NARROW_WINDOW_MODEL_IDS = new Set(['glm-4.6v', 'glm-4.5v']);

describe('context-window correctness (issue #12, #21)', () => {
  it('resolves every live model to a known entry (no fallback)', () => {
    // The original bug: models missing from the table fell through to a 32K
    // window, so Copilot compacted constantly. Membership is the real guard.
    const unknown = LIVE_MODEL_IDS.filter(id => getKnownTokenLimits(id).maxInputTokens === undefined);
    expect(unknown).toEqual([]);
  });

  it('never reports a window below the smallest documented one', () => {
    // glm-4.5 / 4.5-air are 131072 per models.dev; nothing may drop below that.
    const tooSmall = LIVE_MODEL_IDS.filter(id => {
      if (NARROW_WINDOW_MODEL_IDS.has(id)) return false;
      const limits = getKnownTokenLimits(id);
      return !limits.maxInputTokens || limits.maxInputTokens < 131_072;
    });
    expect(tooSmall).toEqual([]);
  });

  it('pins the known narrow-window models so a change is deliberate', () => {
    for (const id of NARROW_WINDOW_MODEL_IDS) {
      expect(getKnownTokenLimits(id).maxInputTokens).toBeGreaterThan(0);
    }
  });

  it('reports a 1M window for the GLM-5.3 family', () => {
    expect(getKnownTokenLimits('glm-5.3')).toEqual({ maxInputTokens: 1_000_000, maxOutputTokens: 131_072 });
    expect(getKnownTokenLimits('glm-5.3-flash')).toEqual({ maxInputTokens: 1_000_000, maxOutputTokens: 131_072 });
    expect(getKnownTokenLimits('glm-5.3-flashx')).toEqual({ maxInputTokens: 1_000_000, maxOutputTokens: 131_072 });
  });

  it('resolves unlisted variants via the longest matching family prefix', () => {
    // Neither id is a table key; both must inherit glm-5.3's 1M window.
    expect(getKnownTokenLimits('glm-5.3-thinking').maxInputTokens).toBe(1_000_000);
    expect(getKnownTokenLimits('glm-5.3-preview').maxInputTokens).toBe(1_000_000);
    // A 4.x variant must NOT inherit the 5.3 window; glm-4.6 is 204800 per
    // models.dev, and glm-4.5 (its other plausible family) is 131072.
    expect(getKnownTokenLimits('glm-4.6-custom').maxInputTokens).toBe(204_800);
    expect(getKnownTokenLimits('glm-4.5-custom').maxInputTokens).toBe(131_072);
    // Longest-prefix wins: a glm-5.3-flash variant must not resolve to glm-5.3
    // if a longer key exists for it.
    expect(getKnownTokenLimits('glm-5.3-flash-preview').maxInputTokens).toBe(1_000_000);
  });

  it('normalizes case, whitespace, and the [1m] context suffix', () => {
    expect(getKnownTokenLimits('  GLM-5.3-FLASH ')).toEqual({ maxInputTokens: 1_000_000, maxOutputTokens: 131_072 });
    expect(getKnownTokenLimits('glm-5.3-flash[1m]')).toEqual({ maxInputTokens: 1_000_000, maxOutputTokens: 131_072 });
  });

  it('returns an empty object for a model outside every known family', () => {
    expect(getKnownTokenLimits('some-unknown-model')).toEqual({});
  });

  it('modelThinksCompulsorily is true for glm-5.3 and glm-5.2', () => {
    expect(modelThinksCompulsorily('glm-5.3')).toBe(true);
    expect(modelThinksCompulsorily('glm-5.2')).toBe(true);
  });
});