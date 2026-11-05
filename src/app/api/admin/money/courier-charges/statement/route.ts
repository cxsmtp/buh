import { applyStatement, readStatement } from '@/lib/server/courierCharges';
import { requireAdmin } from '@/lib/server/guard';
import { allowFields, handleRouteError, HttpError, json, readJsonBody } from '@/lib/server/http';

/**
 * Jeebly's statement (the CSV from the Jeebly portal): { csv, apply }. Without apply: what would be
 * added or changed (nothing saved). With apply: each shipment's charge becomes its courier expense
 * (once; a changed figure updates it, the earlier version kept). Audited.
 */
export async function POST(req: Request) {
  try {
    const session = await requireAdmin(req);
    const body = await readJsonBody(req, 3 * 1024 * 1024);
    allowFields(body, ['csv', 'apply']);
    if (typeof body.csv !== 'string' || !body.csv.trim()) throw new HttpError(400, "Choose Jeebly's statement (a CSV file).");
    if (body.apply !== undefined && typeof body.apply !== 'boolean') throw new HttpError(400, 'apply must be true or false.');
    if (body.apply) return json({ saved: applyStatement(body.csv, session.email) });
    const { rows, skipped, columns } = readStatement(body.csv);
    return json({ preview: { rows: rows.slice(0, 300), count: rows.length, totalFils: rows.reduce((a, r) => a + r.amountFils, 0), skipped, columns } });
  } catch (err) {
    return handleRouteError(err, 'admin/money/courier-charges/statement');
  }
}
