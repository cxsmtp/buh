import { emailLabels, labelContext, labelsPdf, ordersForLabels } from '@/lib/server/labelPdf';
import { requireAdmin } from '@/lib/server/guard';
import { allowFields, handleRouteError, HttpError, json, readJsonBody } from '@/lib/server/http';
import { getSettings } from '@/lib/server/settings';
import type { LabelPaper } from '@/types';

const PAPERS: LabelPaper[] = ['a4', 'a5', '4x6'];
const paperOf = (v: unknown, fallback?: LabelPaper): LabelPaper => {
  if (v === undefined || v === null || v === '') return fallback ?? getSettings('courier').labelPaper ?? 'a5';
  if (!PAPERS.includes(v as LabelPaper)) throw new HttpError(400, 'Paper: a4, a5 or 4x6.');
  return v as LabelPaper;
};

/**
 * The shipping labels as a PDF: ?ids=BUH-…,BUH-… (at most 40), or none for every booked order not
 * yet dispatched; ?paper=a4 (two A5 labels per A4 sheet), a5 or 4x6 (default: Couriers → Label paper).
 */
export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    const q = new URL(req.url).searchParams;
    const paper = paperOf(q.get('paper'));
    const orders = await ordersForLabels(q.get('ids') ?? undefined);
    if (!orders.length) throw new HttpError(409, 'No labels to print: no booked order is waiting for dispatch.', {}, { code: 'no_labels' });
    const pdf = labelsPdf(orders, paper, await labelContext());
    const name = orders.length === 1 ? `Label-${orders[0].id}.pdf` : `Labels-${orders.length}.pdf`;
    return new Response(new Uint8Array(pdf), { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${name}"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
  } catch (err) {
    return handleRouteError(err, 'admin/labels');
  }
}

/**
 * "Email to printer": { ids?, paper?, carrier? } → the PDF (ours, or with carrier: Jeebly's own) to Couriers → Printer email.
 * Paper defaults to A4 (two A5 labels a sheet): printers that print what is emailed take A4.
 */
export async function POST(req: Request) {
  try {
    const session = await requireAdmin(req);
    const body = await readJsonBody(req, 4096);
    allowFields(body, ['ids', 'paper', 'carrier']);
    if (body.carrier !== undefined && typeof body.carrier !== 'boolean') throw new HttpError(400, 'carrier must be true or false.');
    if (body.ids !== undefined && !Array.isArray(body.ids)) throw new HttpError(400, 'ids must be a list.');
    const result = await emailLabels(await ordersForLabels(body.ids), paperOf(body.paper, 'a4'), session.email, { carrier: body.carrier === true });
    return json({ emailed: true, ...result });
  } catch (err) {
    return handleRouteError(err, 'admin/labels/email');
  }
}
