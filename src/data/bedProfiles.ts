import { BedProfileMeasurement, BedSizeProfileId } from '@/types';

export const DEFAULT_BED_PROFILES: Record<BedSizeProfileId, BedProfileMeasurement> = {
  single: {
    id: 'single',
    name: 'Single / Twin Bed',
    badge: 'Single (120x200)',
    mattressSize: '120 x 200 cm (Fits 90-120 cm)',
    fittedSheet: '120 x 200 + 30 cm Elastic Pocket',
    flatSheet: '160 x 240 cm',
    pillowcases: '1 pc Standard (50 x 75 cm)',
    duvetCover: '160 x 220 cm',
    piecesIncluded: 3,
    priceDelta: 0,
  },
  double: {
    id: 'double',
    name: 'Double / Full Bed',
    badge: 'Double (140x200)',
    mattressSize: '140 x 200 cm',
    fittedSheet: '140 x 200 + 35 cm Deep Pocket',
    flatSheet: '200 x 250 cm',
    pillowcases: '2 pcs Standard (50 x 75 cm)',
    duvetCover: '200 x 220 cm',
    piecesIncluded: 4,
    priceDelta: 30,
  },
  queen: {
    id: 'queen',
    name: 'Queen Size Bed',
    badge: 'Queen (160x200)',
    mattressSize: '160 x 200 cm',
    fittedSheet: '160 x 200 + 35 cm Deep Pocket',
    flatSheet: '240 x 260 cm Luxury Drape',
    pillowcases: '2 pcs Standard (50 x 75 cm) + 2 Cushion Covers (45 x 45 cm)',
    duvetCover: '220 x 240 cm',
    cushionCovers: '2 pcs (45 x 45 cm)',
    piecesIncluded: 5,
    priceDelta: 50,
  },
  king: {
    id: 'king',
    name: 'King Size Bed (Most Popular)',
    badge: 'King (180x200)',
    mattressSize: '180 x 200 cm',
    fittedSheet: '180 x 200 + 40 cm Extra Deep Pocket',
    flatSheet: '260 x 270 cm Grand Drape',
    pillowcases: '2 pcs King (50 x 80 cm) + 2 Oxford Sham Borders',
    duvetCover: '240 x 260 cm',
    cushionCovers: '2 pcs (45 x 45 cm)',
    piecesIncluded: 5,
    priceDelta: 75,
  },
  'super-king': {
    id: 'super-king',
    name: 'Super King / Emperor Bed',
    badge: 'Super King (200x200)',
    mattressSize: '200 x 200 cm (Fits up to 210x210 cm)',
    fittedSheet: '200 x 200 + 40 cm Extra Deep Pocket',
    flatSheet: '280 x 290 cm Royal Drape',
    pillowcases: '4 pcs Royal King (50 x 90 cm)',
    duvetCover: '260 x 270 cm',
    cushionCovers: '2 pcs (45 x 45 cm)',
    piecesIncluded: 6,
    priceDelta: 110,
  },
  custom: {
    id: 'custom',
    name: 'Custom Dimensions',
    badge: 'Custom Sizing',
    mattressSize: 'Custom Dimensions upon request',
    fittedSheet: 'Custom Elastic Pocket',
    flatSheet: 'Custom Flat Sheet',
    pillowcases: 'Custom Pillowcases',
    piecesIncluded: 4,
    priceDelta: 120,
  },
};

export const ALL_BED_PROFILES_LIST = Object.values(DEFAULT_BED_PROFILES);

export function getProfileById(id: BedSizeProfileId): BedProfileMeasurement {
  return DEFAULT_BED_PROFILES[id] || DEFAULT_BED_PROFILES.king;
}
