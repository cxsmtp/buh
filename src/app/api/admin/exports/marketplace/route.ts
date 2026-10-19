import { audit } from '@/lib/server/audit';
import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError } from '@/lib/server/http';
import { marketplaceCsv } from '@/lib/server/marketplace';
import { listProducts } from '@/lib/server/products';
import { getSettings } from '@/lib/server/settings';
import { siteUrl } from '@/lib/server/siteUrl';

/**
 * "Export for Amazon / Noon" (groundwork): the products on sale as a CSV, one row per size or
 * variant (src/lib/server/marketplace.ts). Admin only; a download, never cached.
 */
export async function GET(req: Request) {
  try {
    const session = await requireAdmin(req);
    const products = listProducts();
    const csv = marketplaceCsv(products, { base: await siteUrl(), brand: getSettings('brand').storeName, categories: getSettings('catalog').categories });
    audit('export.marketplace', { by: session.email, products: products.length });
    const day = new Date().toISOString().slice(0, 10);
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="marketplace-export-${day}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    return handleRouteError(err, 'admin/exports/marketplace');
  }
}
