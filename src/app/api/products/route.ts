import { json, handleRouteError } from '@/lib/server/http';
import { listProducts } from '@/lib/server/products';
import { getSettings } from '@/lib/server/settings';
import { EVERYDAY, themedFestivalId } from '@/lib/server/giftLines';

/** The live catalogue (hidden products left out). */
export function GET() {
  try {
    // "Styled image" tags (Settings → AI writing → Label styled photos, on by default): which photos
    // were styled by AI, and nothing else about them.
    const label = getSettings('ai').labelStyledPhotos;
    // Shoppers get the product as shown: not whether it is shown, nor the owner's review marks and kept-aside values.
    // Gift lines: only today's (the festival the shop is themed for, else the everyday one).
    const festival = themedFestivalId();
    const products = listProducts().map(({ active: _active, measurementsReview: _review, legacyMeasurements: _legacy, stagedPhotos, giftLines, ...p }) => {
      void _active;
      void _review;
      void _legacy;
      const styled = label && stagedPhotos ? Object.fromEntries(Object.keys(stagedPhotos).map((url) => [url, { staged: true as const }])) : undefined;
      const giftLine = giftLines ? (festival && giftLines[festival]) || giftLines[EVERYDAY] || '' : '';
      // A size's packed weight is for the parcel only: not sent to shoppers.
      return { ...p, ...(styled ? { stagedPhotos: styled } : {}), ...(giftLine ? { giftLine } : {}), profiles: p.profiles.map(({ weightGrams: _w, ...s }) => (void _w, s)) };
    });
    return json({ products });
  } catch (err) {
    return handleRouteError(err, 'products');
  }
}
