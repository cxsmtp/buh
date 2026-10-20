/**
 * "Style in a bedroom" (product editor → Photos): the pictures the owner can ask for. Shared by the
 * editor (names, the editable scene, the fixed rules shown read-only) and the server
 * (src/lib/server/stagePhoto.ts, which writes the prompt).
 *
 * The first three are the default set made with one press, chosen to help a shopper decide: the
 * whole bed in a styled UAE bedroom, a close-up of the print and texture, and a lived-in moment.
 * The room styles after them can be chosen instead.
 */

export interface StagingPreset {
  id: string;
  name: string;
  /**
   * What the picture shows around the product (and how it is framed). The product itself is never
   * described here: it must stay exactly as photographed.
   */
  shot: string;
}

const onBed = (scene: string) => `show the bedding neatly made on a bed in ${scene}`;

export const STAGING_PRESETS: readonly StagingPreset[] = [
  {
    id: 'whole-bed',
    name: 'Whole bed (Dubai master bedroom)',
    shot:
      'show the whole set neatly made on a bed, seen at eye level from the foot of the bed, in a calm, luxurious Dubai master bedroom: an upholstered headboard, bedside lamps, a textured neutral wall and soft daylight, so the full design and how the pieces go together are clear',
  },
  {
    id: 'close-up',
    name: 'Close-up of print and texture',
    shot:
      'a close-up of the bedding on the bed: the pattern, an edge or hem and the fabric surface fill the frame, in soft, even daylight, so the craft, the print and the true colours are clear; the print scale stays as in the photo',
  },
  {
    id: 'lifestyle',
    name: 'Lifestyle moment',
    shot:
      'a lived-in, inviting moment in a bright UAE villa bedroom: the bedding on the bed with a folded throw and a breakfast tray at the foot, soft morning light; the bedding stays the clear subject, fully in focus',
  },
  {
    id: 'dubai-master',
    name: 'Dubai luxury master',
    shot: onBed(
      'a calm, luxurious master bedroom in a Dubai penthouse: a king-size bed with an upholstered headboard, warm bedside lamps, soft evening light, a polished stone floor and a textured neutral wall'
    ),
  },
  {
    id: 'palm-villa',
    name: 'Palm villa',
    shot: onBed('a bright, airy villa bedroom on the Palm Jumeirah: soft natural daylight from tall windows, light oak bedside tables, linen curtains, a few green plants and warm neutral tones'),
  },
  {
    id: 'hotel-suite',
    name: 'Hotel suite',
    shot: onBed('an elegant five-star hotel suite: a neatly made king-size bed, a padded headboard, matching bedside tables with lamps, soft even lighting and a calm, refined interior'),
  },
  {
    id: 'clean-catalogue',
    name: 'Clean catalogue (white backdrop)',
    shot: onBed('a clean catalogue photograph: the bedding neatly made on a simple bed against a seamless pure white backdrop, soft even studio lighting, no room and no props'),
  },
  {
    id: 'kids-room',
    name: "Kids' room",
    shot: onBed("a cheerful, tidy children's bedroom: a single bed, soft daylight, a few simple wooden toys and a small bookshelf, light pastel walls, nothing cluttered"),
  },
] as const;

export const STAGING_PRESET_IDS = STAGING_PRESETS.map((p) => p.id);
/** One press: the whole bed, a close-up and a lifestyle picture. */
export const DEFAULT_STAGING_SET = ['whole-bed', 'close-up', 'lifestyle'];
/** At most this many pictures with one press. */
export const STAGING_MAX_SET = 4;
export const STAGING_EXTRA_MAX = 200;
/** The owner's own wording of a picture's scene (it replaces the preset's, never the fixed rules). */
export const STAGING_SCENE_MAX = 400;

/**
 * The rules always sent, after the scene and the owner's words, whatever they say: the product
 * stays exactly as photographed (customers return what doesn't match its picture).
 */
export const STAGING_FIXED_RULES = [
  'Keep the product itself exactly as it is in the photo:',
  '- the same pattern and motif, in the same places, at the same print scale;',
  '- the same colours and shades: do not recolour, brighten, saturate or fade the fabric;',
  '- the same stitching, piping, borders, edges, folds of the fabric where visible, and texture;',
  '- the same number of pieces (sheets, pillowcases, covers): add none and remove none.',
  'The colours and pattern must stay true to the photo: shoppers buy from this picture and return what does not match it.',
  'No text, letters or numbers anywhere, no logos, no watermarks, no people or parts of people, no pets.',
] as const;

export function stagingPreset(id: unknown): StagingPreset | undefined {
  return STAGING_PRESETS.find((p) => p.id === id);
}
