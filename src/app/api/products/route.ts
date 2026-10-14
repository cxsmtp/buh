import { json, handleRouteError } from '@/lib/server/http';
import { listProducts } from '@/lib/server/products';

/** The live catalogue (hidden products left out). */
export function GET() {
  try {
    const products = listProducts().map(({ active: _active, ...p }) => {
      void _active;
      return p;
    });
    return json({ products });
  } catch (err) {
    return handleRouteError(err, 'products');
  }
}
