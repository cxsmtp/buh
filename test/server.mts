import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/** The production build (`npm run build`), started on a free port with its own empty DATA_DIR. */
export const SERVER = path.resolve('.next/standalone/server.js');
export const hasBuild = fs.existsSync(SERVER);

export interface RunningServer {
  base: string;
  log: () => string;
  stop: () => void;
  /** Its DATA_DIR (database, audit log). */
  dataDir: string;
  /** The Admin Hub's private link (path, and full address), from the first start's log. */
  adminPath: string;
  adminUrl: string;
  /** The door cookie ("buh_door=…") that link gave: added to this test file's own admin API calls. */
  door: string;
}

/** fetch without the door cookie added (to check what a stranger gets). */
export const rawFetch: typeof fetch = globalThis.fetch.bind(globalThis);
const doors = new Map<string, string>();

/**
 * Tests talk to the admin APIs as the owner's browser does: through the door. Calls to a
 * started server's /api/ addresses get its door cookie added (next to any cookie the test
 * sets). Use rawFetch to call without it.
 */
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const base = [...doors.keys()].find((b) => url.startsWith(`${b}/api/`));
  if (!base || input instanceof Request) return rawFetch(input, init);
  const headers = new Headers(init?.headers);
  const cookie = headers.get('cookie');
  if (!cookie || !cookie.includes('buh_door=')) headers.set('cookie', cookie ? `${cookie}; ${doors.get(base)}` : doors.get(base)!);
  return rawFetch(input, { ...init, headers });
}) as typeof fetch;

/** Open the admin link, as the owner's bookmark does: returns the door cookie it sets. */
export async function openDoor(base: string, adminPath: string): Promise<string> {
  const res = await rawFetch(`${base}${adminPath}`, { redirect: 'manual' });
  await res.arrayBuffer();
  const door = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).find((c) => c.startsWith('buh_door='));
  if (!door) throw new Error(`the admin link ${adminPath.slice(0, 5)}… gave no door (status ${res.status})`);
  doors.set(base, door);
  return door;
}

/** The private admin link printed in a server log. */
export function adminPathIn(log: string): string | null {
  return log.match(/Admin link: (?:https?:\/\/[^/\s]+)?(\/[A-Za-z0-9_-]{32})(?![A-Za-z0-9_-])/)?.[1] ?? null;
}

export async function startServer(env: Record<string, string> = {}, opts: { port?: number; adminPath?: string } = {}): Promise<RunningServer> {
  for (const dir of ['public', '.next/static']) {
    fs.cpSync(dir, path.join('.next/standalone', dir), { recursive: true });
  }
  // A port the system says is free. A random one could belong to a server another test file
  // (run in parallel) started, and the health check below would then talk to that one instead.
  const port = opts.port ?? (await freePort());
  const base = `http://127.0.0.1:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buh-e2e-'));
  let log = '';
  const child: ChildProcess = spawn(process.execPath, [SERVER], {
    cwd: path.dirname(SERVER),
    env: { ...process.env, PORT: String(port), HOSTNAME: '127.0.0.1', DATA_DIR: dataDir, INSECURE_COOKIES: '1', OTP_DEV_MODE: 'true', TRUST_PROXY: '', BACKUP_DISABLED: 'true', SEED_STOCK: '50', FX_DISABLED: 'true', FESTIVAL_REFRESH_DISABLED: 'true', MONITOR_DISABLED: 'true', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', (d) => (log += d));
  child.stderr!.on('data', (d) => (log += d));
  let exited = false;
  child.on('exit', () => (exited = true));
  for (let i = 0; i < 150 && !exited; i++) {
    if (await rawFetch(`${base}/api/health`).then((r) => r.ok, () => false)) {
      // The first start prints the admin link; a restart on the same data keeps the earlier one.
      let adminPath = opts.adminPath ?? null;
      for (let j = 0; j < 50 && !adminPath; j++) {
        adminPath = adminPathIn(log);
        if (!adminPath) await new Promise((r) => setTimeout(r, 100));
      }
      if (!adminPath) {
        child.kill();
        throw new Error(`no admin link in the log:\n${log}`);
      }
      const door = await openDoor(base, adminPath);
      return { base, log: () => log, stop: () => child.kill(), dataDir, adminPath, adminUrl: `${base}${adminPath}`, door };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error(`server did not start:\n${log}`);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}
