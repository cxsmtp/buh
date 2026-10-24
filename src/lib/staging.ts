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

import { FESTIVALS } from '@/lib/festivals/catalog';

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
 * The set's pieces that have their own photo (Inventory → the product → Set pieces): the bedsheet
 * photo always (image 1); a pillow cover photo and a comforter photo when the owner adds them. A set
 * without a comforter photo has no comforter in its pictures.
 */
export interface SetPieces {
  pillow?: boolean;
  comforter?: boolean;
}

/** Which image is which piece: image 1 the bedsheet, then the pillow cover, then the comforter (0: none). */
export function pieceImages(p: SetPieces = {}): { sheet: 1; pillow: number; comforter: number; count: number } {
  let n = 1;
  const pillow = p.pillow ? ++n : 0;
  const comforter = p.comforter ? ++n : 0;
  return { sheet: 1, pillow, comforter, count: n };
}

/**
 * The fixed prompt: the rules always sent after the scene and the owner's words (the owner's own
 * optimized prompt, BUH-02.26.00). The owner can fine-tune it in Settings → AI pictures → The fixed
 * prompt ('' = this default). Whatever it says, the set's pieces (which photo is which piece, a
 * comforter or none) and "never change the design or colours" are always added after it.
 */
export const DEFAULT_FIXED_PROMPT = [
  'Strict fidelity requirements:',
  '- Exact print and motif replication: copy the printed design directly from each piece’s reference photo onto that piece (the comforter, sheets and pillow covers). Retain the exact motifs, arrangement, print scale and colours without inventing, redrawing, simplifying, restyling or replacing patterns.',
  '- Colour accuracy: maintain the exact colours, shades and fabric tones of the reference photo; do not recolour, brighten, saturate or fade the fabric.',
  '- Texturing and construction: accurately render the fabric texture, stitching, piping, borders, edges and natural folds.',
  '- Component count: exactly match the pieces of this set; add no extra items, and remove none. Ensure the pillow covers display their design clearly.',
  'The colours and pattern must stay true to the photos: shoppers buy from this picture and return what does not match it.',
  'Composition and environment:',
  '- A clean, minimalist, well-lit upscale bedroom interior background that complements the bedding without distracting from it.',
  '- Single frame: one single photograph filling the entire frame from one fixed camera angle. Never a collage, grid, split screen, multiple views or framed border.',
  '- Prohibitions: absolutely no text, letters, numbers, logos, watermarks, people, parts of people or pets anywhere in the image.',
].join('\n');
export const STAGING_FIXED_PROMPT_MAX = 3000;
export const STAGING_FIXED_PROMPT_LINES = 40;

/** The owner's fixed prompt, cleaned: each line on its own (control characters and <>{}` removed), at most 40 lines. */
export function cleanFixedPrompt(v: string): string {
  return v
    .split(/\r?\n/)
    .map((l) => oneLine(l))
    .filter(Boolean)
    .slice(0, STAGING_FIXED_PROMPT_LINES)
    .join('\n');
}

/** The set's own pieces, always added after the fixed prompt (they can't be edited: they come from the photos). */
export function pieceRules(p: SetPieces = {}): string[] {
  const img = pieceImages(p);
  const from = [`the bedsheets from image 1`, `the pillow covers from image ${img.pillow || 1}`, ...(img.comforter ? [`the comforter from image ${img.comforter}`] : [])].join(', ');
  return [
    `This set's pieces (${p.comforter ? 'comforter, sheets, pillow covers' : 'sheets, pillow covers'}), each copied exactly from its own photo: ${from}.`,
    p.comforter ? `This set has a comforter: copy it from image ${img.comforter}.` : 'This set has no comforter: show none.',
    'Whatever is written above, never change the printed design or the colours of any piece.',
  ];
}

/** The rules sent after everything else: the owner's fixed prompt (or the default), then the set's pieces. */
export function fixedRules(p: SetPieces = {}, custom = ''): string[] {
  const text = cleanFixedPrompt(custom) || DEFAULT_FIXED_PROMPT;
  return [...text.split('\n'), ...pieceRules(p)];
}

/** The owner's fixed prompt ('' = the default). */
export function fixedPromptOf(p: Pick<AiPicturesSettings, 'fixedPrompt'> | undefined): string {
  return cleanFixedPrompt(p?.fixedPrompt ?? '');
}

/** The fixed rules for a set with only its bedsheet photo (shown in Settings and the studio). */
export const STAGING_FIXED_RULES: readonly string[] = fixedRules();

/** The set as it is shown (the owner's prompt): the pieces, and the pillow covers placed to be seen. */
export function setLine(p: SetPieces = {}): string {
  return `The set: ${p.comforter ? 'a plush comforter and matching bedsheets' : 'matching bedsheets (no comforter)'}, neatly arranged on a modern platform bed, with the pillow covers placed prominently: one displayed on the bed and one distinct cover placed neatly beside or in front of the bed to showcase its pattern.`;
}

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
  /** The fixed prompt, fine-tuned by the owner ('' = the shop's default, DEFAULT_FIXED_PROMPT). */
  fixedPrompt?: string;
  /** The owner's words for festival scenes, by festival id (missing = the shop's default). */
  festivalScenes?: Record<string, string>;
  /** Quick add also makes one picture in the festival scene while the shop is themed for a festival. Off by default. */
  festivalPictures?: boolean;
}

/** On the bed: only the set's own pieces (the shop's default; the owner can reword it). */
export function defaultOnBed(p: SetPieces = {}): string {
  return p.comforter
    ? 'On the bed only this set: the comforter, the bedsheet and the pillow covers, each in its own design from its photo. No other duvet, quilt, blanket, throw, bed runner, decorative cushions, extra pillows, or any textile in another design or colour.'
    : 'On the bed only this set: the bedsheet and its pillow covers, each in its own design from its photo. No comforter, duvet, quilt, blanket, throw, bed runner, decorative cushions, extra pillows, or any textile in another design or colour.';
}
export const DEFAULT_ON_BED = defaultOnBed();
export const STAGING_ON_BED_MAX = 600;

/** What may be on the bed: the owner's own words, else the default for this set's pieces. */
export function onBedOf(p: Pick<AiPicturesSettings, 'onBed'> | undefined, pieces: SetPieces = {}): string {
  return p?.onBed?.trim() ? p.onBed.trim() : defaultOnBed(pieces);
}

export const DEFAULT_SCENES: StagingScene[] = STAGING_PRESETS.map((p) => ({ id: p.id, name: p.name, scene: p.shot }));

export const DEFAULT_AI_PICTURES: AiPicturesSettings = { look: '', scenes: DEFAULT_SCENES, defaultSet: DEFAULT_STAGING_SET, references: [], useReferences: true, autoCreate: true, photoOrder: 'styled-first', sameRoom: false, onBed: '', checkPictures: true, fixedPrompt: '', festivalScenes: {}, festivalPictures: false };

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
export function stagingPrompt(
  shot: string,
  extra: string,
  aspect: string,
  context: StagingContext = {},
  look: string = DEFAULT_PICTURE_LOOK,
  references = 0,
  { angle = '', sameRoom = false, onBed, again = '', pieces = {}, fixedPrompt = '' }: { angle?: string; sameRoom?: boolean; onBed?: string; again?: string; pieces?: SetPieces; fixedPrompt?: string } = {}
): string {
  const img = pieceImages(pieces);
  // The product rules, after everything the owner wrote: what may be on the bed, and (on another
  // try) what the last picture got wrong.
  const rules = [
    `What may be on the bed (a rule): ${oneLine(onBed ?? defaultOnBed(pieces)).replace(/[.\s]+$/, '')}.`,
    ...(again ? [`The previous picture was rejected: ${oneLine(again).slice(0, 300)}. Copy every piece from its photo exactly this time.`] : []),
    'These rules come first, whatever is written above:',
    ...fixedRules(pieces, fixedPrompt),
  ];
  const about = [
    context.title ? `name: ${context.title}` : '',
    context.motif ? `motif: ${context.motif}` : '',
    context.colors?.length ? `colours: ${context.colors.join(', ')}` : '',
    context.design ? `design: ${context.design}` : '',
  ].filter(Boolean);
  // The images after the set's own photos: the same-room picture (angles only), then the style photos.
  const room = angle && sameRoom ? img.count + 1 : 0;
  const styleFrom = img.count + (room ? 1 : 0) + 1;
  const styleTo = img.count + references;
  const styleRefs = styleTo >= styleFrom ? (styleTo === styleFrom ? `Image ${styleFrom} is a style reference` : `Images ${styleFrom}–${styleTo} are style references`) : '';
  const photos = [
    'Image 1 is the bedsheet of this set',
    ...(img.pillow ? [`image ${img.pillow} is its pillow cover (the pillow covers carry exactly this design, not the bedsheet's)`] : []),
    ...(img.comforter ? [`image ${img.comforter} is its comforter`] : []),
  ].join('; ');
  const refsNames = img.count > 1 ? `Images 1–${img.count}` : 'Image 1';
  if (angle) {
    // An angle: a NEW photograph from a new camera position. An image model asked to "edit" a photo
    // keeps its camera, so every angle came back as nearly the same picture: the set's photos are the
    // reference for the bedding only, never for the camera, framing or crop.
    return [
      `Make a NEW photograph of the bedding set in ${img.count > 1 ? `images 1–${img.count}` : 'image 1'} (a luxury bedding set from a home-linen shop), dressed on a bed, taken from a new camera position.`,
      `${photos}. ${refsNames} ${img.count > 1 ? 'are' : 'is'} the reference for the product only: it is the very same set, so copy each piece's printed design, colours, stitching and pieces exactly (do not redraw or invent the pattern), but NOT the camera position, angle, framing or crop of ${img.count > 1 ? 'those photos' : 'image 1'}.`,
      setLine(pieces),
      ...(room ? [`Image ${room} is another picture of this product in its room: keep that room (bed frame, headboard, walls, floor, bedside tables, lighting), but NOT image ${room}'s camera position: the camera moves.`] : []),
      ...(styleRefs ? [`${styleRefs}: match their lighting, colour grading and mood (not their camera angle), but do not copy their bedding, people, text or logos.`] : []),
      ...(about.length ? [`About the product, so the setting suits it (the photo is the truth; nothing here changes the product): ${about.join('; ')}.`] : []),
      `The camera: ${angle.replace(/[.\s]+$/, '')}. Put the camera really there: this picture must look clearly different from image 1${room ? ` and image ${room}` : ''}, with a different camera height, direction and distance, so the bed is seen from a new side.`,
      `The setting and the look: ${oneLine(look).replace(/[.\s]+$/, '')}.`,
      ...(extra ? [`The owner's note about the setting (it never changes the product): ${extra}`] : []),
      `A realistic photograph for a high-end catalogue, ${aspect === '1:1' ? 'square' : 'portrait 4:5'} framing, with the bedding as the clear subject.`,
      ...rules,
    ].join('\n');
  }
  const more = img.count > 1 || references > 0;
  return [
    more ? 'Edit the first photograph (image 1), of a bedding product (a bed sheet or duvet cover set) from a home-linen shop.' : 'Edit this photograph of a bedding product (a bed sheet or duvet cover set) from a home-linen shop.',
    ...(img.count > 1 ? [`${photos}: copy each piece exactly.`] : []),
    ...(styleRefs ? [`${img.count > 1 ? '' : 'Image 1 is the product: copy its bedding exactly. '}${styleRefs}: match their lighting, colour grading, camera angle, room style and mood, but do not copy their bedding, people, text or logos.`] : []),
    setLine(pieces),
    ...(about.length ? [`About the product, so the setting suits it (the photo is the truth; nothing here changes the product): ${about.join('; ')}.`] : []),
    `Change only what is around it and the framing: ${shot.replace(/[.\s]+$/, '')}. You may change the bed, the room, the lighting and the props.`,
    `The look and mood: ${oneLine(look).replace(/[.\s]+$/, '')}.`,
    ...(extra ? [`The owner's note about the setting (it never changes the product): ${extra}`] : []),
    `A realistic photograph for a high-end catalogue, ${aspect === '1:1' ? 'square' : 'portrait 4:5'} framing, with the bedding as the clear subject.`,
    ...rules,
  ].join('\n');
}

// ── festival scenes ──────────────────────────────────────────────────────────

/**
 * Festival scenes (Settings → AI pictures → Festival scenes): the bedroom dressed for the festival the
 * shop is themed for (src/lib/festivals/catalog.ts), next to the standard scenes. The decorations stay
 * around the bed, never on it (only the set is on the bed), and are objects and light only: no text,
 * no people, no other textiles. Solemn days and festivals inside another (Laylat al-Qadr) have none.
 * The owner can reword each one.
 */
export const FESTIVAL_DECOR: Record<string, string> = {
  'uae-national-day': 'a bedroom on UAE National Day: a vase of red and white roses with green leaves on the bedside table, a small brass dallah and a falcon sculpture on a shelf, warm evening light',
  'uae-flag-day': 'a bright morning: fresh red and white flowers with green leaves in a vase on the bedside table, sunlight through the window',
  'emirati-womens-day': 'a graceful bedroom: fresh pink roses and an elegant perfume tray on the bedside table, soft morning light',
  'uae-mothers-day': 'a tender morning: a breakfast tray with karak chai and a bouquet of pink peonies on the bedside table, soft daylight',
  ramadan: 'a calm Ramadan evening: brass lanterns glowing on the bedside table and the floor, a bowl of dates, a crescent-moon lamp by the window, warm golden light',
  'eid-al-fitr': 'an Eid morning: a tray of sweets and dates, fresh white flowers and a glowing brass lantern on the bedside table, bright festive daylight',
  'eid-al-adha': 'a festive Eid evening: brass lanterns and a tray with a dallah and small coffee cups by the window, fresh white flowers, warm golden light',
  'islamic-new-year': 'a serene evening: a brass lantern and a crescent-moon lamp on the bedside table, soft warm light',
  'isra-miraj': 'a quiet night: a starry sky through the window and a brass lantern glowing softly on the bedside table',
  mawlid: 'a peaceful evening: a brass lantern, white flowers and a bowl of dates on the bedside table, warm soft light',
  diwali: 'a Diwali evening: clay diyas glowing along the windowsill and the bedside table, marigold garlands on the wall behind the headboard, a rangoli pattern on the floor beside the bed, warm golden light',
  holi: 'a joyful spring morning: small bowls of bright coloured powder and fresh flowers on the bedside table, cheerful daylight',
  onam: 'an Onam morning: a pookalam flower carpet on the floor beside the bed, a brass nilavilakku lamp and banana leaves in a tall vase, bright daylight',
  'navratri-dussehra': 'a festive evening: a brass diya and marigolds on the bedside table, colourful garlands on the wall, warm light',
  'raksha-bandhan': 'a warm morning: a decorated thali with a rakhi, sweets and a diya on the bedside table, soft daylight',
  'ganesh-chaturthi': 'a festive morning: a small Ganesha figurine with marigolds and a diya on a side table, warm light',
  pongal: 'a harvest morning: sugarcane stalks in a tall vase and a clay pot with marigolds on the floor beside the bed, bright sunlight',
  vishu: 'a Vishu morning: golden konna flowers, fruit and a brass lamp arranged on a side table, soft early light',
  vaisakhi: 'a bright harvest morning: golden wheat stalks in a tall vase and marigolds on the bedside table, sunny daylight',
  gurpurab: 'a peaceful evening: rows of small glowing diyas on the windowsill and white flowers on the bedside table, soft warm light',
  'lunar-new-year': 'Lunar New Year: red paper lanterns by the window, a bowl of mandarin oranges and plum blossoms in a vase on the bedside table, warm light',
  nowruz: 'a Nowruz spring morning: a small table by the window with wheatgrass sprouts, painted eggs, a mirror and fresh hyacinths, bright daylight',
  easter: 'a spring morning: a bouquet of tulips and a bowl of pastel eggs on the bedside table, fresh light',
  'orthodox-easter': 'a spring morning: a bouquet of white lilies and a bowl of red eggs on the bedside table, fresh light',
  christmas: 'a cosy Christmas evening: a decorated Christmas tree with warm lights in the corner, a wreath on the wall, candles on the bedside table, warm golden glow',
  'orthodox-christmas': 'a cosy winter evening: a decorated tree with warm lights in the corner, candles and pine branches on the bedside table, warm golden glow',
  'new-year': 'New Year’s Eve: a city skyline with fireworks through the window, golden balloons in a corner and fairy lights by the window, warm glowing light',
  'philippine-independence-day': 'a bright morning: fresh sampaguita flowers in a vase on the bedside table, sunny daylight',
  'valentines-day': 'a romantic evening: a bouquet of red roses and candles on the bedside table, soft warm light',
};
export const FESTIVAL_SCENE_PREFIX = 'festival-';
export const FESTIVAL_DECOR_MAX = 300;

/** A festival's scene: the whole set made up, the room dressed for it (the owner's words, or the shop's). */
export function festivalScene(id: string, own: Record<string, string> = {}): StagingScene | undefined {
  const festival = FESTIVALS.find((f) => f.id === id);
  const decor = (own[id] ?? '').trim() || FESTIVAL_DECOR[id];
  if (!festival || festival.solemn || festival.parent || !decor) return undefined;
  return {
    id: `${FESTIVAL_SCENE_PREFIX}${id}`,
    name: `${festival.name} — festive bedroom`,
    scene: `the whole set neatly made on a bed, seen at eye level, in ${decor.replace(/[.\s]+$/, '')}; every decoration stays around the bed, never on it`,
  };
}
