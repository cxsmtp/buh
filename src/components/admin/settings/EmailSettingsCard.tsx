'use client';

import React, { useEffect, useState } from 'react';
import { Loader2, Mail, Send, UserCog } from 'lucide-react';
import type { EmailSettings } from '@/types';
import { useAutoSave, type AutoSaveHooks } from './useAutoSave';
import { getJson, postJson, sendJson } from '@/lib/apiClient';

/**
 * Settings → Email & admin account. The mail server the shop sends with
 * (backups, alerts, the daily summary, password-reset links), where those go,
 * and the admin's sign-in email. Empty server = the SMTP_* values in
 * .env.production. The password is write-only: it is never sent back.
 */

const field = 'w-full px-3 py-2 rounded-xl border border-line-strong bg-surface text-ink text-sm focus:outline-none focus:ring-2 focus:ring-gold';
const label = 'block text-xs font-semibold text-ink-soft mb-1';

export function EmailSettingsCard({
  value,
  passwordSaved,
  imapPasswordSaved = false,
  onSave,
  auto,
}: {
  value: EmailSettings;
  passwordSaved: boolean;
  imapPasswordSaved?: boolean;
  auto?: AutoSaveHooks;
  onSave: (v: EmailSettings) => Promise<string | null>;
}) {
  const [d, setD] = useState<EmailSettings>(value);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const set = <K extends keyof EmailSettings>(k: K, v: EmailSettings[K]) => setD((x) => ({ ...x, [k]: v }));
  // Passwords are never autosaved (half-typed ones would replace working ones): Save sends them.
  const autosave = useAutoSave({ settingsKey: 'email', value: { ...d, smtpPass: '', imapPass: '' }, enabled: Boolean(auto), ...auto });

  const save = async () => {
    autosave.cancel();
    setSaving(true);
    setStatus(null);
    const problem = await onSave(d);
    setSaving(false);
    if (!problem) setD((x) => ({ ...x, smtpPass: '', imapPass: '' }));
    setStatus(problem ? { ok: false, text: problem } : { ok: true, text: 'Saved. Use "Send a test email" to check it works.' });
    return problem;
  };
  // A typed password is only sent by Save; until then autosave keeps the old one (or none).
  const unsavedPassword = Boolean(d.smtpPass || d.imapPass);

  const test = async () => {
    // Testing with a password still in the box means "test what I typed": save it first.
    if (unsavedPassword && (await save())) return;
    setTesting(true);
    setStatus(null);
    const { ok, data } = await postJson<{ message?: string }>('/api/admin/email-test', {});
    setTesting(false);
    setStatus({ ok, text: data.message || (ok ? 'Sent.' : 'Could not send.') });
  };

  return (
    <div className="space-y-6 text-sm">
      <section className="space-y-3">
        <h3 className="font-bold text-ink flex items-center gap-2"><Mail className="w-4 h-4 text-gold" /> Mail server (SMTP)</h3>
        <p className="text-xs text-ink-muted">
          Your email provider&apos;s SMTP details (Hostinger: smtp.hostinger.com, port 465, TLS; Gmail: smtp.gmail.com, port 587, STARTTLS, with an app password).
          Leave the server empty to use SMTP_* from .env.production.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={label} htmlFor="em-host">Server</label>
            <input id="em-host" className={field} placeholder="smtp.hostinger.com" autoCapitalize="none" spellCheck={false} value={d.smtpHost} maxLength={253} onChange={(e) => set('smtpHost', e.target.value.trim())} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={label} htmlFor="em-port">Port</label>
              <select
                id="em-port"
                className={field}
                value={d.smtpPort}
                onChange={(e) => {
                  const port = Number(e.target.value);
                  setD((x) => ({ ...x, smtpPort: port, smtpSecurity: port === 465 ? 'tls' : 'starttls' }));
                }}
              >
                {[465, 587, 2525, 25].map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div>
              <label className={label} htmlFor="em-sec">Security</label>
              <select id="em-sec" className={field} value={d.smtpSecurity} onChange={(e) => set('smtpSecurity', e.target.value as EmailSettings['smtpSecurity'])}>
                <option value="tls">TLS</option>
                <option value="starttls">STARTTLS</option>
              </select>
            </div>
            {(d.smtpPort === 465) !== (d.smtpSecurity === 'tls') && (
              <p role="status" className="col-span-2 text-xs font-semibold text-warning">
                Port {d.smtpPort} usually needs Security “{d.smtpPort === 465 ? 'TLS' : 'STARTTLS'}”.{' '}
                <button type="button" className="underline" onClick={() => set('smtpSecurity', d.smtpPort === 465 ? 'tls' : 'starttls')}>
                  Use {d.smtpPort === 465 ? 'TLS' : 'STARTTLS'}
                </button>
              </p>
            )}
          </div>
          <div>
            <label className={label} htmlFor="em-user">Username</label>
            <input id="em-user" className={field} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="shop@yourdomain.ae" value={d.smtpUser} maxLength={254} onChange={(e) => set('smtpUser', e.target.value.trim())} />
          </div>
          <div>
            <label className={label} htmlFor="em-pass">Password</label>
            <input
              id="em-pass"
              className={field}
              type="password"
              autoComplete="new-password"
              placeholder={passwordSaved ? 'Saved: type to replace' : 'Mailbox or app password'}
              value={d.smtpPass}
              maxLength={256}
              onChange={(e) => set('smtpPass', e.target.value)}
            />
          </div>
          <div>
            <label className={label} htmlFor="em-from">Send from</label>
            <input id="em-from" className={field} type="email" placeholder="Same as the username" value={d.fromAddress} maxLength={254} onChange={(e) => set('fromAddress', e.target.value.trim())} />
          </div>
          <div>
            <label className={label} htmlFor="em-to">Send backups and alerts to</label>
            <input id="em-to" className={field} placeholder="you@example.com, partner@example.com" value={d.sendTo} maxLength={600} onChange={(e) => set('sendTo', e.target.value)} />
            <p className="text-[11px] text-ink-muted mt-1">Up to 5, separated by commas. Empty uses BACKUP_EMAIL.</p>
          </div>
        </div>
        <details className="rounded-xl border border-line p-3" open={Boolean(d.imapHost)}>
          <summary className="text-xs font-bold text-ink cursor-pointer">Answer chats by replying to the email (mailbox, IMAP)</summary>
          <p className="text-xs text-ink-muted mt-2">
            When a customer asks for a person, you get an email. If the shop can read the mailbox those replies go to, your reply appears in the customer&apos;s chat.
            Hostinger: imap.hostinger.com; Gmail: imap.gmail.com (with an app password). Leave the server empty to switch this off.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-2">
            <div>
              <label className={label} htmlFor="em-imap">Mailbox server</label>
              <input id="em-imap" className={field} placeholder="imap.hostinger.com" autoCapitalize="none" spellCheck={false} value={d.imapHost} maxLength={253} onChange={(e) => set('imapHost', e.target.value.trim())} />
            </div>
            <div>
              <label className={label} htmlFor="em-imap-user">Mailbox username</label>
              <input id="em-imap-user" className={field} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="Same as above" value={d.imapUser} maxLength={254} onChange={(e) => set('imapUser', e.target.value.trim())} />
            </div>
            <div>
              <label className={label} htmlFor="em-imap-pass">Mailbox password</label>
              <input id="em-imap-pass" className={field} type="password" autoComplete="new-password" placeholder={imapPasswordSaved ? 'Saved: type to replace' : 'Same as above'} value={d.imapPass} maxLength={256} onChange={(e) => set('imapPass', e.target.value)} />
            </div>
          </div>
        </details>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void save()} disabled={saving} className="px-4 py-2 rounded-xl bg-ink text-white text-xs font-bold flex items-center gap-1.5 disabled:opacity-60">
            {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Save email settings
          </button>
        {auto && autosave.bar}
        {unsavedPassword && (
          <p role="status" className="text-xs font-semibold text-warning">
            The password you typed is not saved yet: press “Save email settings” (or “Send a test email”, which saves it first).
          </p>
        )}
          <button type="button" onClick={() => void test()} disabled={testing} className="px-4 py-2 rounded-xl border border-line-strong text-xs font-bold flex items-center gap-1.5 disabled:opacity-60">
            {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />} Send a test email
          </button>
        </div>
        {status && <p role="status" className={`text-xs font-semibold ${status.ok ? 'text-success' : 'text-danger'}`}>{status.text}</p>}
      </section>

      <AdminAccountCard />
    </div>
  );
}

/** The admin's sign-in email: password reset links go here. */
function AdminAccountCard() {
  const [info, setInfo] = useState<{ email: string; managedByEnv: boolean } | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    void getJson<{ email: string; managedByEnv: boolean }>('/api/admin/account').then(({ ok, data }) => {
      if (!ok) return;
      setInfo(data);
      setEmail(data.email);
    });
  }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setStatus(null);
    const { ok, data } = await sendJson<{ message?: string; email?: string; managedByEnv?: boolean }>('PUT', '/api/admin/account', { email, currentPassword: password });
    setBusy(false);
    setPassword('');
    if (ok && data.email) setInfo({ email: data.email, managedByEnv: Boolean(data.managedByEnv) });
    setStatus(ok ? { ok: true, text: 'Saved. Sign in with this email from now on; other devices are signed out.' } : { ok: false, text: data.message || 'Could not save.' });
  };

  return (
    <section className="space-y-3 border-t border-line pt-5">
      <h3 className="font-bold text-ink flex items-center gap-2"><UserCog className="w-4 h-4 text-gold" /> Admin account</h3>
      {info?.managedByEnv ? (
        <p className="text-xs text-ink-soft">
          Signed in as <strong>{info.email}</strong>. This account is set by ADMIN_EMAIL / ADMIN_PASSWORD_HASH in .env.production, so change it there.
        </p>
      ) : (
        <form onSubmit={(e) => void save(e)} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <p className="sm:col-span-2 text-xs text-ink-muted">The email you sign in with. &ldquo;Forgot password?&rdquo; sends the reset link here, so use a mailbox you read. For a way in without email, add a passkey or recovery codes in &ldquo;Passkeys &amp; recovery codes&rdquo;.</p>
          <div>
            <label className={label} htmlFor="acct-email">Sign-in email</label>
            <input id="acct-email" className={field} type="email" required autoComplete="username" value={email} maxLength={254} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <label className={label} htmlFor="acct-pass">Current password</label>
            <input id="acct-pass" className={field} type="password" required autoComplete="current-password" value={password} maxLength={256} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <div className="sm:col-span-2">
            <button type="submit" disabled={busy || !info || email.trim().toLowerCase() === info.email} className="px-4 py-2 rounded-xl bg-ink text-white text-xs font-bold flex items-center gap-1.5 disabled:opacity-50">
              {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Change sign-in email
            </button>
          </div>
        </form>
      )}
      {status && <p role="status" className={`text-xs font-semibold ${status.ok ? 'text-success' : 'text-danger'}`}>{status.text}</p>}
    </section>
  );
}
