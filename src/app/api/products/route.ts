import { json, handleRouteError } from '@/lib/server/http';
import { listProducts } from '@/lib/server/products';

/** The live catalogue (hidden products left out). */
export function GET() {
  try {
    // Shoppers get the product as shown: not whether it is shown, nor the owner's review marks.
    const products = listProducts().map(({ active: _active, measurementsReview: _review, ...p }) => {
      void _active;
      void _review;
      return p;
    });
    return json({ products });
  } catch (err) {
    return handleRouteError(err, 'products');
  }
}
