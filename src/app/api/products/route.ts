import { json, handleRouteError } from '@/lib/server/http';
import { listProducts } from '@/lib/server/products';

/** The live catalogue (hidden products left out). */
export function GET() {
  try {
    // Shoppers get the product as shown: not whether it is shown, nor the owner's review marks and kept-aside values.
    const products = listProducts().map(({ active: _active, measurementsReview: _review, legacyMeasurements: _legacy, ...p }) => {
      void _active;
      void _review;
      void _legacy;
      // A size's packed weight is for the parcel only: not sent to shoppers.
      return { ...p, profiles: p.profiles.map(({ weightGrams: _w, ...s }) => (void _w, s)) };
    });
    return json({ products });
  } catch (err) {
    return handleRouteError(err, 'products');
  }
}
