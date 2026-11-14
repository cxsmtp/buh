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
    const products = listProducts().map(({ active: _active, measurementsReview: _review, legacyMeasurements: _legacy, marketplaceSku: _market, sku: _sku, rawOriginalImage: _raw, aiStagingPrompt: _prompt, rating: _rating, reviewsCount: _reviews, updatedAt: _saved, weaveSuggestion: _guess, stagedPhotos, giftLines, ...p }) => {
      // Nor the owner's working details: stock codes, the camera original, the AI prompt.
      void _sku;
      // Nor when it was last saved, nor the AI's guess at the weave (the owner's to accept or not).
      void _saved;
      void _guess;
      // Nor a rating or review count: the shop collects no reviews, so none is ever shown or sent.
      void _rating;
      void _reviews;
      void _raw;
      void _prompt;
      void _market;
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
