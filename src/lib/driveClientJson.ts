/**
 * Google's OAuth client file ("client_secret_….json", downloaded when the client is made in Google
 * Cloud → Clients), read in the browser to fill the client ID and secret in Settings → Google Drive.
 * The server checks both again (src/lib/server/driveBackup.ts); this only spares the owner copying.
 *
 * A "TVs and Limited Input devices" client downloads as { "installed": { client_id, client_secret,
 * project_id, … } }. A Web application client ({ "web": … }) and a service account key
 * ({ "type": "service_account" }) are refused with what to do instead.
 */

export const CLIENT_ID_PATTERN = /^[0-9]{6,30}-[a-z0-9]{10,64}\.apps\.googleusercontent\.com$/;
export const CLIENT_SECRET_PATTERN = /^[A-Za-z0-9_-]{10,100}$/;

export type ClientJsonResult = { ok: true; clientId: string; clientSecret: string; projectId: string } | { ok: false; error: string };

/** Whether a client ID looks like Google's (…apps.googleusercontent.com). */
export function clientIdLooksRight(id: string): boolean {
  return CLIENT_ID_PATTERN.test(id.trim());
}

export function parseClientJson(text: string): ClientJsonResult {
  if (text.length > 20_000) return { ok: false, error: 'That file is too big to be a Google client file.' };
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { ok: false, error: 'That is not Google’s client file: it should be the client_secret_….json file Google downloaded (it starts with { and ends with }).' };
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: 'That is not Google’s client file.' };
  const o = v as Record<string, unknown>;
  if (o.type === 'service_account') {
    return { ok: false, error: 'This is a service account key, not an OAuth client. For “Connect my Google Drive”, download the client file from Google Cloud → Clients (type “TVs and Limited Input devices”). Service accounts go under Advanced (Google Workspace).' };
  }
  if (o.web && typeof o.web === 'object') {
    return { ok: false, error: 'This is a “Web application” client: the shop needs one of type “TVs and Limited Input devices”. Make a new client of that type and download its file.' };
  }
  const inner = (o.installed && typeof o.installed === 'object' ? o.installed : o) as Record<string, unknown>;
  const clientId = typeof inner.client_id === 'string' ? inner.client_id.trim() : '';
  const clientSecret = typeof inner.client_secret === 'string' ? inner.client_secret.trim() : '';
  const projectId = typeof inner.project_id === 'string' && /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(inner.project_id) ? inner.project_id : '';
  if (!clientId || !CLIENT_ID_PATTERN.test(clientId)) return { ok: false, error: 'This file has no client ID ending in .apps.googleusercontent.com: download the client file again from Google Cloud → Clients.' };
  if (!clientSecret || !CLIENT_SECRET_PATTERN.test(clientSecret)) return { ok: false, error: 'This file has no client secret: in Google Cloud → Clients, open the client and download its file again (or copy the secret by hand).' };
  return { ok: true, clientId, clientSecret, projectId };
}
