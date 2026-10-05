import { describe, expect, it } from 'vitest';
import { formatModelName, inferVisionFromModelId, inferToolCallingFromModelId, resolveModelCapabilities } from '../model-info.js';

/**
 * Vision classification is driven by the models.dev modalities table in
 * src/model-limits.generated.ts, not by id shape. The id-shape heuristic was
 * wrong for the current model line: GLM-5.3-Flash / FlashX accept images while
 * GLM-5.3 itself is text-only.
 */
describe('inferVisionFromModelId', () => {
  it('treats the GLM-5.3 flash family as multimodal', () => {
    expect(inferVisionFromModelId('glm-5.3-flash')).toBe(true);
    expect(inferVisionFromModelId('glm-5.3-flashx')).toBe(true);
  });

  it('treats text-only GLM-5 models as non-vision', () => {
    expect(inferVisionFromModelId('glm-5.3')).toBe(false);
    expect(inferVisionFromModelId('glm-5.2')).toBe(false);
    expect(inferVisionFromModelId('glm-5.1')).toBe(false);
    expect(inferVisionFromModelId('glm-5')).toBe(false);
  });

  it('classifies the legacy v-suffixed vision models', () => {
    expect(inferVisionFromModelId('glm-4.6v')).toBe(true);
    expect(inferVisionFromModelId('glm-4.6v-flash')).toBe(true);
    expect(inferVisionFromModelId('glm-4.5v')).toBe(true);
    expect(inferVisionFromModelId('glm-5v-turbo')).toBe(true);
  });

  it('normalizes case and the [1m] suffix', () => {
    expect(inferVisionFromModelId('GLM-5.3-FLASH')).toBe(true);
    expect(inferVisionFromModelId('glm-5.3-flash[1m]')).toBe(true);
    expect(inferVisionFromModelId(' GLM-5.3 ')).toBe(false);
  });

  it('falls back to the marker heuristic for ids outside the generated table', () => {
    expect(inferVisionFromModelId('glm-9-vision-preview')).toBe(true);
    expect(inferVisionFromModelId('glm-9-plain')).toBe(false);
  });
});

describe('inferToolCallingFromModelId', () => {
  it('assumes glm- prefixed models support tool calling', () => {
    expect(inferToolCallingFromModelId('glm-5.3')).toBe(true);
    expect(inferToolCallingFromModelId('other-model')).toBe(false);
  });
});

describe('resolveModelCapabilities', () => {
  it('prefers explicit capability flags over id inference', () => {
    expect(
      resolveModelCapabilities({
        id: 'glm-5.3',
        toolCalling: false,
        supportsVision: true,
        capabilities: { functionCalling: true, vision: false },
      }),
    ).toEqual({ completionChat: true, functionCalling: false, vision: true });
  });

  it('falls back to id inference when flags are absent', () => {
    expect(resolveModelCapabilities({ id: 'glm-5.3-flash' })).toEqual({
      completionChat: true,
      functionCalling: true,
      vision: true,
    });
  });

  it('handles a missing id without throwing', () => {
    expect(resolveModelCapabilities(undefined)).toEqual({
      completionChat: false,
      functionCalling: false,
      vision: false,
    });
  });
});

describe('formatModelName', () => {
  it('title-cases hyphenated ids', () => {
    expect(formatModelName('z-large-latest')).toBe('Z Large Latest');
    expect(formatModelName('glm-5.3-flash')).toBe('Glm 5.3 Flash');
  });
});