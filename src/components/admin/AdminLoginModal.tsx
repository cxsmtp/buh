'use client';

import React, { useEffect, useState } from 'react';
import { Lock, ShieldCheck, ArrowRight, Eye, EyeOff, Check, KeyRound, LifeBuoy, X } from 'lucide-react';
import { getJson, postJson } from '@/lib/apiClient';
import { passkeyErrorMessage, passkeysSupported, webauthnBrowser } from '@/lib/client/passkeys';

const input = 'w-full px-3.5 py-2.5 rounded-xl border border-line-strong bg-surface text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-gold text-xs';
const primary = 'w-full bg-ink hover:bg-ink disabled:opacity-60 text-paper font-bold py-3.5 rounded-xl shadow-lg flex items-center justify-center gap-2 text-xs mt-2';
const quiet = 'text-ink-soft hover:text-ink font-semibold py-1 underline-offset-2 hover:underline';

interface AdminLoginModalProps {
  isOpen: boolean;
  /** The owner closed the sign-in (not called after a successful sign-in: onLoginSuccess is). */
  onClose: () => void;
  onLoginSuccess: () => void;
  /** A one-time token from a password-reset email link (#reset=…): opens "Choose a new password". */
  resetToken?: string | null;
  onResetDone?: () => void;
}

export const AdminLoginModal: React.FC<AdminLoginModalProps> = ({
  isOpen,
  onClose,
  onLoginSuccess,
  resetToken = null,
  onResetDone,
}) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // After a first-run sign-in the server requires a new password before anything else.
  const [mustChange, setMustChange] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  // "Forgot password?": ask for a link by email.
  const [forgot, setForgot] = useState(false);
  const [notice, setNotice] = useState('');
  // "Use a recovery code": email + code, then a new password (no current password: it was forgotten).
  const [recovery, setRecovery] = useState(false);
  const [code, setCode] = useState('');
  const [recoveryPending, setRecoveryPending] = useState(false);
  const [codesLeft, setCodesLeft] = useState<number | null>(null);
  // Signed in with a code, but the password is set in the server's .env.production: it can't be changed here.
  const [envManaged, setEnvManaged] = useState(false);

  // Reopened after a recovery-code sign-in (a reload, say): go straight to "choose a new password".
  useEffect(() => {
    if (!isOpen || resetToken) return;
    let cancelled = false;
    void getJson<{ authenticated?: boolean; recoveryPending?: boolean }>('/api/admin/session').then(({ ok, data }) => {
      if (!cancelled && ok && data.authenticated && data.recoveryPending) setRecoveryPending(true);
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen, resetToken]);

  if (!isOpen) return null;
  const resetting = Boolean(resetToken);
  const canUsePasskey = passkeysSupported();

  const finish = () => {
    setPassword('');
    setCode('');
    setNewPassword('');
    setConfirmPassword('');
    setRecovery(false);
    setRecoveryPending(false);
    setEnvManaged(false);
    setMustChange(false);
    onLoginSuccess();
  };

  const handlePasskey = async () => {
    setError('');
    setNotice('');
    setBusy(true);
    try {
      const start = await postJson<{ options?: unknown; message?: string }>('/api/admin/login/passkey/options', {});
      if (!start.ok || !start.data.options) {
        setError(start.data.message || 'Passkey sign-in is not available right now.');
        return;
      }
      const { startAuthentication } = await webauthnBrowser();
      let response: unknown;
      try {
        response = await startAuthentication({ optionsJSON: start.data.options as Parameters<typeof startAuthentication>[0]['optionsJSON'] });
      } catch (err) {
        setError(passkeyErrorMessage(err, 'sign in'));
        return;
      }
      const { ok, data } = await postJson<{ message?: string }>('/api/admin/login/passkey', { response });
      if (!ok) {
        setError(data.message || 'That passkey was not accepted.');
        return;
      }
      finish();
    } finally {
      setBusy(false);
    }
  };

  const handleRecovery = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    const { ok, data } = await postJson<{ message?: string; mustChangePassword?: boolean; managedByEnv?: boolean; remaining?: number }>('/api/admin/login/recovery', {
      email: email.trim(),
      code: code.trim(),
    });
    setBusy(false);
    if (!ok) {
      setError(data.message || 'Sign-in failed. Please try again.');
      return;
    }
    setCode('');
    setRecovery(false);
    setCodesLeft(typeof data.remaining === 'number' ? data.remaining : null);
    if (data.mustChangePassword) setRecoveryPending(true);
    else if (data.managedByEnv) setEnvManaged(true);
    else finish();
  };

  const handleRecoveryPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (newPassword !== confirmPassword) {
      setError('The new passwords do not match.');
      return;
    }
    setBusy(true);
    const { ok, data } = await postJson<{ message?: string }>('/api/admin/password', { newPassword });
    setBusy(false);
    if (!ok) {
      setError(data.message || 'Could not change the password.');
      return;
    }
    finish();
  };

  const codesLeftNote =
    codesLeft === null ? null : (
      <p className={`rounded-xl border p-2.5 leading-relaxed ${codesLeft <= 2 ? 'bg-warning-soft border-warning-line text-warning' : 'bg-ivory border-line text-ink-soft'}`}>
        {codesLeft === 0
          ? 'That was your last recovery code. Create a new set in Settings → Passkeys & recovery codes straight away.'
          : `You have ${codesLeft} recovery code${codesLeft === 1 ? '' : 's'} left.${codesLeft <= 2 ? ' Create a new set in Settings → Passkeys & recovery codes soon.' : ''}`}
      </p>
    );

  const handleForgot = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    const { ok, data } = await postJson<{ message?: string }>('/api/admin/password/forgot', { email: email.trim() });
    setBusy(false);
    if (!ok) {
      setError(data.message || 'Could not send the link. Please try again.');
      return;
    }
    setNotice(data.message || 'If that is the admin email, a reset link is on its way.');
    setForgot(false);
  };

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (newPassword !== confirmPassword) {
      setError('The new passwords do not match.');
      return;
    }
    setBusy(true);
    const { ok, data } = await postJson<{ message?: string }>('/api/admin/password/reset', { token: resetToken, newPassword });
    setBusy(false);
    if (!ok) {
      setError(data.message || 'Could not change the password.');
      return;
    }
    setNewPassword('');
    setConfirmPassword('');
    setNotice(data.message || 'Password changed. Sign in with the new password.');
    onResetDone?.();
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    const { ok, data } = await postJson<{ message?: string; mustChangePassword?: boolean }>('/api/admin/login', {
      email: email.trim(),
      password,
    });
    setBusy(false);
    if (!ok) {
      setError(data.message || 'Sign-in failed. Please try again.');
      return;
    }
    if (data.mustChangePassword) {
      setMustChange(true);
      return;
    }
    setPassword('');
    onLoginSuccess();
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (newPassword !== confirmPassword) {
      setError('The new passwords do not match.');
      return;
    }
    setBusy(true);
    const { ok, data } = await postJson<{ message?: string }>('/api/admin/password', {
      currentPassword: password,
      newPassword,
    });
    setBusy(false);
    if (!ok) {
      setError(data.message || 'Could not change the password.');
      return;
    }
    setPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setMustChange(false);
    onLoginSuccess();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/45 p-3 sm:p-4 overscroll-contain" role="dialog" aria-modal="true" aria-labelledby="admin-login-title">
      <div className="bg-surface rounded-3xl max-w-md w-full min-w-0 max-h-[calc(100dvh-1.5rem)] overflow-y-auto overflow-x-hidden overscroll-contain p-6 space-y-5 border border-line">
        {/* Header (stays in view, with its close button) */}
        <div className="sticky top-0 z-10 -mx-6 -mt-6 px-6 pt-6 pb-2 bg-surface text-center space-y-1.5">
          <button type="button" onClick={onClose} aria-label="Close sign-in" className="absolute top-3 right-3 w-10 h-10 flex items-center justify-center rounded-full text-ink hover:bg-sand">
            <X className="w-5 h-5" strokeWidth={1.5} aria-hidden="true" />
          </button>
          <div className="w-12 h-12 rounded-full border border-gold text-gold-deep flex items-center justify-center mx-auto">
            <Lock className="w-5 h-5" strokeWidth={1.5} />
          </div>
          <h2 id="admin-login-title" className="font-serif text-2xl text-ink">
            Admin Hub Security Access
          </h2>
          <p className="text-xs text-ink-muted">
            Beautiful UAE Home • Operations, Couriers & Inventory
          </p>
        </div>

        {/* Error message */}
        {error && (
          <div className="bg-danger-soft text-danger text-xs p-3 rounded-xl border border-danger-line font-medium">
            {error}
          </div>
        )}

        {notice && !error && (
          <div role="status" className="bg-success-soft text-success text-xs p-3 rounded-xl border border-success-line font-medium">
            {notice}
          </div>
        )}

        {resetting ? (
          <form onSubmit={handleReset} className="space-y-3.5 text-xs">
            <p className="text-ink-soft leading-relaxed">
              Choose a new admin password: at least 12 characters, with at least 5 different characters. Every device is signed out.
            </p>
            <div>
              <label htmlFor="admin-reset-password" className="block text-ink font-semibold mb-1">New password</label>
              <input id="admin-reset-password" type="password" required minLength={12} maxLength={256} autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className="w-full px-3.5 py-2.5 rounded-xl border border-line-strong bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-gold text-xs" />
            </div>
            <div>
              <label htmlFor="admin-reset-confirm" className="block text-ink font-semibold mb-1">Confirm new password</label>
              <input id="admin-reset-confirm" type="password" required minLength={12} maxLength={256} autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} className="w-full px-3.5 py-2.5 rounded-xl border border-line-strong bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-gold text-xs" />
            </div>
            <button type="submit" disabled={busy} className="w-full bg-ink hover:bg-ink disabled:opacity-60 text-paper font-bold py-3.5 rounded-xl shadow-lg flex items-center justify-center gap-2 text-xs mt-2">
              <Check className="w-4 h-4 text-gold-light" />
              <span>{busy ? 'Saving…' : 'Set New Password'}</span>
            </button>
            {error && (
              <button
                type="button"
                onClick={() => {
                  onResetDone?.();
                  setError('');
                  setForgot(true);
                }}
                className="w-full text-ink-muted hover:text-ink font-semibold py-1"
              >
                Ask for a new link
              </button>
            )}
          </form>
        ) : recoveryPending ? (
          <form onSubmit={handleRecoveryPassword} className="space-y-3.5 text-xs">
            <p className="text-ink-soft leading-relaxed">
              <strong>You&apos;re in.</strong> Now choose a new admin password: at least 12 characters, with at least 5 different characters. Every other device has been signed out.
            </p>
            {codesLeftNote}
            <div>
              <label htmlFor="admin-recovery-new" className="block text-ink font-semibold mb-1">New password</label>
              <input id="admin-recovery-new" type="password" required minLength={12} maxLength={256} autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className={input} />
            </div>
            <div>
              <label htmlFor="admin-recovery-confirm" className="block text-ink font-semibold mb-1">Confirm new password</label>
              <input id="admin-recovery-confirm" type="password" required minLength={12} maxLength={256} autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} className={input} />
            </div>
            <button type="submit" disabled={busy} className={primary}>
              <Check className="w-4 h-4 text-gold-light" />
              <span>{busy ? 'Saving…' : 'Save New Password'}</span>
            </button>
          </form>
        ) : envManaged ? (
          <div className="space-y-3.5 text-xs">
            <p role="status" className="bg-warning-soft text-warning border border-warning-line rounded-xl p-3 leading-relaxed">
              <strong>You&apos;re signed in.</strong> Your password can&apos;t be changed here: it is set on the server (ADMIN_PASSWORD_HASH in .env.production).
              To choose a new one, make a new hash with <code className="font-mono">npm run hash-password</code>, put it in .env.production and restart the shop (see the deployment guide), or ask whoever runs your server.
            </p>
            {codesLeftNote}
            <button type="button" onClick={finish} className={primary}>
              <span>Continue to the Admin Hub</span>
              <ArrowRight className="w-4 h-4 text-gold-light" />
            </button>
          </div>
        ) : recovery ? (
          <form onSubmit={handleRecovery} className="space-y-3.5 text-xs">
            <p className="text-ink-soft leading-relaxed">
              Type your admin email and one of the recovery codes you saved (they look like <span className="font-mono whitespace-nowrap">ABCD-EFGH-JKLM-NPQR</span>). Each code works once.
              You&apos;ll choose a new password next, and every other device is signed out.
            </p>
            <div>
              <label htmlFor="admin-recovery-email" className="block text-ink font-semibold mb-1">Admin Email</label>
              <input id="admin-recovery-email" type="email" required maxLength={254} autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} className={input} />
            </div>
            <div>
              <label htmlFor="admin-recovery-code" className="block text-ink font-semibold mb-1">Recovery code</label>
              <input
                id="admin-recovery-code"
                type="text"
                required
                maxLength={40}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                placeholder="XXXX-XXXX-XXXX-XXXX"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className={`${input} font-mono tracking-wider uppercase`}
              />
            </div>
            <button type="submit" disabled={busy} className={primary}>
              <span>{busy ? 'Checking…' : 'Sign In With Recovery Code'}</span>
              <ArrowRight className="w-4 h-4 text-gold-light" />
            </button>
            <button type="button" onClick={() => { setRecovery(false); setError(''); }} className={`w-full ${quiet}`}>
              Back to sign-in
            </button>
          </form>
        ) : forgot ? (
          <form onSubmit={handleForgot} className="space-y-3.5 text-xs">
            <p className="text-ink-soft leading-relaxed">
              Type the admin email. If it matches, we email a link to choose a new password (it works once, for 30 minutes).
            </p>
            <div>
              <label htmlFor="admin-forgot-email" className="block text-ink font-semibold mb-1">Admin Email</label>
              <input id="admin-forgot-email" type="email" required maxLength={254} autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full px-3.5 py-2.5 rounded-xl border border-line-strong bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-gold text-xs" />
            </div>
            <button type="submit" disabled={busy} className="w-full bg-ink hover:bg-ink disabled:opacity-60 text-paper font-bold py-3.5 rounded-xl shadow-lg flex items-center justify-center gap-2 text-xs mt-2">
              <span>{busy ? 'Sending…' : 'Email Me a Reset Link'}</span>
            </button>
            <button type="button" onClick={() => { setForgot(false); setError(''); }} className="w-full text-ink-muted hover:text-ink font-semibold py-1">
              Back to sign-in
            </button>
          </form>
        ) : mustChange ? (
          <form onSubmit={handleChangePassword} className="space-y-3.5 text-xs">
            <p className="text-ink-soft leading-relaxed">
              Choose your own admin password to finish signing in: at least 12 characters, with at least 5 different characters.
            </p>
            <div>
              <label htmlFor="admin-new-password" className="block text-ink font-semibold mb-1">New password</label>
              <input
                id="admin-new-password"
                type="password"
                required
                minLength={12}
                maxLength={256}
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl border border-line-strong bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-gold text-xs"
              />
            </div>
            <div>
              <label htmlFor="admin-confirm-password" className="block text-ink font-semibold mb-1">Confirm new password</label>
              <input
                id="admin-confirm-password"
                type="password"
                required
                minLength={12}
                maxLength={256}
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl border border-line-strong bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-gold text-xs"
              />
            </div>
            <button
              type="submit"
              disabled={busy}
              className="w-full bg-ink hover:bg-ink disabled:opacity-60 text-paper font-bold py-3.5 rounded-xl shadow-lg flex items-center justify-center gap-2 transition-all active:scale-95 text-xs mt-2"
            >
              <Check className="w-4 h-4 text-gold-light" />
              <span>{busy ? 'Saving…' : 'Save Password & Continue'}</span>
            </button>
          </form>
        ) : (
        <form onSubmit={handleLogin} className="space-y-3.5 text-xs">
          <div>
            <label className="block text-ink font-semibold mb-1">
              Admin Email
            </label>
            <input
              type="email"
              required
              maxLength={254}
              autoComplete="username"
              placeholder="admin@beautifuluaehome.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-xl border border-line-strong bg-surface text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-gold focus:bg-surface text-xs"
            />
          </div>

          <div>
            <label className="block text-ink font-semibold mb-1">
              Admin Password
            </label>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                required
                maxLength={256}
                autoComplete="current-password"
                placeholder="••••••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl border border-line-strong bg-surface text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-gold focus:bg-surface pr-10 text-xs"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                className="absolute right-3 top-2.5 text-ink-muted hover:text-ink-soft"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={busy}
            className="w-full bg-ink hover:bg-ink disabled:opacity-60 text-paper font-bold py-3.5 rounded-xl shadow-lg flex items-center justify-center gap-2 transition-all active:scale-95 text-xs mt-2"
          >
            <span>{busy ? 'Checking…' : 'Unlock Admin Portal'}</span>
            <ArrowRight className="w-4 h-4 text-gold-light" />
          </button>
          {canUsePasskey && (
            <button
              type="button"
              onClick={() => void handlePasskey()}
              disabled={busy}
              className="w-full border border-line-strong bg-surface hover:bg-ivory disabled:opacity-60 text-ink font-bold py-3 rounded-xl flex items-center justify-center gap-2 text-xs"
            >
              <KeyRound className="w-4 h-4 text-gold-deep" />
              <span>Sign in with a passkey</span>
            </button>
          )}
          <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-1">
            <button type="button" onClick={() => { setForgot(true); setError(''); setNotice(''); }} className={quiet}>
              Forgot password?
            </button>
            <button type="button" onClick={() => { setRecovery(true); setError(''); setNotice(''); }} className={`${quiet} inline-flex items-center gap-1`}>
              <LifeBuoy className="w-3.5 h-3.5" aria-hidden="true" /> Use a recovery code
            </button>
          </div>
        </form>
        )}

        <div className="bg-ivory rounded-2xl p-3 border border-line text-[11px] text-ink-soft leading-relaxed flex gap-2">
          <ShieldCheck className="w-4 h-4 text-gold shrink-0 mt-0.5" />
          <span>
            First time here? The owner account&apos;s one-time password is printed in the server log when the
            shop first starts. You will choose your own password right after signing in.
          </span>
        </div>

        {/* Cancel button */}
        <div className="text-center pt-1">
          <button
            type="button"
            onClick={onClose}
            className="text-ink-muted hover:text-ink-soft text-xs font-semibold"
          >
            Return to Storefront
          </button>
        </div>
      </div>
    </div>
  );
};
