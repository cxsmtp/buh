import { audit } from '@/lib/server/audit';
import { requireAdmin } from '@/lib/server/guard';
import { allowFields, handleRouteError, HttpError, json, readJsonBody } from '@/lib/server/http';
import { currentLook, earlierLooks, saveLook, switchBackLook } from '@/lib/server/look';

/**
 * Settings → Look. GET: the current look (with when and by whom) and the earlier ones.
 * PUT { preset, mode }: choose a look. POST { switchBack: id }: put an earlier look back exactly.
 * The preset and mode are checked against the allow-lists on the server (src/lib/server/settings.ts),
 * the time is the server's, and the admin is the signed-in one; every change is audited.
 */
export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    return json({ current: currentLook(), earlier: earlierLooks() });
  } catch (err) {
    return handleRouteError(err, 'admin/look');
  }
}

export async function PUT(req: Request) {
  try {
    const session = await requireAdmin(req);
    const body = await readJsonBody(req, 1024);
    allowFields(body, ['preset', 'mode']);
    const before = currentLook();
    const look = await saveLook({ preset: body.preset, mode: body.mode }, session.email);
    audit('look.changed', { by: session.email, from: { preset: before.preset, mode: before.mode }, to: { preset: look.preset, mode: look.mode } });
    return json({ success: true, current: look, earlier: earlierLooks() });
  } catch (err) {
    return handleRouteError(err, 'admin/look/update');
  }
}

export async function POST(req: Request) {
  try {
    const session = await requireAdmin(req);
    const body = await readJsonBody(req, 256);
    allowFields(body, ['switchBack']);
    if (!Number.isInteger(body.switchBack) || (body.switchBack as number) < 1) throw new HttpError(400, 'Give the look to switch back to.');
    const before = currentLook();
    const look = await switchBackLook(body.switchBack as number, session.email);
    audit('look.switched_back', { by: session.email, versionId: body.switchBack, from: { preset: before.preset, mode: before.mode }, to: { preset: look.preset, mode: look.mode } });
    return json({ success: true, current: look, earlier: earlierLooks() });
  } catch (err) {
    return handleRouteError(err, 'admin/look/switch-back');
  }
}
