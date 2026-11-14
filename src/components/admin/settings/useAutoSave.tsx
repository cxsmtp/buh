'use client';

import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Check, Info, Loader2, RotateCcw, ShieldAlert, X } from 'lucide-react';
import { getJson, postJson, sendJson } from '@/lib/apiClient';

/**
 * Settings save themselves: about 1.5 s after the owner stops typing, the
 * section is sent to the server, which checks it (and, for email, tries it)
 * before it goes live. Nothing invalid is ever stored, so the shop always runs
 * on the last good settings.
 *
 * - Passwords and keys are never autosaved, and an autosave may not change an
 *   address in a way that would drop a saved key: that needs Save, with the key.
 * - One request at a time per section; a newer change waits for the one in flight.
 * - Leaving the section sends what's still waiting; if the server refuses it, the reason is shown
 *   at the top of Settings (the section's own status line is gone by then).
 * - Every save carries the version of the settings the form was loaded from. If they were changed
 *   somewhere else meanwhile (the phone, while the laptop had the section open), the server refuses
 *   the save, the form is re-created with the current settings and the owner is told: a form left
 *   open never puts back someone else's change.
 * - Undo puts back the settings from before this round of edits (the first
 *   version kept in this session, not the last autosave).
 */

/** Autosave wiring from the Admin Hub (reload after a save; show restored values after Undo). */
export interface AutoSaveHooks {
  onSaved: () => void | Promise<void>;
  /** The section's settings group was restored by Undo: re-create that form. */
  onUndone: (settingsKey: string) => void;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; note?: string }
  | { kind: 'needs-save'; text: string }
  | { kind: 'error'; text: string };

interface Options<T> {
  /** Settings group, e.g. "store". */
  settingsKey: string;
  /** The value to autosave, without passwords/keys (blank = keep the saved one). */
  value: T;
  onSaved?: () => void | Promise<void>;
  onUndone?: (settingsKey: string) => void;
  /** After a successful send, with what was sent (e.g. to stop re-sending a logo). */
  onSent?: (sent: T) => void;
  delayMs?: number;
  enabled?: boolean;
}

// ── Messages that outlive a form ─────────────────────────────────────────────
// A save refused after its section was left, or a form reloaded because the settings changed
// somewhere else: the form that would have shown it is gone (or re-created), so the message is
// kept here and shown at the top of Settings (SettingsNotices) until the owner dismisses it.

export interface SettingsNotice {
  id: number;
  settingsKey: string;
  text: string;
}

const SECTION_NAMES: Record<string, string> = {
  store: 'Store & contact',
  catalog: 'Catalogue',
  brand: 'Branding',
  bank: 'Bank details',
  courier: 'Couriers',
  sms: 'SMS',
  email: 'Email',
  assistant: 'Chat assistant',
  delivery: 'Delivery',
  payments: 'Payments',
  phoneCheck: 'Phone check',
  ai: 'AI writing',
};

let notices: SettingsNotice[] = [];
let noticeSeq = 0;
const noticeListeners = new Set<() => void>();
const NO_NOTICES: SettingsNotice[] = [];

function pushNotice(settingsKey: string, text: string) {
  // One message per section: the newest replaces the one before.
  notices = [...notices.filter((n) => n.settingsKey !== settingsKey), { id: ++noticeSeq, settingsKey, text }];
  noticeListeners.forEach((fn) => fn());
}

export function dismissSettingsNotice(id: number) {
  notices = notices.filter((n) => n.id !== id);
  noticeListeners.forEach((fn) => fn());
}

/** The messages waiting to be read (see above), for SettingsNotices. */
export function useSettingsNotices(): SettingsNotice[] {
  return useSyncExternalStore(
    (fn) => {
      noticeListeners.add(fn);
      return () => noticeListeners.delete(fn);
    },
    () => notices,
    () => NO_NOTICES
  );
}

/** Shown at the top of Settings, whichever section is open. */
export function SettingsNotices() {
  const list = useSettingsNotices();
  if (!list.length) return null;
  return (
    <div className="space-y-2 mb-3" data-testid="settings-notices">
      {list.map((n) => (
        <div key={n.id} role="alert" className="flex items-start gap-2 rounded-xl border border-warning-line bg-warning-soft px-3 py-2 text-xs text-ink">
          <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5 text-warning" aria-hidden="true" />
          <span className="flex-1 min-w-0 break-words">
            <strong>{SECTION_NAMES[n.settingsKey] ?? 'Settings'}:</strong> {n.text}
          </span>
          <button type="button" onClick={() => dismissSettingsNotice(n.id)} className="min-h-11 min-w-11 -my-1.5 -mr-2 flex items-center justify-center rounded-xl text-ink-soft" aria-label="Dismiss this message">
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * Saves still on their way from a form that was closed (its section was left), by settings group.
 * A form of the same group opened meanwhile was filled in from before that save: it sends nothing,
 * and is re-created with what is saved once the save is through.
 */
const detachedSaves = new Map<string, number>();

const CHANGED_ELSEWHERE = 'These settings were changed somewhere else (another phone or computer, or another part of the hub) while this page was open. The current settings are shown now. Your last change here was not saved: make it again if you still want it.';

interface SaveAnswer {
  message?: string;
  code?: string;
  undoId?: number | null;
  warning?: string;
  updatedAt?: string | null;
}

/** When this settings group was last saved, as the server has it now (undefined: could not be read). */
async function loadVersion(settingsKey: string): Promise<string | null | undefined> {
  const { ok, data } = await getJson<{ versions?: Record<string, string | null> }>('/api/admin/settings?versions=1');
  return ok && data.versions && settingsKey in data.versions ? data.versions[settingsKey] : undefined;
}

export function useAutoSave<T>({ settingsKey, value, onSaved, onUndone, onSent, delayMs = 1500, enabled = true }: Options<T>) {
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [undoId, setUndoId] = useState<number | null>(null);
  const json = JSON.stringify(value);
  const lastSent = useRef(json);
  const latest = useRef(json);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inFlight = useRef(false);
  const queued = useRef(false);
  const mounted = useRef(true);
  /** The form is gone for good (not only switched off for a moment). */
  const gone = useRef(false);
  /** Opened while a closed form's save of the same group was on its way: see detachedSaves. */
  const superseded = useRef(false);
  const running = useRef<Promise<void> | null>(null);
  /**
   * The version (updatedAt) of this group that the form's values come from: read when the form
   * opens, then taken from each of its own saves. Sent with every save; the server refuses (409)
   * when the group was saved since, so a form left open never puts back older settings.
   */
  const version = useRef<Promise<string | null | undefined> | null>(null);
  const callbacks = useRef({ onSaved, onUndone, onSent });
  useEffect(() => {
    callbacks.current = { onSaved, onUndone, onSent };
    latest.current = json;
  });
  useEffect(() => {
    gone.current = false;
    superseded.current = (detachedSaves.get(settingsKey) ?? 0) > 0;
    return () => {
      gone.current = true;
    };
    // Once, when the form opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    mounted.current = true;
    if (enabled && !version.current) version.current = loadVersion(settingsKey);
    return () => {
      mounted.current = false;
    };
  }, [enabled, settingsKey]);

  /** Changed elsewhere: the owner is told, the hub reloads, and this form is re-created with the current values. */
  const reloadForm = useCallback(async () => {
    pushNotice(settingsKey, CHANGED_ELSEWHERE);
    await callbacks.current.onSaved?.();
    callbacks.current.onUndone?.(settingsKey);
  }, [settingsKey]);

  /** One PUT of this group, with the version the form was loaded from. */
  const put = useCallback(
    async (settings: unknown, auto: boolean) => {
      // Not known (this form's group was just saved another way): read now, right before sending.
      if (!version.current) version.current = loadVersion(settingsKey);
      const loadedAt = await version.current;
      const res = await sendJson<SaveAnswer>('PUT', `/api/admin/settings/${settingsKey}`, { settings, ...(auto ? { auto: true } : {}), ...(loadedAt === undefined ? {} : { updatedAt: loadedAt }) });
      if (res.ok && res.data.updatedAt !== undefined) version.current = Promise.resolve(res.data.updatedAt);
      return res;
    },
    [settingsKey]
  );

  const flush = useCallback((): Promise<void> => {
    if (superseded.current) return Promise.resolve();
    if (inFlight.current && running.current) {
      queued.current = true; // the newest value goes when the one in flight is done
      return running.current;
    }
    inFlight.current = true;
    running.current = (async () => {
    try {
      do {
        queued.current = false;
        const body = latest.current;
        if (body === lastSent.current) break;
        lastSent.current = body;
        setStatus({ kind: 'saving' });
        const { ok, status: http, data } = await put(JSON.parse(body), true);
        if (ok) {
          // The first version kept in this session is what Undo goes back to.
          setUndoId((id) => id ?? data.undoId ?? null);
          setStatus({ kind: 'saved', note: data.warning });
          callbacks.current.onSent?.(JSON.parse(body) as T);
          await callbacks.current.onSaved?.();
        } else if (http === 409 && data.code === 'changed_elsewhere') {
          await reloadForm();
          break;
        } else {
          const text = data.message || 'Not saved. Your previous settings are still in use.';
          setStatus(data.code === 'needs_save' ? { kind: 'needs-save', text: data.message || 'Press Save.' } : { kind: 'error', text });
          // The section was left meanwhile: its own status line is gone, so say it at the top of Settings.
          if (!mounted.current) pushNotice(settingsKey, `Your last change was not saved. ${text}`);
        }
      } while (queued.current);
    } finally {
      inFlight.current = false;
    }
    })();
    return running.current;
  }, [settingsKey, put, reloadForm]);

  useEffect(() => {
    if (!enabled || json === lastSent.current) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), delayMs);
    return () => clearTimeout(timer.current);
  }, [json, enabled, delayMs, flush]);

  // Leaving the section (or the page) sends what's still waiting, after any save already on its
  // way; if the server refuses it, the message is shown at the top of Settings.
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      if (!enabled || superseded.current) return;
      if (!inFlight.current && latest.current === lastSent.current) return;
      // Closed for good with a save waiting or on its way: if the same section is opened again
      // before it is through, that form (filled in from before the save) is re-created after it.
      const detached = gone.current;
      if (detached) detachedSaves.set(settingsKey, (detachedSaves.get(settingsKey) ?? 0) + 1);
      void flush().finally(() => {
        if (!detached) return;
        detachedSaves.set(settingsKey, Math.max(0, (detachedSaves.get(settingsKey) ?? 1) - 1));
        callbacks.current.onUndone?.(settingsKey);
      });
    },
    [enabled, flush, settingsKey]
  );

  /** Call before the Save button's own save, so a waiting autosave doesn't race it. */
  const cancel = useCallback(() => {
    clearTimeout(timer.current);
    lastSent.current = latest.current;
    setStatus({ kind: 'idle' });
    // That save goes another way (the card's own Save, without this hook): the group's version
    // is read again before the next autosave, so the card's own save is not taken for someone else's.
    version.current = null;
  }, []);

  /**
   * This group was just saved from this same form by another route (e.g. a weave renamed on the
   * server): read its version again before the next save.
   */
  const savedElsewhereHere = useCallback(() => {
    version.current = null;
  }, []);
  /**
   * The Save button's save, with the same version check as autosave: resolves to a problem to show,
   * or null when saved. (Cards without it call the hub's own save after cancel().)
   */
  const save = useCallback(
    async (settings: unknown, onWarning?: (warning: string) => void): Promise<string | null> => {
      clearTimeout(timer.current);
      lastSent.current = latest.current;
      setStatus({ kind: 'idle' });
      const { ok, status: http, data } = await put(settings, false);
      if (!ok) {
        if (http === 409 && data.code === 'changed_elsewhere') {
          await reloadForm();
          return CHANGED_ELSEWHERE;
        }
        return data.message || 'Could not save. Please try again.';
      }
      if (data.warning) onWarning?.(data.warning);
      await callbacks.current.onSaved?.();
      return null;
    },
    [put, reloadForm]
  );

  const undo = useCallback(async () => {
    if (!undoId) return;
    setStatus({ kind: 'saving' });
    const { ok, data } = await postJson<{ message?: string }>('/api/admin/settings/history', { id: undoId });
    if (!ok) {
      setStatus({ kind: 'error', text: data.message || 'Could not undo.' });
      return;
    }
    setUndoId(null);
    setStatus({ kind: 'idle' });
    await callbacks.current.onSaved?.();
    callbacks.current.onUndone?.(settingsKey);
  }, [undoId, settingsKey]);

  const bar = <AutoSaveBar status={status} canUndo={Boolean(undoId)} onUndo={() => void undo()} />;
  return { status, cancel, undo, bar, save, savedElsewhereHere };
}

function AutoSaveBar({ status, canUndo, onUndo }: { status: Status; canUndo: boolean; onUndo: () => void }) {
  if (status.kind === 'idle') return <p className="text-[11px] text-ink-muted">Changes save automatically.</p>;
  if (status.kind === 'saving')
    return (
      <p className="text-[11px] text-ink-soft flex items-center gap-1" role="status">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Saving…
      </p>
    );
  if (status.kind === 'error')
    return (
      <p className="text-xs text-danger font-semibold flex items-start gap-1" role="alert">
        <ShieldAlert className="w-4 h-4 shrink-0" /> {status.text}
      </p>
    );
  if (status.kind === 'needs-save')
    return (
      <p className="text-xs text-warning font-semibold flex items-start gap-1" role="status">
        <Info className="w-4 h-4 shrink-0" /> {status.text}
      </p>
    );
  return (
    <p className="text-xs text-success font-semibold flex flex-wrap items-center gap-2" role="status">
      <Check className="w-4 h-4" /> Saved automatically.
      {status.note && <span className="text-warning font-normal">{status.note}</span>}
      {canUndo && (
        <button type="button" onClick={onUndo} className="inline-flex items-center gap-1 underline text-ink-soft">
          <RotateCcw className="w-3.5 h-3.5" /> Undo
        </button>
      )}
    </p>
  );
}
