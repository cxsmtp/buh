/**
 * "Style in a bedroom" (product editor → Photos): the scenes the owner can choose. Shared by the
 * editor (names) and the server (src/lib/server/stagePhoto.ts, which writes the prompt).
 */

export interface StagingPreset {
  id: string;
  name: string;
  /** The setting only: the product itself is never described here (it must stay exactly as photographed). */
  scene: string;
}

export const STAGING_PRESETS: readonly StagingPreset[] = [
  {
    id: 'dubai-master',
    name: 'Dubai luxury master',
    scene:
      'a calm, luxurious master bedroom in a Dubai penthouse: a king-size bed with an upholstered headboard, warm bedside lamps, soft evening light, a polished stone floor and a textured neutral wall',
  },
  {
    id: 'palm-villa',
    name: 'Palm villa',
    scene:
      'a bright, airy villa bedroom on the Palm Jumeirah: soft natural daylight from tall windows, light oak bedside tables, linen curtains, a few green plants and warm neutral tones',
  },
  {
    id: 'hotel-suite',
    name: 'Hotel suite',
    scene:
      'an elegant five-star hotel suite: a neatly made king-size bed, a padded headboard, matching bedside tables with lamps, soft even lighting and a calm, refined interior',
  },
  {
    id: 'clean-catalogue',
    name: 'Clean catalogue (white backdrop)',
    scene:
      'a clean catalogue photograph: the bedding neatly made on a simple bed against a seamless pure white backdrop, soft even studio lighting, no room and no props',
  },
  {
    id: 'kids-room',
    name: "Kids' room",
    scene:
      "a cheerful, tidy children's bedroom: a single bed, soft daylight, a few simple wooden toys and a small bookshelf, light pastel walls, nothing cluttered",
  },
] as const;

export const STAGING_PRESET_IDS = STAGING_PRESETS.map((p) => p.id);
export const STAGING_EXTRA_MAX = 200;

export function stagingPreset(id: unknown): StagingPreset | undefined {
  return STAGING_PRESETS.find((p) => p.id === id);
}
