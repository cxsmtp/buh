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
}

export async function startServer(env: Record<string, string> = {}): Promise<RunningServer> {
  for (const dir of ['public', '.next/static']) {
    fs.cpSync(dir, path.join('.next/standalone', dir), { recursive: true });
  }
  // A port the system says is free. A random one could belong to a server another test file
  // (run in parallel) started, and the health check below would then talk to that one instead.
  const port = await freePort();
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
    if (await fetch(`${base}/api/health`).then((r) => r.ok, () => false)) {
      return { base, log: () => log, stop: () => child.kill(), dataDir };
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
