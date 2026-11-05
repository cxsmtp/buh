import { enforceIpLimit } from '@/lib/server/guard';
import { handleRouteError } from '@/lib/server/http';
import { invoiceFileName, invoicePdf } from '@/lib/server/invoices';
import { macMatches } from '@/lib/server/secrets';

/**
 * The customer's PDF invoice: /invoice/<order>.<mac>/pdf, the private link the shop sends (by email
 * and WhatsApp). The mac is made from the server's key; an invoice not issued yet, or anything else,
 * is an ordinary 404. Limited per address; no referrer, never cached, not for search engines.
 */
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    enforceIpLimit(req, 'order-document', 60, 15 * 60 * 1000, 'Too many requests. Please try again in a few minutes.');
    const token = (await params).token;
    const dot = token.lastIndexOf('.');
    const id = dot > 0 ? token.slice(0, dot) : '';
    const made = /^[A-Z0-9-]{3,30}$/.test(id) && macMatches('order-document', id, token.slice(dot + 1)) ? invoicePdf(id) : null;
    if (!made) return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
    return new Response(new Uint8Array(made.pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${invoiceFileName(made.number)}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'X-Robots-Tag': 'noindex, nofollow',
      },
    });
  } catch (err) {
    return handleRouteError(err, 'invoice/pdf');
  }
}
