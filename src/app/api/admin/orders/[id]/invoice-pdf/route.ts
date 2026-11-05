import { requireAdmin, requireReader } from '@/lib/server/guard';
import { allowFields, handleRouteError, HttpError, json, readJsonBody } from '@/lib/server/http';
import { emailInvoice, invoiceFileName, invoicePdf, issueOrderInvoice, noteInvoiceShared, regenerateOrderInvoice } from '@/lib/server/invoices';
import { getOrder } from '@/lib/server/orders';

const ACTIONS = ['issue', 'regenerate', 'email', 'shared'] as const;

/** The order's PDF invoice, once issued (the owner, or the accountant: read-only). Never cached. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireReader(req);
    const { id } = await params;
    const made = /^BUH-[A-Z0-9-]{4,40}$/.test(id) ? invoicePdf(id) : null;
    if (!made) return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
    return new Response(new Uint8Array(made.pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${invoiceFileName(made.number)}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (err) {
    return handleRouteError(err, 'admin/orders/invoice-pdf');
  }
}

/**
 * The owner: "issue" the order's invoice (the same one again if already issued), "regenerate" it
 * (same number, made again from the order now; the earlier version kept), "email" it to the
 * customer (the PDF attached), or note "shared" (sent on WhatsApp). Checked against the order on
 * the server, numbered and audited before it is reported done.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAdmin(req);
    const { id } = await params;
    const body = await readJsonBody(req, 256);
    allowFields(body, ['action']);
    const action = body.action as (typeof ACTIONS)[number];
    if (!ACTIONS.includes(action)) throw new HttpError(400, 'Action must be "issue", "regenerate", "email" or "shared".');
    if (!/^BUH-[A-Z0-9-]{4,40}$/.test(id) || !getOrder(id)) throw new HttpError(404, 'Order not found.');
    if (action === 'issue') {
      const { invoice, created } = issueOrderInvoice(id, session.email);
      return json({ invoice, created });
    }
    if (action === 'regenerate') return json(regenerateOrderInvoice(id, session.email));
    if (action === 'shared') return json({ invoice: noteInvoiceShared(id, session.email) });
    const result = await emailInvoice(id, session.email);
    if (!result.emailed) {
      const message = result.reason === 'no_email' ? 'This customer gave no email: send the invoice on WhatsApp instead.' : 'Email is not set up (Settings → Email): send the invoice on WhatsApp instead.';
      return json({ invoice: result.invoice, emailed: false, code: result.reason, message }, 409);
    }
    return json({ invoice: result.invoice, emailed: true });
  } catch (err) {
    return handleRouteError(err, 'admin/orders/invoice-pdf');
  }
}
