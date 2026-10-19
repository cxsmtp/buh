import { enforceIpLimit } from '@/lib/server/guard';
import { handleRouteError } from '@/lib/server/http';
import { getOrder } from '@/lib/server/orders';
import { macMatches } from '@/lib/server/secrets';
import { DOCUMENT_HEADERS } from '@/lib/server/documentHeaders';
import { orderDocumentHtml } from '@/lib/server/taxDocument';

/**
 * A customer's receipt (or tax invoice, with VAT on) for their order: /invoice/<order>.<mac>, the
 * private address shown on their order confirmation. The mac is made from the server's key, so the
 * address can't be guessed from an order number; anything else is an ordinary 404. Limited per address.
 */
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    enforceIpLimit(req, 'order-document', 60, 15 * 60 * 1000, 'Too many requests. Please try again in a few minutes.');
    const token = (await params).token;
    const dot = token.lastIndexOf('.');
    const id = dot > 0 ? token.slice(0, dot) : '';
    const order = /^[A-Z0-9-]{3,30}$/.test(id) && macMatches('order-document', id, token.slice(dot + 1)) ? getOrder(id) : undefined;
    if (!order) return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
    return new Response(orderDocumentHtml(order), { headers: DOCUMENT_HEADERS });
  } catch (err) {
    return handleRouteError(err, 'invoice');
  }
}
