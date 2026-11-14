'use client';

import React, { useRef, useState, useSyncExternalStore } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';
import { sendJson, type ApiResult } from '@/lib/apiClient';
import { Sheet } from '@/components/common/Sheet';

/**
 * "It's you again": the bank account, payment keys, the SMS gateway, the mail server and inviting an
 * accountant need more than a signed-in hub (src/lib/server/adminAuth.ts: confirmOwnerForChange). The
 * server refuses such a change with the code `owner_confirm` unless the owner signed in within the
 * last 10 minutes; the hub then asks for the password once, here, and sends the change again with
 * it. That makes the session a fresh sign-in, so the next changes are not asked for 10 minutes.
 *
 * The password is held only while the dialog is open and the change is being sent; it is never kept.
 */

interface Asking {
  id: number;
  /** What is being changed, in the owner's words (e.g. "the bank details"). */
  what: string;
  /** The server said the password typed was wrong (or sign-in is paused): shown above the field. */
  error: string;
  resolve: (password: string | null) => void;
}

let asking: Asking | null = null;
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

/** Is the dialog on the page (the owner's hub)? Without it nothing can be asked. */
let mounted = 0;

function ask(what: string, error: string): Promise<string | null> {
  if (!mounted) return Promise.resolve(null);
  return new Promise((resolve) => {
    asking = { id: ++seq, what, error, resolve };
    emit();
  });
}

function close() {
  asking = null;
  emit();
}

/**
 * The button that started the change is switched off while it is being sent, so the dialog cannot
 * hand the keyboard back to it when it closes. Once the button is usable again (a moment later),
 * focus goes back to it, unless the owner has already moved somewhere else.
 */
function refocus(opener: Element | null) {
  if (!(opener instanceof HTMLElement)) return;
  let tries = 0;
  const attempt = () => {
    const at = document.activeElement;
    if (at && at !== document.body && at !== opener) return;
    if (!document.contains(opener)) return;
    if (!(opener as HTMLButtonElement).disabled) {
      opener.focus({ preventScroll: true });
      if (document.activeElement === opener) return;
    }
    if (++tries < 40) setTimeout(attempt, 50);
  };
  setTimeout(attempt, 0);
}

/** One question at a time: a second change that needs the owner waits for the first to be answered. */
let gate: Promise<void> = Promise.resolve();

interface Refusal {
  message?: string;
  code?: string;
}

const needsOwner = (res: ApiResult<Refusal>) => !res.ok && (res.data.code === 'owner_confirm' || res.data.code === 'owner_confirm_wrong');

/** The server asks for the owner's password with this change (see above). */
export function ownerConfirmNeeded(res: { ok: boolean; data: unknown }): boolean {
  return needsOwner(res as ApiResult<Refusal>);
}

export const OWNER_CONFIRM_CANCELLED = 'Nothing was changed: your hub password is needed for this.';

/**
 * Send a change that may need the owner again. Sent as it is first; when the server asks for the
 * password, the dialog opens, and the same change is sent again with it (asked again after a wrong
 * one). Cancelled: the refusal comes back with a plain message, and nothing was changed.
 */
export async function sendConfirmed<T = Record<string, unknown>>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body: Record<string, unknown>, what = 'these settings'): Promise<ApiResult<T>> {
  // What the owner pressed (read now: it is switched off, and loses focus, while the change is sent).
  const opener = typeof document === 'undefined' ? null : document.activeElement;
  let res = await sendJson<T>(method, url, body);
  if (!needsOwner(res as ApiResult<Refusal>)) return res;
  const before = gate;
  let release: () => void = () => {};
  gate = new Promise<void>((r) => {
    release = r;
  });
  await before;
  let asked = false;
  try {
    // Another change may have just been confirmed while this one waited: no need to ask twice.
    res = await sendJson<T>(method, url, body);
    while (needsOwner(res as ApiResult<Refusal>)) {
      const refusal = res.data as Refusal;
      asked = true;
      const password = await ask(what, refusal.code === 'owner_confirm_wrong' ? refusal.message || 'That is not your current password.' : '');
      if (password === null) {
        close();
        return { ok: false, status: res.status, data: { ...res.data, message: OWNER_CONFIRM_CANCELLED, code: 'owner_confirm_cancelled' } as T };
      }
      res = await sendJson<T>(method, url, { ...body, currentPassword: password });
    }
    close();
    return res;
  } finally {
    release();
    if (asked) refocus(opener);
  }
}

/** The dialog itself: once, in the owner's hub. */
export function OwnerConfirmDialog() {
  const now = useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      mounted++;
      return () => {
        listeners.delete(fn);
        mounted--;
      };
    },
    () => asking,
    () => null
  );
  if (!now) return null;
  return <Asked key={now.id} asking={now} />;
}

function Asked({ asking: a }: { asking: Asking }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const cancel = () => {
    if (!busy) a.resolve(null);
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    a.resolve(password);
  };
  return (
    <Sheet labelledBy="owner-confirm-title" onClose={cancel} initialFocus={input}>
      <form onSubmit={submit} className="p-5 space-y-3 text-sm overflow-y-auto" data-testid="owner-confirm">
        <h2 id="owner-confirm-title" className="font-serif text-xl text-ink flex items-center gap-2">
          <ShieldCheck className="w-5 h-5 text-gold-deep shrink-0" aria-hidden="true" /> Confirm it&rsquo;s you
        </h2>
        <p className="text-xs text-ink-soft leading-relaxed">
          Type your hub password to change {a.what}. These decide where your money and messages go, so the hub asks again even while you are signed in. It will not ask again for the next 10 minutes.
        </p>
        <div>
          <label htmlFor="owner-confirm-password" className="block text-xs font-semibold text-ink-soft mb-1">
            Your hub password
          </label>
          <input
            ref={input}
            id="owner-confirm-password"
            type="password"
            autoComplete="current-password"
            maxLength={256}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-describedby={a.error ? 'owner-confirm-error' : undefined}
            aria-invalid={a.error ? true : undefined}
            className="w-full min-w-0 min-h-11 px-3 py-2 rounded-xl border border-line-strong bg-surface text-ink text-sm focus:outline-none focus:ring-2 focus:ring-gold"
          />
        </div>
        {a.error && (
          <p id="owner-confirm-error" role="alert" className="text-xs font-semibold text-danger">
            {a.error}
          </p>
        )}
        <div className="flex flex-wrap gap-2 pt-1">
          <button type="submit" disabled={busy || !password} className="min-h-11 px-4 rounded-xl bg-ink text-paper text-xs font-bold inline-flex items-center justify-center gap-1.5 disabled:opacity-60">
            {busy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
            {busy ? 'Checking…' : 'Confirm'}
          </button>
          <button type="button" onClick={cancel} disabled={busy} className="min-h-11 px-4 rounded-xl border border-line-strong bg-surface text-ink text-xs font-bold disabled:opacity-60">
            Cancel
          </button>
        </div>
      </form>
    </Sheet>
  );
}
