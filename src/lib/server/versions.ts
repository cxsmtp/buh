import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from './http';

/**
 * Versions for Settings → Versions: the changelog bundled with this build, what
 * the updater reports, and asking it to switch version.
 *
 * The updater (deploy/updater/updater.sh, opt-in) writes its status to a folder
 * mounted read-only here (UPDATER_STATUS_DIR) and takes one-line requests from
 * another (UPDATER_CONTROL_DIR). Without the updater, the page shows the
 * commands to run on the server instead.
 */

export interface ChangelogEntry {
  /** 2.0.0 */
  version: string;
  /** BUH-02.00.00 */
  label: string;
  date: string;
  pr: number | null;
  /** Markdown lines (bullets, with their nested bullets indented). */
  lines: string[];
}

export interface UpdaterStatus {
  updatedAt: string;
  running: string;
  lastGood: string;
  previous: string;
  onServer: string[];
  autoUpdateMinutes: number;
  lastRequest: { request: string; result: string; message: string; at: string };
}

const VERSION_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
/** Versions before this keep stock per product; they cannot run on today's database. */
export const OLDEST_ROLLBACK = '2.0.0';
/** The updater checks its folders every 30 s; a status older than this means it is not running. */
const STALE_MS = 3 * 60 * 1000;

const statusDir = () => process.env.UPDATER_STATUS_DIR || '/updater-status';
const controlDir = () => process.env.UPDATER_CONTROL_DIR || '/updater-control';

export const labelOf = (version: string) => `BUH-${version.split('.').map((n) => n.padStart(2, '0')).join('.')}`;
export const versionOf = (label: string) => label.replace(/^BUH-/, '').split('.').map((n) => String(Number(n))).join('.');

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

let cached: ChangelogEntry[] | null = null;

/** The changelog shipped with this build (CHANGELOG.md), newest first. */
export function changelog(file = process.env.CHANGELOG_PATH || path.join(process.cwd(), 'CHANGELOG.md')): ChangelogEntry[] {
  if (cached && !process.env.CHANGELOG_PATH) return cached;
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const entries: ChangelogEntry[] = [];
  let current: ChangelogEntry | null = null;
  for (const line of text.split('\n')) {
    const head = line.match(/^## (BUH-\d{2}\.\d{2}\.\d{2})\s*[—-]\s*(.*?)(?:\s*·\s*\[#(\d+)\].*)?$/);
    if (head) {
      current = { version: versionOf(head[1]), label: head[1], date: head[2].trim(), pr: head[3] ? Number(head[3]) : null, lines: [] };
      entries.push(current);
    } else if (current && line.trim()) {
      current.lines.push(line.replace(/\s+$/, ''));
    }
  }
  cached = entries;
  return entries;
}

/** What the updater last wrote, or null when it is not running (or its status is unreadable). */
export function updaterStatus(now = Date.now()): UpdaterStatus | null {
  const file = path.join(statusDir(), 'status.json');
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > 64 * 1024) return null;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<UpdaterStatus>;
    const at = Date.parse(String(raw.updatedAt));
    if (!Number.isFinite(at) || now - at > STALE_MS) return null;
    const v = (x: unknown) => (typeof x === 'string' && VERSION_RE.test(x) ? x : '');
    const s = (x: unknown, max = 300) => (typeof x === 'string' ? x.slice(0, max) : '');
    const lr = (raw.lastRequest ?? {}) as Partial<UpdaterStatus['lastRequest']>;
    return {
      updatedAt: new Date(at).toISOString(),
      running: v(raw.running),
      lastGood: v(raw.lastGood),
      previous: v(raw.previous),
      onServer: Array.isArray(raw.onServer) ? raw.onServer.map(v).filter(Boolean).slice(0, 100) : [],
      autoUpdateMinutes: Number.isInteger(raw.autoUpdateMinutes) ? Number(raw.autoUpdateMinutes) : 0,
      lastRequest: { request: s(lr.request, 64), result: s(lr.result, 20), message: s(lr.message), at: s(lr.at, 40) },
    };
  } catch {
    return null;
  }
}

/** A request is waiting for the updater to pick it up. */
export function pendingRequest(): string | null {
  try {
    const file = path.join(controlDir(), 'request');
    const st = fs.lstatSync(file);
    if (!st.isFile()) return null;
    return fs.readFileSync(file, 'utf8').slice(0, 64).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Ask the updater to switch to a version ("2.0.1") or to the latest ("latest").
 * The file is created new (never through an existing file or link); one request at a time.
 */
export function requestSwitch(target: string, now = Date.now()): string {
  const status = updaterStatus(now);
  if (!status) throw new HttpError(409, 'Automatic updates are not running on this server, so versions are switched with a command (shown on this page).');
  let line: string;
  if (target === 'latest') {
    line = 'update';
  } else {
    if (!VERSION_RE.test(target)) throw new HttpError(400, 'Choose a version from the list.');
    if (compareVersions(target, OLDEST_ROLLBACK) < 0) {
      throw new HttpError(400, `Versions before ${labelOf(OLDEST_ROLLBACK)} cannot run on today's database (stock is now kept per size).`);
    }
    if (!changelog().some((e) => e.version === target) && !status.onServer.includes(target)) throw new HttpError(400, 'That version is not in the list.');
    if (status.running === target) throw new HttpError(409, `The shop already runs ${labelOf(target)}.`);
    line = `rollback ${target}`;
  }
  if (pendingRequest()) throw new HttpError(409, 'A version switch is already waiting. It starts within a minute.');
  try {
    fs.writeFileSync(path.join(controlDir(), 'request'), `${line}\n`, { flag: 'wx', mode: 0o644 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new HttpError(409, 'A version switch is already waiting. It starts within a minute.');
    throw new HttpError(503, 'The request could not be handed to the updater. Check that it runs (docker compose ps updater).');
  }
  return line;
}

export function _resetVersionsCache() {
  cached = null;
}
