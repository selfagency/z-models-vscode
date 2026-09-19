// biome-ignore lint/suspicious/noExplicitAny: Necessary for testing private methods.

// biome-ignore lint/suspicious/noExplicitAny: Necessary for testing private methods.

import { describe, expect, it } from 'vitest';
import {
  LanguageModelChatMessageRole,
} from 'vscode';
import { inferVisionFromModelId } from '../../model-info.js';
import { toZRole, formatModelName } from '../../provider.js';

describe('toZRole', () => {
  it('maps User to "user"', () => {
    expect(toZRole(LanguageModelChatMessageRole.User)).toBe('user');
  });

  it('maps Assistant to "assistant"', () => {
    expect(toZRole(LanguageModelChatMessageRole.Assistant)).toBe('assistant');
  });

  it('maps unknown values to "user"', () => {
    expect(toZRole(99 as any)).toBe('user');
  });
});

describe('formatModelName', () => {
  it('capitalises a single segment', () => {
    expect(formatModelName('z')).toBe('Z');
  });

  it('capitalises each hyphen-separated segment', () => {
    expect(formatModelName('z-large-latest')).toBe('Z Large Latest');
  });

  it('handles numeric segments without error', () => {
    expect(formatModelName('devstral-small-2505')).toBe('Devstral Small 2505');
  });
});

describe('inferVisionFromModelId', () => {
  it('treats the multimodal glm-5.3 flash variants as vision-capable', () => {
    expect(inferVisionFromModelId('glm-5.3-flash')).toBe(true);
    expect(inferVisionFromModelId('glm-5.3-flashx')).toBe(true);
  });

  it('keeps text-only glm-5.3 as non-vision', () => {
    expect(inferVisionFromModelId('glm-5.3')).toBe(false);
  });

  it('still detects the existing vision markers', () => {
    expect(inferVisionFromModelId('glm-5v-turbo')).toBe(true);
    expect(inferVisionFromModelId('glm-4.6v-flash')).toBe(true);
  });
});
