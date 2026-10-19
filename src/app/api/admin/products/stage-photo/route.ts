import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, json, readJsonBody } from '@/lib/server/http';
import { discardStagedPhoto, stagePhoto, stagingStatus } from '@/lib/server/stagePhoto';

/** Whether "Style in a bedroom" can run (the editor explains how to add a Gemini key when not). */
export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    return json(stagingStatus());
  } catch (err) {
    return handleRouteError(err, 'admin/products/stage-photo/status');
  }
}

/**
 * "Style in a bedroom": a NEW photo of the product in a bedroom, made by Gemini from one of its
 * photos (src/lib/server/stagePhoto.ts). The original is never changed; the new photo is stored and
 * recorded as styled, and the editor shows both for the owner to add or discard.
 * Body: { imageId: "<name>" } or { image: data URL }, plus { preset, extra?, aspect? }.
 */
export async function POST(req: Request) {
  try {
    const session = await requireAdmin(req);
    // A photo of at most 4 MB as a data URL (base64 adds a third).
    const body = await readJsonBody(req, 6 * 1024 * 1024);
    const result = await stagePhoto(body, session.email);
    return json({ success: true, ...result });
  } catch (err) {
    return handleRouteError(err, 'admin/products/stage-photo');
  }
}

/** "Discard": { url } of a styled photo no product uses; its file is deleted. */
export async function DELETE(req: Request) {
  try {
    const session = await requireAdmin(req);
    const body = await readJsonBody(req, 1024);
    return json({ success: true, ...discardStagedPhoto(body, session.email) });
  } catch (err) {
    return handleRouteError(err, 'admin/products/stage-photo/discard');
  }
}
