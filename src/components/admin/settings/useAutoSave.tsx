'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Loader2, RotateCcw, ShieldAlert } from 'lucide-react';
import { postJson, sendJson } from '@/lib/apiClient';

/**
 * Settings save themselves: about 1.5 s after the owner stops typing, the
 * section is sent to the server, which checks it (and, for email, tries it)
 * before it goes live. Nothing invalid is ever stored, so the shop always runs
 * on the last good settings. Passwords and keys are not autosaved (half-typed
 * ones would replace working ones); the Save button sends them.
 *
 * After a save, Undo puts back the settings from before this round of edits.
 */

/** Autosave wiring from the Admin Hub (reload after a save; show restored values after Undo). */
export interface AutoSaveHooks {
  onSaved: () => void | Promise<void>;
  onUndone: () => void;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; undoId: number | null; note?: string }
  | { kind: 'error'; text: string };

interface Options<T> {
  /** Settings group, e.g. "store". */
  settingsKey: string;
  /** The value to autosave, without passwords/keys (blank = keep the saved one). */
  value: T;
  /** Called after any save or undo (reload what the page shows). */
  onSaved?: () => void | Promise<void>;
  /** Called after Undo, so the form can show the restored values. */
  onUndone?: () => void;
  delayMs?: number;
  enabled?: boolean;
}

export function useAutoSave<T>({ settingsKey, value, onSaved, onUndone, delayMs = 1500, enabled = true }: Options<T>) {
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const lastSent = useRef(JSON.stringify(value));
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const callbacks = useRef({ onSaved, onUndone });
  useEffect(() => {
    callbacks.current = { onSaved, onUndone };
  });

  const send = useCallback(
    async (settings: unknown, auto: boolean) => {
      setStatus({ kind: 'saving' });
      const { ok, data } = await sendJson<{ message?: string; undoId?: number | null; warning?: string }>('PUT', `/api/admin/settings/${settingsKey}`, { settings, auto });
      if (!ok) {
        setStatus({ kind: 'error', text: data.message || 'Not saved. Your previous settings are still in use.' });
        return data.message || 'Not saved.';
      }
      setStatus({ kind: 'saved', undoId: data.undoId ?? null, note: data.warning });
      await callbacks.current.onSaved?.();
      return null;
    },
    [settingsKey]
  );

  const json = JSON.stringify(value);
  useEffect(() => {
    if (!enabled || json === lastSent.current) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      lastSent.current = json;
      void send(JSON.parse(json), true);
    }, delayMs);
    return () => clearTimeout(timer.current);
  }, [json, enabled, delayMs, send]);

  /** The Save button: now, with everything (passwords and keys included). */
  const saveNow = useCallback(
    async (full: unknown) => {
      clearTimeout(timer.current);
      lastSent.current = json;
      return send(full, false);
    },
    [json, send]
  );

  const undo = useCallback(async () => {
    if (status.kind !== 'saved' || !status.undoId) return;
    setStatus({ kind: 'saving' });
    const { ok, data } = await postJson<{ message?: string }>('/api/admin/settings/history', { id: status.undoId });
    if (!ok) {
      setStatus({ kind: 'error', text: data.message || 'Could not undo.' });
      return;
    }
    setStatus({ kind: 'idle' });
    await callbacks.current.onSaved?.();
    callbacks.current.onUndone?.();
  }, [status]);

  const bar = <AutoSaveBar status={status} onUndo={() => void undo()} />;
  return { status, saveNow, undo, bar };
}

function AutoSaveBar({ status, onUndo }: { status: Status; onUndo: () => void }) {
  if (status.kind === 'idle') return <p className="text-[11px] text-stone-500">Changes save automatically.</p>;
  if (status.kind === 'saving')
    return (
      <p className="text-[11px] text-stone-600 flex items-center gap-1" role="status">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Saving…
      </p>
    );
  if (status.kind === 'error')
    return (
      <p className="text-xs text-red-700 font-semibold flex items-start gap-1" role="alert">
        <ShieldAlert className="w-4 h-4 shrink-0" /> {status.text}
      </p>
    );
  return (
    <p className="text-xs text-emerald-800 font-semibold flex flex-wrap items-center gap-2" role="status">
      <Check className="w-4 h-4" /> Saved automatically.
      {status.note && <span className="text-amber-800 font-normal">{status.note}</span>}
      {status.undoId && (
        <button type="button" onClick={onUndo} className="inline-flex items-center gap-1 underline text-stone-700">
          <RotateCcw className="w-3.5 h-3.5" /> Undo
        </button>
      )}
    </p>
  );
}
