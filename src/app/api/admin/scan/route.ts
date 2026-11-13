import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, HttpError, json } from '@/lib/server/http';
import { shopSku, shopVariantSku } from '@/lib/server/marketplace';
import { listOrders } from '@/lib/server/orders';
import { getProduct, listProducts, type StoredProduct } from '@/lib/server/products';
import { parseScan } from '@/lib/server/qrStickers';

const OPEN = ['pending_confirmation', 'pending_payment', 'confirmed', 'dispatched', 'out_for_delivery'];

/**
 * What a scanned sticker (or a typed stock code) is: ?code=<what the camera read>. The product,
 * the size, its photo and stock, and the open orders waiting for it. Owner only; read only.
 */
export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    const read = parseScan(new URL(req.url).searchParams.get('code') ?? '');
    if (!read) throw new HttpError(400, 'Not a shop sticker: scan a QR code from the stickers, or type the stock code.', {}, { code: 'not_ours' });
    let product: StoredProduct | undefined;
    let sizeId: string | undefined;
    if ('productId' in read) {
      product = getProduct(read.productId);
      sizeId = read.sizeId;
    } else {
      for (const p of listProducts({ includeHidden: true, includeArchived: true })) {
        if (shopSku(p) === read.code) {
          product = p;
          break;
        }
        const prof = p.profiles.find((s) => shopVariantSku(p, s.id) === read.code);
        if (prof) {
          product = p;
          sizeId = prof.id;
          break;
        }
      }
    }
    if (!product) throw new HttpError(404, 'No product has this code (it may have been deleted).', {}, { code: 'unknown_item' });
    const size = sizeId ? product.profiles.find((s) => s.id === sizeId) : undefined;
    if (sizeId && !size) throw new HttpError(404, `${product.title} has no size "${sizeId}" any more.`, {}, { code: 'unknown_size' });
    const p = product;
    const waiting = listOrders({ limit: 2000 })
      .filter((o) => OPEN.includes(o.status))
      .flatMap((o) =>
        o.items
          .filter((i) => i.productId === p.id && (!size || i.profileId === size.id))
          .map((i) => ({ orderId: o.id, customer: o.customer.fullName, status: o.status, quantity: i.quantity, sizeName: i.profileName, createdAt: o.createdAt }))
      );
    return json({
      item: {
        productId: p.id,
        title: p.title,
        image: p.featuredImage || p.galleryImages?.[0] || '',
        active: p.active !== false,
        archived: Boolean((p as { archived?: boolean }).archived),
        code: size ? shopVariantSku(p, size.id) : shopSku(p),
        ...(size ? { sizeId: size.id, sizeName: size.name, stock: p.stockBySize?.[size.id] ?? 0 } : {}),
        sizes: p.profiles.map((s) => ({ id: s.id, name: s.name, stock: p.stockBySize?.[s.id] ?? 0, code: shopVariantSku(p, s.id) })),
      },
      waiting,
    });
  } catch (err) {
    return handleRouteError(err, 'admin/scan');
  }
}
