'use client';

import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Check, Info, Loader2, RotateCcw, ShieldAlert, X } from 'lucide-react';
import { getJson, sendJson } from '@/lib/apiClient';
import { ownerConfirmNeeded, sendConfirmed } from '../OwnerConfirm';

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
 *   at the top of Settings, or of the hub tab the owner moved to (the section's own status line is
 *   gone by then).
 * - The bank account, payments, SMS and email settings need the owner again (their password, unless
 *   they signed in within the last 10 minutes). An autosave never opens the password dialog by
 *   itself (it would pop up mid-typing): the status line says the change is waiting and has a
 *   button that asks; Save asks straight away.
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
  /** When this group was last saved, as the hub loaded it with the values the form shows (null: never). */
  updatedAt?: string | null;
}

/**
 * The version (updatedAt) of its settings group that a form's values come from. Every save of the
 * form sends it and, when saved, moves it on; the server refuses a save whose version is not the
 * current one (the group was changed somewhere else). undefined: not known (read before sending).
 */
export interface FormVersion {
  current: string | null | undefined;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; note?: string }
  | { kind: 'needs-save'; text: string }
  | { kind: 'confirm' }
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
  /** When this group was last saved, as loaded with the form's values (undefined: read from the server before the first save). */
  updatedAt?: string | null;
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
  theme: 'Festival themes',
  email: 'Email',
  assistant: 'Chat assistant',
  delivery: 'Delivery',
  payments: 'Payments',
  phoneCheck: 'Phone check',
  ai: 'AI writing',
};

/** What a section holds, for "Type your hub password to change …". */
const SECTION_WHAT: Record<string, string> = {
  bank: 'the bank details',
  payments: 'the payment settings',
  sms: 'the SMS gateway',
  email: 'the email settings',
};

/** In place of the last value sent while a change waits for the owner's password (never equal to a form's value). */
const NOT_SENT = '\u0000not-sent';

let notices: SettingsNotice[] = [];
let noticeSeq = 0;
const noticeListeners = new Set<() => void>();
const NO_NOTICES: SettingsNotice[] = [];

export function pushSettingsNotice(settingsKey: string, text: string) {
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

/**
 * Shown at the top of Settings, whichever section is open; and (`hub`) at the top of every other
 * hub tab, so a change refused just as the owner left Settings is said where they are now.
 */
export function SettingsNotices({ hub = false }: { hub?: boolean }) {
  const list = useSettingsNotices();
  if (!list.length) return null;
  return (
    <div className={hub ? 'space-y-2' : 'space-y-2 mb-3'} data-testid={hub ? 'hub-settings-notices' : 'settings-notices'}>
      {list.map((n) => (
        <div key={n.id} role="alert" className="flex items-start gap-2 rounded-xl border border-warning-line bg-warning-soft px-3 py-2 text-xs text-ink">
          <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5 text-warning" aria-hidden="true" />
          <span className="flex-1 min-w-0 break-words">
            <strong>
              {hub ? 'Settings → ' : ''}
              {SECTION_NAMES[n.settingsKey] ?? 'Settings'}:
            </strong>{' '}
            {n.text}
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

export const CHANGED_ELSEWHERE = 'These settings were changed somewhere else (another phone or computer, or another part of the hub) while this page was open. The current settings are shown now. Your last change here was not saved: make it again if you still want it.';

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

const NEEDS_OWNER = 'Your hub password is needed to change these settings. Nothing was changed: open the section and make the change again.';

export function useAutoSave<T>({ settingsKey, value, onSaved, onUndone, onSent, updatedAt, delayMs = 1500, enabled = true }: Options<T>) {
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
   * The version (updatedAt) of this group that the form's values come from: given by the hub with
   * the values (else read right before the first save), then taken from each of the form's own
   * saves. Sent with every save; the server refuses (409) when the group was saved since, so a form
   * left open never puts back older settings.
   */
  const version = useRef<string | null | undefined>(updatedAt);
  /** The owner pressed "Type your password": the next autosave may open the password dialog. */
  const askOwner = useRef(false);
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
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Changed elsewhere: the owner is told, the hub reloads, and this form is re-created with the current values. */
  const reloadForm = useCallback(async () => {
    pushSettingsNotice(settingsKey, CHANGED_ELSEWHERE);
    await callbacks.current.onSaved?.();
    callbacks.current.onUndone?.(settingsKey);
  }, [settingsKey]);

  /** One PUT of this group, with the version the form was loaded from. */
  const put = useCallback(
    async (settings: unknown, auto: boolean, ask: boolean) => {
      // Not known (the hub gave none, or this form's group was just saved another way): read now, right before sending.
      if (version.current === undefined) version.current = await loadVersion(settingsKey);
      const loadedAt = version.current;
      const body = { settings, ...(auto ? { auto: true } : {}), ...(loadedAt === undefined ? {} : { updatedAt: loadedAt }) };
      const url = `/api/admin/settings/${settingsKey}`;
      // The owner's password (bank, payments, SMS, email) is asked only when the owner pressed something.
      const res = ask ? await sendConfirmed<SaveAnswer>('PUT', url, body, SECTION_WHAT[settingsKey]) : await sendJson<SaveAnswer>('PUT', url, body);
      if (res.ok && res.data.updatedAt !== undefined) version.current = res.data.updatedAt;
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
        const ask = askOwner.current;
        askOwner.current = false;
        const res = await put(JSON.parse(body), true, ask);
        const { ok, status: http, data } = res;
        if (ok) {
          // The first version kept in this session is what Undo goes back to.
          setUndoId((id) => id ?? data.undoId ?? null);
          setStatus({ kind: 'saved', note: data.warning });
          callbacks.current.onSent?.(JSON.parse(body) as T);
          await callbacks.current.onSaved?.();
        } else if (http === 409 && data.code === 'changed_elsewhere') {
          await reloadForm();
          break;
        } else if (ownerConfirmNeeded(res) || data.code === 'owner_confirm_cancelled') {
          // Not sent again by itself; the next change, or the button on the status line, tries again.
          lastSent.current = NOT_SENT;
          setStatus({ kind: 'confirm' });
          if (!mounted.current) pushSettingsNotice(settingsKey, NEEDS_OWNER);
          break;
        } else {
          const text = data.message || 'Not saved. Your previous settings are still in use.';
          setStatus(data.code === 'needs_save' ? { kind: 'needs-save', text: data.message || 'Press Save.' } : { kind: 'error', text });
          // The section was left meanwhile: its own status line is gone, so say it at the top of Settings.
          if (!mounted.current) pushSettingsNotice(settingsKey, `Your last change was not saved. ${text}`);
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
      // Waiting for the owner's password, which nobody is there to type now: said, not sent again.
      if (!inFlight.current && lastSent.current === NOT_SENT) {
        pushSettingsNotice(settingsKey, NEEDS_OWNER);
        return;
      }
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
  }, []);

  /**
   * Before a Save that goes through the hub (not this hook): the waiting autosave is dropped, one
   * already on its way is let through, and the form's version comes back for the hub to send and
   * move on, so the hub's save and the next autosave are not taken for someone else's change.
   */
  const hold = useCallback(async (): Promise<FormVersion> => {
    clearTimeout(timer.current);
    if (inFlight.current && running.current) await running.current.catch(() => undefined);
    lastSent.current = latest.current;
    setStatus({ kind: 'idle' });
    // Not known (this form's group was just saved another way): read now, right before the hub sends.
    if (version.current === undefined) version.current = await loadVersion(settingsKey);
    return version;
  }, [settingsKey]);

  /**
   * This group was just saved from this same form by another route (e.g. a weave renamed on the
   * server): read its version again before the next save.
   */
  const savedElsewhereHere = useCallback(() => {
    version.current = undefined;
  }, []);
  /**
   * The Save button's save, with the same version check as autosave: resolves to a problem to show,
   * or null when saved. (Cards without it call the hub's own save after cancel().)
   */
  const save = useCallback(
    async (settings: unknown, onWarning?: (warning: string) => void): Promise<string | null> => {
      clearTimeout(timer.current);
      // An autosave already on its way goes first (its answer carries the version this save sends).
      if (inFlight.current && running.current) await running.current.catch(() => undefined);
      lastSent.current = latest.current;
      setStatus({ kind: 'idle' });
      const { ok, status: http, data } = await put(settings, false, true);
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
    const { ok, data } = await sendConfirmed<{ message?: string }>('POST', '/api/admin/settings/history', { id: undoId }, SECTION_WHAT[settingsKey]);
    if (!ok) {
      setStatus({ kind: 'error', text: data.message || 'Could not undo.' });
      return;
    }
    setUndoId(null);
    setStatus({ kind: 'idle' });
    // The form is re-created with the restored values (and their version).
    version.current = undefined;
    await callbacks.current.onSaved?.();
    callbacks.current.onUndone?.(settingsKey);
  }, [undoId, settingsKey]);

  /** "Type your password": the change that is waiting is sent again, and this time the hub may ask. */
  const confirmNow = useCallback(() => {
    askOwner.current = true;
    void flush();
  }, [flush]);

  const bar = <AutoSaveBar status={status} canUndo={Boolean(undoId)} onUndo={() => void undo()} onConfirm={confirmNow} />;
  return { status, cancel, hold, undo, bar, save, savedElsewhereHere };
}

function AutoSaveBar({ status, canUndo, onUndo, onConfirm }: { status: Status; canUndo: boolean; onUndo: () => void; onConfirm: () => void }) {
  if (status.kind === 'confirm')
    return (
      <p className="text-xs text-warning font-semibold flex flex-wrap items-center gap-2" role="status" data-testid="autosave-confirm">
        <ShieldAlert className="w-4 h-4 shrink-0" aria-hidden="true" /> Not saved yet: your hub password is needed to change these settings.
        <button type="button" onClick={onConfirm} className="min-h-11 px-3 rounded-xl border border-line-strong bg-surface text-ink text-xs font-bold">
          Type your password
        </button>
      </p>
    );
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
