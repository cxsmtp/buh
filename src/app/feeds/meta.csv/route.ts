import { toCsv } from '@/lib/server/backup';
import { handleRouteError } from '@/lib/server/http';
import { listProducts } from '@/lib/server/products';
import { getSettings } from '@/lib/server/settings';
import { siteUrl } from '@/lib/server/siteUrl';

/**
 * Product feed for Instagram / Facebook Shopping (Meta Commerce Manager →
 * Data sources → Scheduled feed) and Google Merchant Center: one row per
 * product and size, grouped by product, with live stock.
 * https://yourdomain.ae/feeds/meta.csv
 */
export async function GET() {
  try {
    const base = await siteUrl();
    const brand = getSettings('brand').storeName;
    const abs = (u: string) => (u.startsWith('http') ? u : `${base}${u}`);
    // Styled photos (made with AI) go to Meta and Google only while the shop labels them.
    const label = getSettings('ai').labelStyledPhotos;
    const rows = listProducts().flatMap((p) =>
      p.profiles.map((s) => {
        const qty = p.stockBySize[s.id] ?? 0;
        const price = (Math.round((p.price + s.priceDelta) * 100) / 100).toFixed(2);
        return [
          `${p.id}-${s.id}`,
          `${p.title} (${s.name})`.slice(0, 150),
          (p.shortDescription || p.description || p.title).slice(0, 5000),
          qty > 0 ? 'in stock' : 'out of stock',
          qty,
          'new',
          `${price} AED`,
          `${base}/p/${encodeURIComponent(p.id)}`,
          abs(p.aiTransformedImage || p.featuredImage),
          p.galleryImages
            .filter((u) => label || !p.stagedPhotos?.[u])
            .slice(0, 10)
            .map(abs)
            .join(','),
          brand,
          p.id,
          s.name,
          p.colors[0]?.name ?? '',
          p.material,
        ];
      })
    );
    const csv = toCsv(
      ['id', 'title', 'description', 'availability', 'quantity_to_sell_on_facebook', 'condition', 'price', 'link', 'image_link', 'additional_image_link', 'brand', 'item_group_id', 'size', 'color', 'material'],
      rows
    );
    return new Response(csv, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'public, max-age=900' } });
  } catch (err) {
    return handleRouteError(err, 'feeds/meta');
  }
}
