import { openPayOrderId } from '@/lib/server/bankPay';
import { enforceIpLimit, enforceLimit } from '@/lib/server/guard';
import { allowFields, assertSameOrigin, clientIp, handleRouteError, HttpError, json, readJsonBody } from '@/lib/server/http';
import { uploadTransfer } from '@/lib/server/orders';

/** Uploads per address, and per order, in an hour: enough for a customer's retries, not a flood. */
const UPLOAD_LIMITS = { perAddress: 20, perOrder: 10, windowMs: 60 * 60 * 1000 };

/**
 * The transfer screenshot (or PDF) from an order's private page. The token in the address is the
 * proof (the front gate already answers one that opens no order as an unknown address); the file
 * is checked like a checkout receipt (its first bytes, 5 MB at most) and stored where only the
 * owner can open it. Uploading again replaces it; the 4 before it are kept. When the disk or the
 * receipts folder is too full, the customer is asked to send it on WhatsApp (507) and the owner told.
 */
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  try {
    assertSameOrigin(req);
    enforceIpLimit(req, 'pay-upload', UPLOAD_LIMITS.perAddress, UPLOAD_LIMITS.windowMs, 'Too many uploads from this connection. Please try again later.');
    const orderId = openPayOrderId((await params).token);
    if (!orderId) throw new HttpError(404, 'Not found.');
    enforceLimit(`pay-upload:order:${orderId}`, UPLOAD_LIMITS.perOrder, UPLOAD_LIMITS.windowMs, 'Too many uploads for this order. Please try again later, or send the screenshot on WhatsApp.');
    // A 5 MB file arrives base64-encoded, so allow ~7 MB.
    const body = await readJsonBody(req, 7 * 1024 * 1024);
    allowFields(body, ['file']);
    // Checked again inside (paid or cancelled meanwhile), room for it, and audited before it is saved.
    const order = uploadTransfer(orderId, body.file, { ip: clientIp(req) });
    return json({ ok: true, uploads: order.bankTransfer?.uploads ?? 0 });
  } catch (err) {
    return handleRouteError(err, 'pay/upload', { ok: false });
  }
}
