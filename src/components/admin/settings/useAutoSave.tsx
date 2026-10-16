'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Info, Loader2, RotateCcw, ShieldAlert } from 'lucide-react';
import { postJson, sendJson } from '@/lib/apiClient';

/**
 * Settings save themselves: about 1.5 s after the owner stops typing, the
 * section is sent to the server, which checks it (and, for email, tries it)
 * before it goes live. Nothing invalid is ever stored, so the shop always runs
 * on the last good settings.
 *
 * - Passwords and keys are never autosaved, and an autosave may not change an
 *   address in a way that would drop a saved key: that needs Save, with the key.
 * - One request at a time per section; a newer change waits for the one in flight.
 * - Leaving the section sends what's still waiting.
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

export function useAutoSave<T>({ settingsKey, value, onSaved, onUndone, onSent, delayMs = 1500, enabled = true }: Options<T>) {
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [undoId, setUndoId] = useState<number | null>(null);
  const json = JSON.stringify(value);
  const lastSent = useRef(json);
  const latest = useRef(json);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inFlight = useRef(false);
  const queued = useRef(false);
  const callbacks = useRef({ onSaved, onUndone, onSent });
  useEffect(() => {
    callbacks.current = { onSaved, onUndone, onSent };
    latest.current = json;
  });

  const flush = useCallback(async () => {
    if (inFlight.current) {
      queued.current = true; // the newest value goes when the one in flight is done
      return;
    }
    inFlight.current = true;
    try {
      do {
        queued.current = false;
        const body = latest.current;
        if (body === lastSent.current) break;
        lastSent.current = body;
        setStatus({ kind: 'saving' });
        const { ok, data } = await sendJson<{ message?: string; code?: string; undoId?: number | null; warning?: string }>('PUT', `/api/admin/settings/${settingsKey}`, { settings: JSON.parse(body), auto: true });
        if (ok) {
          // The first version kept in this session is what Undo goes back to.
          setUndoId((id) => id ?? data.undoId ?? null);
          setStatus({ kind: 'saved', note: data.warning });
          callbacks.current.onSent?.(JSON.parse(body) as T);
          await callbacks.current.onSaved?.();
        } else {
          setStatus(data.code === 'needs_save' ? { kind: 'needs-save', text: data.message || 'Press Save.' } : { kind: 'error', text: data.message || 'Not saved. Your previous settings are still in use.' });
        }
      } while (queued.current);
    } finally {
      inFlight.current = false;
    }
  }, [settingsKey]);

  useEffect(() => {
    if (!enabled || json === lastSent.current) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), delayMs);
    return () => clearTimeout(timer.current);
  }, [json, enabled, delayMs, flush]);

  // Leaving the section (or the page) sends what's still waiting.
  useEffect(
    () => () => {
      if (enabled && latest.current !== lastSent.current && !inFlight.current) {
        void sendJson('PUT', `/api/admin/settings/${settingsKey}`, { settings: JSON.parse(latest.current), auto: true });
      }
    },
    [enabled, settingsKey]
  );

  /** Call before the Save button's own save, so a waiting autosave doesn't race it. */
  const cancel = useCallback(() => {
    clearTimeout(timer.current);
    lastSent.current = latest.current;
    setStatus({ kind: 'idle' });
  }, []);

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
  return { status, cancel, undo, bar };
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
