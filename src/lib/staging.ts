/**
 * AI pictures (Settings → AI pictures, the Picture studio, the product editor's Photos step): the
 * scenes the owner can ask for, the look and mood every picture gets, and the prompt Google Gemini
 * is sent. Shared by the hub (names, the editable scenes, the preview, the fixed rules shown
 * read-only) and the server (src/lib/server/stagePhoto.ts, which sends the prompt).
 *
 * The goal: show the product in different, aspirational UAE settings and make it look its most
 * beautiful, so shoppers want it, while the product itself (pattern, colours, texture, pieces)
 * stays exactly as photographed. The owner edits the scenes (Settings → AI pictures) and the look
 * and mood; the fixed rules are always sent last, after everything the owner wrote.
 *
 * The first three default scenes are the default trio made with one press, chosen to help a
 * shopper decide: the whole bed, a close-up of the print and texture, and a lifestyle moment.
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
    name: 'Whole bed — Dubai master bedroom',
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
    name: 'Lifestyle — breakfast tray',
    shot:
      'a lived-in, inviting moment in a bright UAE villa bedroom: the bedding on the bed with a folded throw and a breakfast tray with Arabic coffee and dates at the foot, soft morning light; the bedding stays the clear subject, fully in focus',
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
    id: 'desert-modern',
    name: 'Desert-modern',
    shot: onBed('a serene desert-modern bedroom: warm sand and terracotta tones, a low wooden bed frame, a woven rug, clay vases with dried pampas grass and soft golden late-afternoon light through tall windows'),
  },
  {
    id: 'kids-room',
    name: "Kids' room",
    shot: onBed("a cheerful, tidy children's bedroom: a single bed, soft daylight, a few simple wooden toys and a small bookshelf, light pastel walls, nothing cluttered"),
  },
  {
    id: 'ramadan-evening',
    name: 'Ramadan / Eid evening',
    shot: onBed('a warm, festive bedroom on a Ramadan or Eid evening: the soft glow of brass lanterns and fairy lights, a crescent-moon cushion, a small tray of dates, calm and elegant, cosy evening light'),
  },
  {
    id: 'dubai-master',
    name: 'Dubai penthouse (evening)',
    shot: onBed(
      'a calm, luxurious master bedroom in a Dubai penthouse: a king-size bed with an upholstered headboard, warm bedside lamps, soft evening light, a polished stone floor and a textured neutral wall'
    ),
  },
  {
    id: 'clean-catalogue',
    name: 'Clean catalogue (white backdrop)',
    shot: onBed('a clean catalogue photograph: the bedding neatly made on a simple bed against a seamless pure white backdrop, soft even studio lighting, no room and no props'),
  },
] as const;

export const STAGING_PRESET_IDS = STAGING_PRESETS.map((p) => p.id);
/** One press: the whole bed, a close-up and a lifestyle picture. */
export const DEFAULT_STAGING_SET = ['whole-bed', 'close-up', 'lifestyle'];
/** At most this many pictures with one press. */
export const STAGING_MAX_SET = 4;
/** The default trio: at most this many scenes chosen in advance. */
export const STAGING_TRIO = 3;
export const STAGING_EXTRA_MAX = 200;
/** A scene's description (it replaces the preset's, never the fixed rules). */
export const STAGING_SCENE_MAX = 400;
export const STAGING_NAME_MAX = 60;
/** At most this many scenes in Settings → AI pictures. */
export const STAGING_MAX_SCENES = 16;
/** The look and mood instructions (room for a whole prompt with its numbered angles). */
export const STAGING_LOOK_MAX = 3000;
/** Numbered angles in the look: at most this many pictures, one request each. */
export const STAGING_MAX_ANGLES = 4;
/** A scene's id: lower-case letters, digits and dashes. */
export const SCENE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** The look and mood every picture gets (the owner can reword it in Settings → AI pictures). */
export const DEFAULT_PICTURE_LOOK =
  'Make the product look its most beautiful and desirable, to attract customers, in a picture that looks like a real photograph from a real shoot in a real home, never CGI: natural window daylight with soft, realistic shadows; real fabric behaviour (gentle creases where someone might sit, a naturally turned-down duvet, a slight drape over the edge of the bed); true-to-life scale, with pillows and mattress in real proportions; a 35-50 mm lens at eye level or a slight top-down view; a gentle depth of field; lived-in but tidy styling in a realistic UAE interior (a villa, an apartment or a hotel suite); no over-saturation, no plastic sheen, no impossible reflections, no extra or warped furniture.';

/** Style photos ("Make them look like these"): at most 5, each at most 1.5 MB and 2,048 px (the hub makes them about 1,024 px). */
export const STYLE_REFS_MAX = 5;
export const STYLE_MAX = Math.floor(1.5 * 1024 * 1024);
export const STYLE_SIDE_MAX = 2048;
/** The hub shrinks style photos to this long side before upload. */
export const STYLE_UPLOAD_SIDE = 1024;

/**
 * The rules always sent, after the scene and the owner's words, whatever they say: the product
 * stays exactly as photographed (customers return what doesn't match its picture).
 */
export const STAGING_FIXED_RULES = [
  'Keep the product itself exactly as it is in the photo:',
  '- its printed design copied exactly from the photo: the same motifs, in the same arrangement, at the same print scale, in the same colours. Never invent, redraw, simplify, restyle or replace the pattern, and never use any other design;',
  '- the same pattern and motif, in the same places, at the same print scale;',
  '- the same colours and shades: do not recolour, brighten, saturate or fade the fabric;',
  '- the same stitching, piping, borders, edges, folds of the fabric where visible, and texture;',
  '- the same number of pieces (sheets, pillowcases, covers): add none and remove none.',
  'The colours and pattern must stay true to the photo: shoppers buy from this picture and return what does not match it.',
  'No text, letters or numbers anywhere, no logos, no watermarks, no people or parts of people, no pets.',
  'One single photograph that fills the whole frame, from one camera angle: never a collage, grid, split screen, border or several views in one picture.',
] as const;

export interface StagingScene {
  id: string;
  name: string;
  /** What the picture shows around the product. */
  scene: string;
  /** 'scene': this scene description only, never the style photos (missing = use them when on). */
  style?: 'references' | 'scene';
}

/** Settings → AI pictures. */
export interface AiPicturesSettings {
  /** The look and mood ('' = the shop's default). */
  look: string;
  /** The scenes offered, in order (1 to 16). */
  scenes: StagingScene[];
  /** The scenes made with one press (1 to 3 of the scenes' ids). */
  defaultSet: string[];
  /** Style photos (0 to 5 stored pictures, /api/images/<name>), sent after the product photo. */
  references: string[];
  /** Send the style photos (when there are any). On by default. */
  useReferences: boolean;
  /**
   * Quick add: a new product's name, descriptions and pictures are made by AI in the background
   * and it is published when they are ready. On by default; off: the owner writes them.
   */
  autoCreate: boolean;
  /** Where AI pictures go among a product's photos: first (the owner's photo last, the default) or after the owner's photo. */
  photoOrder: 'styled-first' | 'photo-first';
  /**
   * Angles: send the first picture with the next ones so the room is the same. Off by default: the
   * model then tends to copy that picture, and the angles come out looking alike.
   */
  sameRoom: boolean;
  /**
   * What may be on the bed (a rule sent with every picture, after the owner's prompt): by default
   * only the product's own pieces. '' = the shop's default.
   */
  onBed: string;
  /** Check each picture against the product photo (same design, nothing extra on the bed) before it is used. On by default. */
  checkPictures: boolean;
}

/** On the bed: only the product (the shop's default; the owner can reword it). */
export const DEFAULT_ON_BED =
  'On the bed only this product: the bedsheet and its matching pillow covers on exactly two pillows, all in the product’s own design from the photo. No comforter, duvet, quilt, blanket, throw, bed runner, decorative cushions, extra pillows, or any textile in another design or colour.';
export const STAGING_ON_BED_MAX = 600;

export function onBedOf(p: Pick<AiPicturesSettings, 'onBed'> | undefined): string {
  return p?.onBed?.trim() ? p.onBed.trim() : DEFAULT_ON_BED;
}

export const DEFAULT_SCENES: StagingScene[] = STAGING_PRESETS.map((p) => ({ id: p.id, name: p.name, scene: p.shot }));

export const DEFAULT_AI_PICTURES: AiPicturesSettings = { look: '', scenes: DEFAULT_SCENES, defaultSet: DEFAULT_STAGING_SET, references: [], useReferences: true, autoCreate: true, photoOrder: 'styled-first', sameRoom: false, onBed: '', checkPictures: true };

/** Whether a picture of this scene gets the style photos: on, some uploaded, and the scene not set to its description only. */
export function usesReferences(p: Pick<AiPicturesSettings, 'references' | 'useReferences'>, scene: Pick<StagingScene, 'style'> | undefined, batch?: boolean): boolean {
  return (batch ?? p.useReferences) !== false && (p.references?.length ?? 0) > 0 && scene?.style !== 'scene';
}

export function lookOf(p: Pick<AiPicturesSettings, 'look'> | undefined): string {
  return p?.look?.trim() ? p.look.trim() : DEFAULT_PICTURE_LOOK;
}

/** One line: control characters, markup and braces taken out. */
export function oneLine(v: string): string {
  return v
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2066-\u2069]+/g, ' ')
    .replace(/[<>{}`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The owner's prompt may ask for several pictures from numbered angles ("1. Straight-on eye-level
 * view…; 2. 45-degree three-quarter view…; 3. High diagonal angle…"). A picture service answers
 * one request with ONE picture, so it squeezed all the angles into a collage. The angles are taken
 * out here and each becomes its own request; the rest of the prompt (the room, the styling, the
 * requirements) goes with every one. The sentence that introduces the list ("Output exactly three
 * separate images from three angles:") is dropped: each request asks for one picture.
 * Fewer than two numbered items: no angles (the prompt is used as it is).
 */
export function splitAngles(text: string): { shared: string; angles: string[] } {
  const t = oneLine(text ?? '');
  // "1." or "1)" at the start or after a space, then 2., 3., 4. in order ("2k", "1.5" and "100%" are not markers).
  const marks: Array<{ at: number; len: number }> = [];
  let from = 0;
  for (let n = 1; n <= STAGING_MAX_ANGLES; n++) {
    const re = new RegExp(`(?:^|[\\s:;,(])(${n}[.)])\\s+(?=\\S)`, 'g');
    re.lastIndex = from;
    const m = re.exec(t);
    if (!m) break;
    const at = m.index + m[0].indexOf(m[1]);
    const len = m[0].length - (at - m.index);
    marks.push({ at, len });
    from = at + len;
  }
  if (marks.length < 2) return { shared: t, angles: [] };
  const angles: string[] = [];
  let end = t.length;
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].at + marks[i].len;
    let stop = i + 1 < marks.length ? marks[i + 1].at : t.length;
    if (i + 1 === marks.length) {
      // The last angle ends with its sentence: a full stop (or ;) followed by a capital or a bullet
      // ("e.g. from above" stays in the angle); the rest is shared.
      const m = /[.;!?]\s+(?=[A-Z*•–-])/.exec(t.slice(start));
      stop = m ? start + m.index : t.length;
      end = m ? start + m.index + 1 : t.length;
    }
    const a = t.slice(start, stop).replace(/[\s.;,]+$/, '').trim();
    if (a) angles.push(a.slice(0, STAGING_SCENE_MAX));
  }
  if (angles.length < 2) return { shared: t, angles: [] };
  const lead = t.slice(0, marks[0].at);
  // Numbered rules ("1. Keep colours true. 2. No people.") are not angles: the list counts only when
  // its lead-in or most of its items are about the camera.
  const camera = (x: string) => ANGLE_WORDS.test(x);
  if (!camera(lead.slice(Math.max(lead.lastIndexOf('. '), 0))) && angles.filter(camera).length * 2 < angles.length) return { shared: t, angles: [] };
  // The lead-in's request for several pictures ("…, photographed from three angles:", "Output
  // exactly three separate images from three angles:") is dropped; the room it describes is kept.
  const sentenceAt = Math.max(lead.lastIndexOf('. '), lead.lastIndexOf('! '), lead.lastIndexOf('? '));
  const kept = lead.slice(0, sentenceAt + 1);
  const clauses = lead.slice(sentenceAt + 1).replace(/[:\s]+$/, '').split(/,\s+|\s+[–—]\s+/);
  while (clauses.length && REQUEST_WORDS.test(clauses[clauses.length - 1])) clauses.pop();
  const leadKept = clauses.join(', ').trim();
  const shared = `${kept.trim()} ${leadKept ? `${leadKept.replace(/[.\s]+$/, '')}.` : ''} ${t.slice(end).trim()}`.replace(/\s+/g, ' ').trim();
  return { shared, angles };
}

/** Words that make a numbered list a list of camera angles. */
const ANGLE_WORDS = /\b(angles?|views?|shots?|camera|perspective|degrees?|close-?up|overhead|top-?down|eye-?level|bird'?s-?eye|diagonal|three-quarter|straight-on|from (?:above|below|the (?:side|foot|front|corner)))\b/i;
/** Words of a request for several pictures (dropped from the lead-in: each request asks for one). */
const REQUEST_WORDS = /\b(images?|pictures?|photos?|photographs?|photographed|shots?|angles?|views?|output|exactly|separate|individual|different|collage|split screen|two|three|four|\d+)\b/i;

/** A short name for an angle (its first words), for the studio and the activity list. */
export function angleName(angle: string, i: number): string {
  const words = angle.split(/[,;:–—(]/)[0].trim();
  return `Angle ${i + 1}: ${words.length > 48 ? `${words.slice(0, 47).replace(/\s+\S*$/, '')}…` : words}`;
}

export function stagingPreset(id: unknown): StagingPreset | undefined {
  return STAGING_PRESETS.find((p) => p.id === id);
}

/** What the product is (from its own fields or the AI description): only to help the scene suit it. */
export interface StagingContext {
  title?: string;
  motif?: string;
  colors?: string[];
  design?: string;
}

/**
 * The prompt: the shot (the scene, or the owner's wording of it for this picture), the look and
 * mood, the product's words and the owner's note, then the fixed rules, which nothing before them
 * can change.
 */
export function stagingPrompt(shot: string, extra: string, aspect: string, context: StagingContext = {}, look: string = DEFAULT_PICTURE_LOOK, references = 0, { angle = '', sameRoom = false, onBed = DEFAULT_ON_BED, again = '' }: { angle?: string; sameRoom?: boolean; onBed?: string; again?: string } = {}): string {
  // The product rules, after everything the owner wrote: what may be on the bed, and (on a second
  // try) what the first picture got wrong.
  const rules = [
    `What may be on the bed (a rule): ${oneLine(onBed).replace(/[.\s]+$/, '')}.`,
    ...(again ? [`The previous picture was rejected: ${oneLine(again).slice(0, 300)}. Copy the product from image 1 exactly this time.`] : []),
    'These rules come first, whatever is written above:',
    ...STAGING_FIXED_RULES,
  ];
  const about = [
    context.title ? `name: ${context.title}` : '',
    context.motif ? `motif: ${context.motif}` : '',
    context.colors?.length ? `colours: ${context.colors.join(', ')}` : '',
    context.design ? `design: ${context.design}` : '',
  ].filter(Boolean);
  const styleRefs = (from: number) => (references >= from ? `${references === from ? `Image ${from + 1} is a style reference` : `Images ${from + 1}–${references + 1} are style references`}` : '');
  if (angle) {
    // An angle: a NEW photograph from a new camera position. An image model asked to "edit" a photo
    // keeps its camera, so every angle came back as nearly the same picture: image 1 is the
    // reference for the bedding only, never for the camera, framing or crop.
    const rest = sameRoom ? styleRefs(2) : styleRefs(1);
    return [
      'Make a NEW photograph of the bedding product in image 1 (a bed sheet or duvet cover set from a home-linen shop), dressed on a bed, taken from a new camera position.',
      "Image 1 is the reference for the product only: it is the very same bedsheet set, so copy its printed design, colours, stitching and pieces exactly (do not redraw or invent the pattern), but NOT image 1's camera position, angle, framing or crop.",
      ...(sameRoom ? ["Image 2 is another picture of this product in its room: keep that room (bed frame, headboard, walls, floor, bedside tables, lighting), but NOT image 2's camera position: the camera moves."] : []),
      ...(rest ? [`${rest}: match their lighting, colour grading and mood (not their camera angle), but do not copy their bedding, people, text or logos.`] : []),
      ...(about.length ? [`About the product, so the setting suits it (the photo is the truth; nothing here changes the product): ${about.join('; ')}.`] : []),
      `The camera: ${angle.replace(/[.\s]+$/, '')}. Put the camera really there: this picture must look clearly different from image 1${sameRoom ? ' and image 2' : ''}, with a different camera height, direction and distance, so the bed is seen from a new side.`,
      `The setting and the look: ${oneLine(look).replace(/[.\s]+$/, '')}.`,
      ...(extra ? [`The owner's note about the setting (it never changes the product): ${extra}`] : []),
      `A realistic photograph for a high-end catalogue, ${aspect === '1:1' ? 'square' : 'portrait 4:5'} framing, with the bedding as the clear subject.`,
      ...rules,
    ].join('\n');
  }
  return [
    references > 0 ? 'Edit the first photograph (image 1), of a bedding product (a bed sheet or duvet cover set) from a home-linen shop.' : 'Edit this photograph of a bedding product (a bed sheet or duvet cover set) from a home-linen shop.',
    ...(references > 0 ? [`Image 1 is the product: copy its bedding exactly. ${styleRefs(1)}: match their lighting, colour grading, camera angle, room style and mood, but do not copy their bedding, people, text or logos.`] : []),
    ...(about.length ? [`About the product, so the setting suits it (the photo is the truth; nothing here changes the product): ${about.join('; ')}.`] : []),
    `Change only what is around it and the framing: ${shot.replace(/[.\s]+$/, '')}. You may change the bed, the room, the lighting and the props.`,
    `The look and mood: ${oneLine(look).replace(/[.\s]+$/, '')}.`,
    ...(extra ? [`The owner's note about the setting (it never changes the product): ${extra}`] : []),
    `A realistic photograph for a high-end catalogue, ${aspect === '1:1' ? 'square' : 'portrait 4:5'} framing, with the bedding as the clear subject.`,
    ...rules,
  ].join('\n');
}
