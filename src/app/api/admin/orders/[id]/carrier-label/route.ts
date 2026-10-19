import { auditOrThrow } from '@/lib/server/audit';
import { enforceLimit, requireAdmin } from '@/lib/server/guard';
import { handleRouteError, HttpError } from '@/lib/server/http';
import { jeeblyLabelFor } from '@/lib/server/jeeblyOps';
import { AWB_PATTERN, getOrder } from '@/lib/server/orders';

/**
 * Admin: the label PDF Jeebly makes for this order's booking, fetched with the keys on the server
 * (Jeebly gives no link) and passed on: only a real PDF (application/pdf, %PDF-, at most 2 MB),
 * never cached, nothing else loaded (no `sandbox`: it stops Chrome's PDF viewer). Audited before it
 * is sent. The file name is the AWB only when it is a plain one (an older order's may not be).
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAdmin(req);
    const { id } = await params;
    if (!/^BUH-[A-Z0-9-]{4,40}$/.test(id)) throw new HttpError(404, 'Order not found.');
    const order = getOrder(id);
    if (!order) throw new HttpError(404, 'Order not found.');
    enforceLimit(`carrier-label:${session.email}`, 60, 60 * 60 * 1000, 'Too many labels this hour. Please wait a little.');
    const res = await jeeblyLabelFor(order);
    if ('error' in res) throw new HttpError(502, res.error);
    auditOrThrow('courier.label_printed', { by: session.email, orderId: id, awb: res.access.awb, env: res.access.env, bytes: res.pdf.length });
    return new Response(new Uint8Array(res.pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${AWB_PATTERN.test(res.access.awb) ? res.access.awb : 'jeebly-label'}.pdf"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; object-src 'self'",
      },
    });
  } catch (err) {
    return handleRouteError(err, 'admin/orders/carrier-label');
  }
}
