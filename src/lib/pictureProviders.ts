/**
 * AI pictures: the services that can make them (Settings → AI pictures), shared by the hub (the
 * picker, the setup steps, the rough cost) and the server (src/lib/server/pictures/).
 *
 * Writing (Settings → AI writing) is separate: DeepSeek can write while any of these makes pictures.
 *
 * Sources checked (2026-10-20):
 * - Google Gemini: ai.google.dev/gemini-api/docs/image-generation (image models, inline images).
 * - OpenAI: platform.openai.com/docs/guides/image-generation (POST /v1/images/edits as multipart,
 *   image[] inputs, size, quality, b64_json, gpt-image-2.5-sunburst / -flare, organisation
 *   verification, prices for gpt-image-2).
 * - fal.ai: fal.ai/docs queue API (queue.fal.run, Authorization: Key, status_url / response_url),
 *   fal CDN (data URIs accepted), errors (content_policy_violation 422), Platform API model search
 *   (api.fal.ai/v1/models), and each curated model's own page (fal.ai/models/<id>/llms.txt) for its
 *   input fields, limits and price.
 */

export const PICTURE_PROVIDERS = ['gemini', 'openai', 'fal'] as const;
export type PictureProvider = (typeof PICTURE_PROVIDERS)[number];

export interface ProviderInfo {
  id: PictureProvider;
  name: string;
  /** Where the owner makes a key. */
  keyUrl: string;
  keyUrlLabel: string;
  /** What a key looks like (shown in the field). */
  keyPlaceholder: string;
  steps: string[];
  /** A rough cost per picture, from the provider's own pages (or "see their pricing"). */
  cost: string;
  note?: string;
}

export const PROVIDER_INFO: Record<PictureProvider, ProviderInfo> = {
  gemini: {
    id: 'gemini',
    name: 'Google Gemini',
    keyUrl: 'https://aistudio.google.com/apikey',
    keyUrlLabel: 'aistudio.google.com/apikey',
    keyPlaceholder: 'AIza… or AQ.…',
    steps: ['Open Google AI Studio and sign in with your Google account.', 'Press Create API key and copy it (it starts with AIza or AQ.).', 'Paste it below, press Test, then Save.'],
    cost: 'A few US cents a picture (see Google’s Gemini API pricing).',
    note: 'Google adds its invisible SynthID watermark to every picture.',
  },
  openai: {
    id: 'openai',
    name: 'OpenAI (GPT Image)',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyUrlLabel: 'platform.openai.com/api-keys',
    keyPlaceholder: 'sk-proj-…',
    steps: ['Open the OpenAI platform and sign in.', 'Press Create new secret key and copy it (it starts with sk-).', 'Add a little credit under Billing, then paste the key below, press Test, then Save.'],
    cost: 'About 4–6 US cents a picture at medium quality (OpenAI’s published GPT Image 2 prices; newer models may differ).',
    note: 'OpenAI may ask you to verify your organisation before its GPT Image models work (platform.openai.com → Settings → Organization).',
  },
  fal: {
    id: 'fal',
    name: 'fal.ai (many models)',
    keyUrl: 'https://fal.ai/dashboard/keys',
    keyUrlLabel: 'fal.ai/dashboard/keys',
    keyPlaceholder: 'key-id:key-secret',
    steps: ['Open fal.ai, sign in and add a little credit (Billing).', 'Open Dashboard → Keys, press Add key (API scope) and copy it.', 'Paste it below, choose a model, press Test, then Save.'],
    cost: 'Depends on the model: about 3–15 US cents a picture (each model’s price is listed with it).',
    note: 'One key gives many picture models (FLUX, Nano Banana, Seedream, Qwen).',
  },
};

/** How a fal model takes its pictures and its shape. */
export interface FalModel {
  id: string;
  name: string;
  /** image_urls (a list) or image_url (one picture: no style photos). */
  input: 'image_urls' | 'image_url';
  /** How the shape is asked for. */
  size: 'aspect_ratio' | 'aspect_ratio_34' | 'image_size';
  /** Pictures it takes in all (the product and the style photos). */
  maxImages: number;
  price: string;
  note: string;
}

/**
 * A short list of fal edit models that keep the product (each checked on its fal page). Any other
 * fal model id can be typed: it is sent image_urls and no shape (most edit models take that).
 */
export const FAL_MODELS: readonly FalModel[] = [
  { id: 'fal-ai/nano-banana/edit', name: 'Nano Banana edit (Google)', input: 'image_urls', size: 'aspect_ratio', maxImages: 6, price: '$0.039 a picture', note: 'Good all-rounder; keeps prints well. Recommended.' },
  { id: 'fal-ai/nano-banana-pro/edit', name: 'Nano Banana Pro edit (Google)', input: 'image_urls', size: 'aspect_ratio', maxImages: 6, price: '$0.15 a picture', note: 'The most detailed Nano Banana; slower and dearer.' },
  { id: 'fal-ai/flux-2/edit', name: 'FLUX.2 edit', input: 'image_urls', size: 'image_size', maxImages: 4, price: 'about $0.024–0.036 a picture ($0.012 a megapixel in and out)', note: 'Takes up to 4 pictures in all (product + 3 style photos).' },
  { id: 'fal-ai/flux-2-pro/edit', name: 'FLUX.2 [pro] edit', input: 'image_urls', size: 'image_size', maxImages: 6, price: 'from $0.03 a picture (+$0.015 a megapixel)', note: 'Very photographic.' },
  { id: 'fal-ai/flux-pro/kontext/max/multi', name: 'FLUX.1 Kontext [max] multi', input: 'image_urls', size: 'aspect_ratio_34', maxImages: 6, price: '$0.08 a picture', note: 'Strong at keeping the product; 3:4 instead of 4:5.' },
  { id: 'fal-ai/bytedance/seedream/v4/edit', name: 'Seedream 4.0 edit (ByteDance)', input: 'image_urls', size: 'image_size', maxImages: 10, price: '$0.03 a picture', note: 'Takes up to 10 pictures in all.' },
  { id: 'fal-ai/bytedance/seedream/v4.5/edit', name: 'Seedream 4.5 edit (ByteDance)', input: 'image_urls', size: 'image_size', maxImages: 10, price: '$0.04 a picture', note: 'Newer Seedream; up to 10 pictures in all.' },
  { id: 'fal-ai/qwen-image-edit-plus', name: 'Qwen Image Edit Plus', input: 'image_urls', size: 'image_size', maxImages: 6, price: '$0.03 a megapixel (about $0.04 a picture)', note: 'Several input pictures; good value.' },
] as const;

export const DEFAULT_FAL_MODEL = 'fal-ai/nano-banana/edit';
export const DEFAULT_OPENAI_MODEL = 'gpt-image-2.5-sunburst';

export function falModel(id: string): FalModel {
  return FAL_MODELS.find((m) => m.id === id) ?? { id, name: id, input: 'image_urls', size: 'aspect_ratio', maxImages: 4, price: 'see the model’s page on fal.ai', note: 'Your own choice of fal model.' };
}

/** A fal model id: owner/app[/path], lower-case letters, digits, '-', '.', '/'. */
export const FAL_MODEL_ID = /^(?!.*\/\/)(?!.*\.\.)[a-z0-9-]+\/[a-z0-9.-]+(?:\/[a-z0-9.-]+){0,4}$/;
/** OpenAI image model ids (the edits endpoint takes the GPT Image models). */
export const OPENAI_IMAGE_MODEL_ID = /^(?:gpt-image|chatgpt-image)[a-z0-9.-]{0,60}$/;
/** OpenAI keys: sk-…, sk-proj-…, sk-svcacct-…. */
export const OPENAI_KEY = /^sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,250}$/;
export const OPENAI_KEY_HINT = 'An OpenAI API key starts with sk- (platform.openai.com/api-keys).';
/** fal keys: key-id:key-secret. */
export const FAL_KEY = /^[A-Za-z0-9_-]{8,80}:[A-Za-z0-9_-]{16,128}$/;
export const FAL_KEY_HINT = 'A fal.ai key looks like key-id:key-secret (fal.ai/dashboard/keys).';
