import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The production build (`npm run build`), started on a free port with its own empty DATA_DIR. */
export const SERVER = path.resolve('.next/standalone/server.js');
export const hasBuild = fs.existsSync(SERVER);

export interface RunningServer {
  base: string;
  log: () => string;
  stop: () => void;
}

export async function startServer(env: Record<string, string> = {}): Promise<RunningServer> {
  for (const dir of ['public', '.next/static']) {
    fs.cpSync(dir, path.join('.next/standalone', dir), { recursive: true });
  }
  const port = 3500 + Math.floor(Math.random() * 400);
  const base = `http://127.0.0.1:${port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buh-e2e-'));
  let log = '';
  const child: ChildProcess = spawn(process.execPath, [SERVER], {
    cwd: path.dirname(SERVER),
    env: { ...process.env, PORT: String(port), HOSTNAME: '127.0.0.1', DATA_DIR: dataDir, INSECURE_COOKIES: '1', OTP_DEV_MODE: 'true', TRUST_PROXY: '', BACKUP_DISABLED: 'true', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', (d) => (log += d));
  child.stderr!.on('data', (d) => (log += d));
  for (let i = 0; i < 150; i++) {
    if (await fetch(`${base}/api/health`).then((r) => r.ok, () => false)) {
      return { base, log: () => log, stop: () => child.kill() };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error(`server did not start:\n${log}`);
}
