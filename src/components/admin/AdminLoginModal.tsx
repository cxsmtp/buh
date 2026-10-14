'use client';

import React, { useState } from 'react';
import { Lock, Key, ShieldCheck, ArrowRight, Eye, EyeOff, Sparkles, Check } from 'lucide-react';

interface AdminLoginModalProps {
  isOpen: boolean;
  onClose: () => void;
  onLoginSuccess: () => void;
}

export const FIRST_ADMIN_CREDENTIALS = {
  email: 'admin@beautifuluaehome.com',
  password: 'UAEHome2026!#',
};

export const AdminLoginModal: React.FC<AdminLoginModalProps> = ({
  isOpen,
  onClose,
  onLoginSuccess,
}) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [showFirstAdminHelper, setShowFirstAdminHelper] = useState(true);

  if (!isOpen) return null;

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    // Check against default credentials or custom credentials stored in localStorage
    const storedCredsRaw = typeof window !== 'undefined' ? localStorage.getItem('buh_admin_creds') : null;
    const validCreds = storedCredsRaw ? JSON.parse(storedCredsRaw) : FIRST_ADMIN_CREDENTIALS;

    if (
      (email.trim().toLowerCase() === validCreds.email.toLowerCase() || email.trim() === 'admin') &&
      password === validCreds.password
    ) {
      if (typeof window !== 'undefined') {
        localStorage.setItem('buh_admin_auth', 'authenticated');
      }
      onLoginSuccess();
      onClose();
    } else {
      setError('Invalid admin credentials. Please check the email/password or use the First Admin helper below.');
    }
  };

  const handleAutoFillFirstAdmin = () => {
    setEmail(FIRST_ADMIN_CREDENTIALS.email);
    setPassword(FIRST_ADMIN_CREDENTIALS.password);
    setError('');
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

        {/* Login Form */}
        <form onSubmit={handleLogin} className="space-y-3.5 text-xs">
          <div>
            <label className="block text-stone-800 font-semibold mb-1">
              Admin Email or Username
            </label>
            <input
              type="text"
              required
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
                placeholder="••••••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl border border-stone-300 bg-white text-stone-900 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-[#c5a059] focus:bg-white pr-10 text-xs"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-2.5 text-stone-400 hover:text-stone-600"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <button
            type="submit"
            className="w-full bg-[#0f1c2e] hover:bg-stone-800 text-white font-bold py-3.5 rounded-xl shadow-lg flex items-center justify-center gap-2 transition-all active:scale-95 text-xs mt-2"
          >
            <span>Unlock Admin Portal</span>
            <ArrowRight className="w-4 h-4 text-amber-300" />
          </button>
        </form>

        {/* FIRST ADMIN CREDENTIALS HELPER */}
        <div className="bg-gradient-to-br from-amber-50 to-stone-50 rounded-2xl p-4 border border-amber-200/90 text-xs space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="font-bold text-amber-950 flex items-center gap-1.5">
              <Key className="w-4 h-4 text-[#c5a059]" />
              <span>How to Get Access for First Admin</span>
            </span>
            <span className="text-[10px] bg-amber-200/80 text-amber-900 font-bold px-2 py-0.5 rounded-full border border-amber-300">
              Default Owner Key
            </span>
          </div>

          <p className="text-[11px] text-stone-600 leading-relaxed">
            The initial store manager access is pre-configured with secure master credentials below. You can tap the 1-click button to fill them instantly or type them manually:
          </p>

          <div className="bg-white p-3 rounded-xl border border-amber-200 font-mono text-[11px] space-y-1.5 shadow-xs">
            <div className="flex justify-between items-center">
              <span className="text-stone-500 font-sans font-medium">Username / Email:</span>
              <strong className="text-stone-900 font-bold select-all">admin@beautifuluaehome.com</strong>
            </div>
            <div className="flex justify-between items-center pt-1 border-t border-stone-100">
              <span className="text-stone-500 font-sans font-medium">Master Password:</span>
              <strong className="text-[#0f1c2e] font-bold select-all bg-amber-50 px-1.5 py-0.5 rounded border border-amber-200">UAEHome2026!#</strong>
            </div>
          </div>

          <button
            type="button"
            onClick={handleAutoFillFirstAdmin}
            className="w-full py-2.5 bg-amber-100 hover:bg-amber-200 active:scale-98 text-amber-950 border border-amber-300 rounded-xl font-bold text-xs flex items-center justify-center gap-2 transition-all shadow-xs"
          >
            <Sparkles className="w-4 h-4 text-amber-700" />
            <span>1-Click Auto-Fill First Admin Credentials</span>
          </button>
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
