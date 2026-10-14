'use client';

import React, { useState } from 'react';
import { Lock, ShieldCheck, ArrowRight, Eye, EyeOff, Check } from 'lucide-react';
import { postJson } from '@/lib/apiClient';

interface AdminLoginModalProps {
  isOpen: boolean;
  onClose: () => void;
  onLoginSuccess: () => void;
}

export const AdminLoginModal: React.FC<AdminLoginModalProps> = ({
  isOpen,
  onClose,
  onLoginSuccess,
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

  if (!isOpen) return null;

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
    onClose();
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
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-md p-4">
      <div className="bg-white rounded-3xl max-w-md w-full p-6 shadow-2xl space-y-5 animate-in zoom-in-95 duration-200 border border-stone-200">
        {/* Header */}
        <div className="text-center space-y-1.5">
          <div className="w-12 h-12 rounded-2xl bg-[#0f1c2e] text-amber-300 flex items-center justify-center mx-auto shadow-md">
            <Lock className="w-6 h-6 text-[#c5a059]" />
          </div>
          <h2 className="font-serif text-xl font-bold text-[#0f1c2e]">
            Admin Hub Security Access
          </h2>
          <p className="text-xs text-stone-500">
            Beautiful UAE Home • Operations, Couriers & Inventory
          </p>
        </div>

        {/* Error message */}
        {error && (
          <div className="bg-red-50 text-red-700 text-xs p-3 rounded-xl border border-red-200 font-medium">
            {error}
          </div>
        )}

        {mustChange ? (
          <form onSubmit={handleChangePassword} className="space-y-3.5 text-xs">
            <p className="text-stone-600 leading-relaxed">
              Choose your own admin password to finish signing in: at least 12 characters, with at least 5 different characters.
            </p>
            <div>
              <label htmlFor="admin-new-password" className="block text-stone-800 font-semibold mb-1">New password</label>
              <input
                id="admin-new-password"
                type="password"
                required
                minLength={12}
                maxLength={256}
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl border border-stone-300 bg-white text-stone-900 focus:outline-none focus:ring-2 focus:ring-[#c5a059] text-xs"
              />
            </div>
            <div>
              <label htmlFor="admin-confirm-password" className="block text-stone-800 font-semibold mb-1">Confirm new password</label>
              <input
                id="admin-confirm-password"
                type="password"
                required
                minLength={12}
                maxLength={256}
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl border border-stone-300 bg-white text-stone-900 focus:outline-none focus:ring-2 focus:ring-[#c5a059] text-xs"
              />
            </div>
            <button
              type="submit"
              disabled={busy}
              className="w-full bg-[#0f1c2e] hover:bg-stone-800 disabled:opacity-60 text-white font-bold py-3.5 rounded-xl shadow-lg flex items-center justify-center gap-2 transition-all active:scale-95 text-xs mt-2"
            >
              <Check className="w-4 h-4 text-amber-300" />
              <span>{busy ? 'Saving…' : 'Save Password & Continue'}</span>
            </button>
          </form>
        ) : (
        <form onSubmit={handleLogin} className="space-y-3.5 text-xs">
          <div>
            <label className="block text-stone-800 font-semibold mb-1">
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
              className="w-full px-3.5 py-2.5 rounded-xl border border-stone-300 bg-white text-stone-900 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-[#c5a059] focus:bg-white text-xs"
            />
          </div>

          <div>
            <label className="block text-stone-800 font-semibold mb-1">
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
                className="w-full px-3.5 py-2.5 rounded-xl border border-stone-300 bg-white text-stone-900 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-[#c5a059] focus:bg-white pr-10 text-xs"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                className="absolute right-3 top-2.5 text-stone-400 hover:text-stone-600"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={busy}
            className="w-full bg-[#0f1c2e] hover:bg-stone-800 disabled:opacity-60 text-white font-bold py-3.5 rounded-xl shadow-lg flex items-center justify-center gap-2 transition-all active:scale-95 text-xs mt-2"
          >
            <span>{busy ? 'Checking…' : 'Unlock Admin Portal'}</span>
            <ArrowRight className="w-4 h-4 text-amber-300" />
          </button>
        </form>
        )}

        <div className="bg-stone-50 rounded-2xl p-3 border border-stone-200 text-[11px] text-stone-600 leading-relaxed flex gap-2">
          <ShieldCheck className="w-4 h-4 text-[#c5a059] shrink-0 mt-0.5" />
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
            className="text-stone-400 hover:text-stone-700 text-xs font-semibold"
          >
            Return to Storefront
          </button>
        </div>
      </div>
    </div>
  );
};
