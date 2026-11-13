import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, HttpError } from '@/lib/server/http';
import { shopVariantSku } from '@/lib/server/marketplace';
import { listProducts } from '@/lib/server/products';
import { PER_SHEET, stickersFor, stickersPdf } from '@/lib/server/qrStickers';
import { siteUrl } from '@/lib/server/siteUrl';

const MAX_STICKERS = 2000; // 50 sheets

/**
 * QR stickers for the inventory as a PDF (A4, 40 a sheet): ?category=<id> or ?ids=<product>,…
 * (default: every product not archived, hidden ones included: they are still on the shelf);
 * ?copies=stock (one per piece in stock, the default) or one (one per size); ?start=1–40 (the
 * first free sticker on a part-used sheet). Owner only.
 */
export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    const q = new URL(req.url).searchParams;
    for (const k of q.keys()) if (!['category', 'ids', 'copies', 'start'].includes(k)) throw new HttpError(400, `Unknown option: ${k.slice(0, 40)}.`);
    const copies = q.get('copies') ?? 'stock';
    if (copies !== 'stock' && copies !== 'one') throw new HttpError(400, 'copies: stock or one.');
    const startRaw = q.get('start') ?? '1';
    const start = Number(startRaw);
    if (!Number.isInteger(start) || start < 1 || start > PER_SHEET) throw new HttpError(400, `start: 1 to ${PER_SHEET}.`);
    const category = q.get('category') ?? '';
    if (category && !/^[a-z0-9-]{1,60}$/.test(category)) throw new HttpError(400, 'Choose a category from the list.');
    const ids = (q.get('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (ids.length > 500 || ids.some((id) => !/^[A-Za-z0-9_-]{1,80}$/.test(id))) throw new HttpError(400, 'Choose products from the list.');
    let products = listProducts({ includeHidden: true });
    if (category) products = products.filter((p) => p.category === category);
    if (ids.length) products = products.filter((p) => ids.includes(p.id));
    const stickers = stickersFor(products, await siteUrl(), (p, sizeId) => shopVariantSku(p, sizeId), copies);
    if (!stickers.length) throw new HttpError(409, copies === 'stock' ? 'Nothing in stock to print a sticker for.' : 'No products to print a sticker for.', {}, { code: 'no_stickers' });
    if (stickers.length > MAX_STICKERS) throw new HttpError(400, `At most ${MAX_STICKERS} stickers at a time (${stickers.length} asked): choose a category.`);
    const pdf = stickersPdf(stickers, start - 1);
    return new Response(new Uint8Array(pdf), {
      headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="QR-stickers-${stickers.length}.pdf"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' },
    });
  } catch (err) {
    return handleRouteError(err, 'admin/qr-stickers');
  }
}
