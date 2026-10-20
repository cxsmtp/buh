import type { AiSettings } from '@/types';
import { GEMINI_MODEL_ID } from '@/types';
import { FAL_MODEL_ID, OPENAI_IMAGE_MODEL_ID, PROVIDER_INFO, type PictureProvider } from '@/lib/pictureProviders';
import { falPictures } from './fal';
import { geminiPictures } from './gemini';
import { openaiPictures } from './openai';
import type { PictureModule } from './types';

/**
 * AI pictures, whichever service makes them (Settings → AI pictures): Google Gemini, OpenAI or
 * fal.ai, each with its own key and model. The prompt, the limits, the checks on the picture, the
 * storage and the "Styled image" marking are the same for all (src/lib/server/stagePhoto.ts).
 */

export const PICTURE_MODULES: Record<PictureProvider, PictureModule> = { gemini: geminiPictures, openai: openaiPictures, fal: falPictures };

/** Who makes pictures: the owner's choice, else whichever key the shop has (Gemini first), else nobody yet. */
export function picturesProviderOf(ai: AiSettings): PictureProvider | '' {
  if (ai.picturesProvider) return ai.picturesProvider;
  if (ai.geminiApiKey) return 'gemini';
  if (ai.openaiApiKey) return 'openai';
  if (ai.falApiKey) return 'fal';
  return '';
}

export function pictureKey(ai: AiSettings, p: PictureProvider): string {
  return p === 'gemini' ? ai.geminiApiKey : p === 'openai' ? ai.openaiApiKey : ai.falApiKey;
}

export function pictureModel(ai: AiSettings, p: PictureProvider): string {
  return p === 'gemini' ? ai.geminiImageModel : p === 'openai' ? ai.openaiImageModel : ai.falModel;
}

export function modelOk(p: PictureProvider, model: string): boolean {
  return p === 'gemini' ? GEMINI_MODEL_ID.test(model) : p === 'openai' ? OPENAI_IMAGE_MODEL_ID.test(model) : FAL_MODEL_ID.test(model);
}

export function providerName(p: PictureProvider): string {
  return PROVIDER_INFO[p].name;
}
