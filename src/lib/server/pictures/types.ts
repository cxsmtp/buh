import type { PictureProvider } from '@/lib/pictureProviders';

/** Where the owner fixes a picture service's key or model. */
export const PLACE = 'Settings → AI pictures';

export interface InputImage {
  mime: string;
  bytes: Buffer;
}

export interface EditInput {
  key: string;
  model: string;
  /** The product photo: always first. */
  product: InputImage;
  /** Style photos, in the owner's order, after it. */
  references: InputImage[];
  prompt: string;
  aspect: '4:5' | '1:1';
  /** A second paid call is about to be made for this picture (counted against the hour's limit). */
  again: () => void;
}

/** One picture service (src/lib/server/pictures/<id>.ts). */
export interface PictureModule {
  id: PictureProvider;
  /** In messages: "Gemini", "OpenAI", "fal.ai". */
  name: string;
  /** How many pictures one request may take in all (the product and the style photos) for this model. */
  maxImages: (model: string) => number;
  /** Test: the image models this key can use, and the one to choose when the owner hasn't. */
  listModels: (key: string) => Promise<{ models: string[]; suggested: string }>;
  /** The picture's bytes (checked and stored by the caller). */
  edit: (input: EditInput) => Promise<Buffer>;
}
