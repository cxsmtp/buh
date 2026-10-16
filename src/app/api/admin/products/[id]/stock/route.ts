import { requireAdmin } from '@/lib/server/guard';
import { allowFields, handleRouteError, HttpError, json, readJsonBody } from '@/lib/server/http';
import { applyStockMove, listStockMoves, parseMoveRequest, undoStockMove } from '@/lib/server/stockMoves';

/**
 * Move one product's stock:
 *   { key, reason, changes: [{ sizeId, delta } | { sizeId, set }], expected: { sizeId: pieces seen }, note? }
 * or undo an earlier move: { key, undo: moveId }.
 * `key` is an idempotency key (one per tap): sending it again moves nothing and returns the
 * first answer. 409 { code: 'stock_changed' } when the stock is not what the device saw.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAdmin(req);
    const { id } = await params;
    const body = await readJsonBody(req, 4 * 1024);
    if (body.undo !== undefined) {
      allowFields(body, ['key', 'undo']);
      const result = undoStockMove(id, body.undo, body.key, session.email);
      return json({ move: result.move, product: result.product, replayed: result.replayed });
    }
    if (body.sizeId !== undefined && body.changes === undefined) throw new HttpError(400, 'This page is out of date: refresh it to change stock.');
    allowFields(body, ['key', 'reason', 'changes', 'expected', 'note']);
    const result = applyStockMove(id, parseMoveRequest(body), session.email);
    return json({ move: result.move, product: result.product, replayed: result.replayed });
  } catch (err) {
    return handleRouteError(err, 'admin/products/stock');
  }
}

/** The product's latest stock moves (who, why, old → new), newest first. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin(req);
    const { id } = await params;
    return json({ moves: listStockMoves(id, 30) });
  } catch (err) {
    return handleRouteError(err, 'admin/products/stock/list');
  }
}
