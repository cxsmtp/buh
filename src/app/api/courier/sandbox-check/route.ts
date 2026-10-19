import { enforceLimit, requireAdmin } from '@/lib/server/guard';
import { allowFields, handleRouteError, json, readJsonBody } from '@/lib/server/http';
import { lastSandboxCheck, runSandboxCheck } from '@/lib/server/jeeblySandbox';

/** Admin: the last Jeebly Sandbox check (when, who, each step and Jeebly's reply). */
export async function GET(req: Request) {
  try {
    await requireAdmin(req);
    return json({ check: lastSandboxCheck() });
  } catch (err) {
    return handleRouteError(err, 'courier/sandbox-check');
  }
}

/** Admin: run the Sandbox check now (a TEST shipment in Jeebly's sandbox, with the saved sandbox keys). */
export async function POST(req: Request) {
  try {
    const session = await requireAdmin(req);
    allowFields(await readJsonBody(req, 1024), []);
    enforceLimit('courier:sandbox-check', 20, 60 * 60 * 1000, 'Too many Sandbox checks this hour. Please wait a little.');
    await runSandboxCheck(session.email);
    return json({ check: lastSandboxCheck() });
  } catch (err) {
    return handleRouteError(err, 'courier/sandbox-check');
  }
}
