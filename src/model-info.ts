import { LanguageModelChatInformation } from 'vscode';
import { MODEL_TOKEN_LIMITS, VISION_MODEL_IDS } from './model-limits.generated.js';

/**
 * Z model configuration
 */
export interface ZModel {
  id: string;
  name: string;
  detail?: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  defaultCompletionTokens: number;
  toolCalling: boolean;
  supportsParallelToolCalls: boolean;
  supportsVision?: boolean;
  temperature?: number;
  top_p?: number;
}

export function inferToolCallingFromModelId(id: string): boolean {
  return /^glm-/i.test(id);
}

/**
 * Vision capability, from the models.dev modalities table rather than a regex.
 *
 * The previous pattern missed the current model line: GLM-5.3-Flash and
 * GLM-5.3-FlashX are the first natively multimodal GLM-5 models, while GLM-5.3
 * itself is text-only — the reverse of what the id shape suggests. Ids absent
 * from the generated table fall back to the historical `v` / vision marker check.
 */
export function inferVisionFromModelId(id: string): boolean {
  const normalized = id.trim().toLowerCase().replace(/\[1m\]$/, '');
  if (MODEL_TOKEN_LIMITS[normalized]) {
    return VISION_MODEL_IDS.has(normalized);
  }
  return /(?:\d+(?:\.\d+)?v(?:-|$)|5v(?:-|$)|vision|vl|-ocr)/i.test(id);
}

export function resolveModelCapabilities(model: any): {
  completionChat: boolean;
  functionCalling: boolean;
  vision: boolean;
} {
  const id = typeof model?.id === 'string' ? model.id : '';
  return {
    completionChat: model?.capabilities?.completionChat ?? /^glm-/i.test(id),
    functionCalling: model?.toolCalling ?? model?.capabilities?.functionCalling ?? inferToolCallingFromModelId(id),
    vision: model?.supportsVision ?? model?.capabilities?.vision ?? inferVisionFromModelId(id),
  };
}

/**
 * Prettify a model ID into a display name when the API doesn't provide one.
 * e.g. "z-large-latest" → "Z Large Latest"
 */
export function formatModelName(id: string): string {
  return id
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Get chat model information for VS Code Language Model API
 */
export function getChatModelInfo(model: ZModel): LanguageModelChatInformation {
  const parts = model.id.split('-');
  const family = parts.length >= 2 ? `${parts[0]}-${parts[1]}` : 'z';

  return {
    id: model.id,
    name: model.name,
    family,
    detail: 'Z.ai',
    maxInputTokens: model.maxInputTokens,
    maxOutputTokens: model.maxOutputTokens,
    version: model.id,
    capabilities: {
      toolCalling: model.toolCalling,
      imageInput: model.supportsVision ?? false,
    },
  };
}
