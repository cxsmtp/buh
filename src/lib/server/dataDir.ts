import fs from 'node:fs';
import path from 'node:path';

/**
 * Where server-side state lives (admin credentials, session key, audit log).
 * Mount it as a volume in production; it is created with owner-only access.
 */
let prepared = '';

export function dataDir(): string {
  // turbopackIgnore: runtime-only path; without it the build traces (and would
  // ship) the whole project, secrets in .data and .env files included.
  const dir = path.resolve(/*turbopackIgnore: true*/ process.env.DATA_DIR || path.join(process.cwd(), '.data'));
  if (prepared === dir) return dir;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode only applies to a new folder: tighten an existing one too.
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // not ours to change (e.g. a mounted volume owned by root): leave it
  }
  prepared = dir;
  return dir;
}

export function dataFile(name: string): string {
  return path.join(/*turbopackIgnore: true*/ dataDir(), name);
}

/** Write atomically (temp file + rename) with owner-only permissions. */
export function writePrivateFile(file: string, contents: string) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, contents, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
