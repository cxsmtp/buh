'use client';

import React, { useState } from 'react';
import { BankTransferDetails, BrandSettings } from '@/types';
import { BankDetailsCard } from './BankDetailsCard';
import { 
  Palette, 
  Sparkles, 
  Upload, 
  Trash2, 
  Plus, 
  RotateCcw, 
  Check, 
  Sliders, 
  Image as ImageIcon, 
  Type, 
  Volume2, 
  CheckCircle2,
  Eye,
  Megaphone
} from 'lucide-react';
import { useAutoSave, type AutoSaveHooks } from './settings/useAutoSave';
import { INITIAL_BRAND_SETTINGS } from '@/data/initialData';

interface AdminBrandingTabProps {
  brandSettings: BrandSettings;
  /** Saves on the server; resolves to an error message, or null when saved. */
  onUpdateBrandSettings: (updated: BrandSettings) => Promise<string | null>;
  bank: BankTransferDetails;
  onUpdateBank: (bank: BankTransferDetails) => Promise<string | null>;
  /** Autosave (Admin Hub): branding and bank details save themselves as you type. */
  auto?: AutoSaveHooks;
}

export const AdminBrandingTab: React.FC<AdminBrandingTabProps> = ({
  brandSettings,
  onUpdateBrandSettings,
  bank,
  onUpdateBank,
  auto,
}) => {
  const [saveError, setSaveError] = useState('');
  // Local editable state
  const [storeName, setStoreName] = useState(brandSettings.storeName);
  const [tagline, setTagline] = useState(brandSettings.tagline);
  const [badgeText, setBadgeText] = useState(brandSettings.badgeText);
  const [logoType, setLogoType] = useState<'text' | 'image'>(brandSettings.logoType);
  const [logoText, setLogoText] = useState(brandSettings.logoText);
  const [logoImageUrl, setLogoImageUrl] = useState(brandSettings.logoImageUrl || '');
  const [accentColor, setAccentColor] = useState(brandSettings.accentColor);
  
  // Marquee editable state
  const [marqueeEnabled, setMarqueeEnabled] = useState(brandSettings.marquee.enabled);
  const [marqueeSpeed, setMarqueeSpeed] = useState(brandSettings.marquee.speedSeconds);
  const [messages, setMessages] = useState<string[]>([...brandSettings.marquee.messages]);
  const [newMessage, setNewMessage] = useState('');

  const [savedSuccess, setSavedSuccess] = useState(false);

  // Quick preset colors
  const colorPresets = [
    { name: 'Artisan Gold', hex: '#c5a059' },
    { name: 'Royal Navy', hex: '#0f1c2e' },
    { name: 'Desert Terracotta', hex: '#b85d43' },
    { name: 'Emerald Oasis', hex: '#10b981' },
    { name: 'Imperial Plum', hex: '#6b21a8' },
  ];

  // Quick preset templates for running marquee
  const presetTemplates = [
    '🌟 Exclusive UAE Edition: Artisanal Handprinted Pure Flax & Giza Linens',
    '⚡ Same-Day Delivery in Dubai & Abu Dhabi for orders before 1:00 PM',
    '🚚 Free UAE Priority Express Delivery on all orders above AED 150',
    '✨ Tailored 40cm Deep Pocket Bed Sheets engineered for UAE Master Beds',
    '💳 Doorstep Cash on Delivery (COD) & Instant Emirates NBD Bank Transfer',
    '🎁 Complimentary Linen Laundry Bag included with every luxury bed set',
  ];

  // Image Upload handler
  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const result = event.target?.result as string;
        setLogoImageUrl(result);
        setLogoType('image');
      };
      reader.readAsDataURL(file);
    }
  };

  // Add new marquee message
  const handleAddMessage = () => {
    if (!newMessage.trim()) return;
    setMessages((prev) => [...prev, newMessage.trim()]);
    setNewMessage('');
  };

  // Remove marquee message
  const handleRemoveMessage = (index: number) => {
    setMessages((prev) => prev.filter((_, i) => i !== index));
  };

  // Edit marquee message in place
  const handleUpdateMessage = (index: number, val: string) => {
    setMessages((prev) => {
      const copy = [...prev];
      copy[index] = val;
      return copy;
    });
  };

  const draft = (): BrandSettings => ({
      storeName: storeName.trim() || 'BEAUTIFUL UAE HOME',
      tagline: tagline.trim() || 'HANDPRINTED & MACHINE BLOCK LINENS • DUBAI',
      badgeText: badgeText.trim() || 'UAE ATELIER',
      logoType,
      logoText: logoText.trim() || 'BU',
      logoImageUrl: logoImageUrl.trim() || undefined,
      accentColor: accentColor || '#c5a059',
      marquee: {
        enabled: marqueeEnabled,
        speedSeconds: Number(marqueeSpeed) || 26,
        messages: messages.filter((m) => m.trim().length > 0),
      },
    });
  const autosave = useAutoSave({ settingsKey: 'brand', value: draft(), enabled: Boolean(auto), ...auto });

  // Save all settings
  const handleSave = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const updated = draft();
    setSaveError('');
    const error = await onUpdateBrandSettings(updated);
    if (error) {
      setSaveError(error);
      return;
    }
    setSavedSuccess(true);
    setTimeout(() => setSavedSuccess(false), 3000);
  };

  // Reset to initial defaults
  const handleResetDefaults = () => {
    if (confirm('Reset branding and marquee to default Beautiful UAE Home artisan configuration?')) {
      setStoreName(INITIAL_BRAND_SETTINGS.storeName);
      setTagline(INITIAL_BRAND_SETTINGS.tagline);
      setBadgeText(INITIAL_BRAND_SETTINGS.badgeText);
      setLogoType(INITIAL_BRAND_SETTINGS.logoType);
      setLogoText(INITIAL_BRAND_SETTINGS.logoText);
      setLogoImageUrl(INITIAL_BRAND_SETTINGS.logoImageUrl || '');
      setAccentColor(INITIAL_BRAND_SETTINGS.accentColor);
      setMarqueeEnabled(INITIAL_BRAND_SETTINGS.marquee.enabled);
      setMarqueeSpeed(INITIAL_BRAND_SETTINGS.marquee.speedSeconds);
      setMessages([...INITIAL_BRAND_SETTINGS.marquee.messages]);
      void onUpdateBrandSettings(INITIAL_BRAND_SETTINGS).then((error) => {
        if (error) setSaveError(error);
        else {
          setSavedSuccess(true);
          setTimeout(() => setSavedSuccess(false), 3000);
        }
      });
    }
  };

  return (
    <div className="space-y-6">
      {/* Top Banner & Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white p-4 rounded-2xl border border-stone-200 shadow-xs">
        <div>
          <div className="flex items-center gap-2">
            <Palette className="w-5 h-5 text-[#c5a059]" />
            <h2 className="font-serif text-lg font-bold text-[#0f1c2e]">
              Store Logo, Branding & Live Marquee
            </h2>
          </div>
          <p className="text-xs text-stone-500 mt-0.5">
            Customize your store identity, brand monogram/logo, and manage the running announcement ticker line.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleResetDefaults}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-stone-600 hover:text-stone-900 bg-stone-100 hover:bg-stone-200 rounded-xl transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Reset Defaults</span>
          </button>

          <button
            type="button"
            onClick={handleSave}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-white bg-[#0f1c2e] hover:bg-stone-800 rounded-xl transition-colors shadow"
          >
            <Check className="w-4 h-4 text-amber-300" />
            <span>Save All Changes</span>
          </button>
        </div>
      </div>

      {/* Success Notification Alert */}
      {savedSuccess && (
        <div className="bg-emerald-50 text-emerald-900 border border-emerald-200 p-3.5 rounded-2xl text-xs flex items-center justify-between animate-in fade-in-50">
          <div className="flex items-center gap-2 font-medium">
            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
            <span>Branding, Logo and Marquee ticker updated and saved successfully!</span>
          </div>
          <span className="text-[10px] bg-emerald-200 text-emerald-900 font-bold px-2 py-0.5 rounded-full">
            Live
          </span>
        </div>
      )}

      {/* LIVE STOREFRONT HEADER PREVIEW */}
      <div className="bg-stone-900 text-white rounded-3xl p-4 sm:p-5 shadow-lg border border-stone-800 space-y-3">
        <div className="flex items-center justify-between border-b border-stone-800 pb-2">
          <span className="text-xs font-bold text-amber-300 uppercase tracking-wider flex items-center gap-1.5">
            <Eye className="w-3.5 h-3.5" />
            <span>Live Storefront Header Preview</span>
          </span>
          <span className="text-[10px] text-stone-400">Updates live as you edit below</span>
        </div>

        {/* Live Running Marquee Bar Preview */}
        {marqueeEnabled && messages.length > 0 && (
          <div className="bg-[#0a121d] rounded-xl overflow-hidden py-1.5 px-3 border border-stone-800 flex items-center text-xs">
            <div className="shrink-0 bg-amber-500 text-stone-950 font-bold px-2 py-0.5 rounded text-[9px] uppercase tracking-wider mr-2">
              LIVE
            </div>
            <div className="overflow-hidden whitespace-nowrap flex-1">
              <div
                className="animate-marquee-runner flex items-center gap-6"
                style={{ animationDuration: `${marqueeSpeed}s` }}
              >
                {[...messages, ...messages].map((msg, i) => (
                  <span key={i} className="inline-flex items-center gap-2 text-stone-300 text-xs shrink-0">
                    <span>{msg}</span>
                    <span className="text-amber-400 opacity-70">•</span>
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Live Header Logo & Title Preview */}
        <div className="bg-white text-stone-900 p-3.5 rounded-2xl flex items-center justify-between shadow-xs">
          <div className="flex items-center gap-3">
            {logoType === 'image' && logoImageUrl ? (
              <img
                src={logoImageUrl}
                alt={storeName}
                className="w-10 h-10 object-contain rounded-xl border border-stone-200 shadow-xs"
              />
            ) : (
              <div 
                className="w-10 h-10 rounded-xl flex items-center justify-center text-white shadow font-serif text-lg font-bold"
                style={{ background: `linear-gradient(135deg, ${accentColor}, #dfc082)` }}
              >
                {logoText || 'BU'}
              </div>
            )}
            <div>
              <div className="font-serif tracking-wide text-base sm:text-lg font-bold text-[#0f1c2e] leading-tight flex items-center gap-2">
                <span>{storeName || 'BEAUTIFUL UAE HOME'}</span>
                {badgeText && (
                  <span className="text-[9px] uppercase font-sans font-semibold tracking-wider px-2 py-0.5 rounded-full bg-amber-100 text-amber-900 border border-amber-300">
                    {badgeText}
                  </span>
                )}
              </div>
              <p className="text-[10px] text-stone-500 tracking-wider font-medium">
                {tagline || 'HANDPRINTED & MACHINE BLOCK LINENS • DUBAI'}
              </p>
            </div>
          </div>

          <div className="text-[11px] font-semibold text-stone-400 hidden sm:block">
            Storefront Header Live Simulation
          </div>
        </div>
      </div>

      {/* EDITING FORMS GRID */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        
        {/* ================= COLUMN 1: LOGO & BRANDING DETAILS ================= */}
        <div className="bg-white rounded-3xl p-5 border border-stone-200 shadow-xs space-y-5">
          <div className="border-b border-stone-100 pb-3">
            <h3 className="font-serif font-bold text-base text-[#0f1c2e] flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-[#c5a059]" />
              <span>1. Logo & Brand Identity</span>
            </h3>
            <p className="text-xs text-stone-500">
              Configure store name, atelier emblem, and artisan brand colors.
            </p>
          </div>

          {/* Logo Type Selection */}
          <div className="space-y-2 text-xs">
            <label className="block text-stone-800 font-semibold">
              Select Logo Format
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setLogoType('text')}
                className={`p-3 rounded-2xl border text-left transition-all flex items-center gap-2.5 ${
                  logoType === 'text'
                    ? 'border-[#0f1c2e] bg-[#0f1c2e] text-white shadow-xs'
                    : 'border-stone-200 bg-white text-stone-700 hover:border-stone-300'
                }`}
              >
                <Type className={`w-4 h-4 ${logoType === 'text' ? 'text-amber-300' : 'text-[#c5a059]'}`} />
                <div>
                  <strong className="block text-xs">Monogram Initials</strong>
                  <span className={`text-[10px] block ${logoType === 'text' ? 'text-stone-300' : 'text-stone-400'}`}>
                    Artisan lettermark
                  </span>
                </div>
              </button>

              <button
                type="button"
                onClick={() => setLogoType('image')}
                className={`p-3 rounded-2xl border text-left transition-all flex items-center gap-2.5 ${
                  logoType === 'image'
                    ? 'border-[#0f1c2e] bg-[#0f1c2e] text-white shadow-xs'
                    : 'border-stone-200 bg-white text-stone-700 hover:border-stone-300'
                }`}
              >
                <ImageIcon className={`w-4 h-4 ${logoType === 'image' ? 'text-amber-300' : 'text-[#c5a059]'}`} />
                <div>
                  <strong className="block text-xs">Custom Graphic Logo</strong>
                  <span className={`text-[10px] block ${logoType === 'image' ? 'text-stone-300' : 'text-stone-400'}`}>
                    Upload image or URL
                  </span>
                </div>
              </button>
            </div>
          </div>

          {/* Monogram or Image Input */}
          {logoType === 'text' ? (
            <div className="space-y-2 text-xs">
              <label className="block text-stone-800 font-semibold">
                Monogram Letters / Initials (Max 3 Characters)
              </label>
              <div className="flex items-center gap-3">
                <input
                  type="text"
                  maxLength={3}
                  value={logoText}
                  onChange={(e) => setLogoText(e.target.value.toUpperCase())}
                  placeholder="BU"
                  className="w-24 px-3.5 py-2 rounded-xl border border-stone-300 bg-white text-stone-900 font-serif font-bold text-base text-center tracking-wider focus:outline-none focus:ring-2 focus:ring-[#c5a059]"
                />
                <div className="text-[11px] text-stone-500">
                  Displayed inside luxury gradient emblem tile.
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-3 text-xs">
              <label className="block text-stone-800 font-semibold">
                Upload Logo Image or Enter Image URL
              </label>
              
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 px-3.5 py-2.5 bg-stone-50 hover:bg-stone-100 border border-stone-300 rounded-xl cursor-pointer text-stone-800 text-xs font-semibold transition-colors">
                  <Upload className="w-4 h-4 text-[#c5a059]" />
                  <span>Upload Logo File</span>
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleImageUpload}
                    className="hidden"
                  />
                </label>
                {logoImageUrl && (
                  <button
                    type="button"
                    onClick={() => setLogoImageUrl('')}
                    className="text-red-600 hover:text-red-700 text-xs font-medium flex items-center gap-1"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Clear</span>
                  </button>
                )}
              </div>

              <div>
                <span className="text-[11px] text-stone-500 block mb-1">Or direct image URL:</span>
                <input
                  type="url"
                  placeholder="https://example.com/logo.png"
                  value={logoImageUrl}
                  onChange={(e) => setLogoImageUrl(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-stone-300 bg-white text-stone-900 placeholder:text-stone-400 text-xs focus:outline-none focus:ring-2 focus:ring-[#c5a059]"
                />
              </div>
            </div>
          )}

          {/* Store Name, Tagline & Badge */}
          <div className="space-y-3.5 text-xs">
            <div>
              <label className="block text-stone-800 font-semibold mb-1">
                Store Brand Name
              </label>
              <input
                type="text"
                value={storeName}
                onChange={(e) => setStoreName(e.target.value)}
                placeholder="BEAUTIFUL UAE HOME"
                className="w-full px-3.5 py-2.5 rounded-xl border border-stone-300 bg-white text-stone-900 font-serif font-bold tracking-wide focus:outline-none focus:ring-2 focus:ring-[#c5a059]"
              />
            </div>

            <div>
              <label className="block text-stone-800 font-semibold mb-1">
                Atelier Badge Label
              </label>
              <input
                type="text"
                value={badgeText}
                onChange={(e) => setBadgeText(e.target.value)}
                placeholder="UAE ATELIER"
                className="w-full px-3.5 py-2.5 rounded-xl border border-stone-300 bg-white text-stone-900 font-sans font-semibold text-xs focus:outline-none focus:ring-2 focus:ring-[#c5a059]"
              />
            </div>

            <div>
              <label className="block text-stone-800 font-semibold mb-1">
                Tagline / Subtitle
              </label>
              <input
                type="text"
                value={tagline}
                onChange={(e) => setTagline(e.target.value)}
                placeholder="HANDPRINTED & MACHINE BLOCK LINENS • DUBAI"
                className="w-full px-3.5 py-2.5 rounded-xl border border-stone-300 bg-white text-stone-900 font-sans text-xs focus:outline-none focus:ring-2 focus:ring-[#c5a059]"
              />
            </div>

            {/* Accent Color Picker */}
            <div>
              <label className="block text-stone-800 font-semibold mb-1.5">
                Primary Brand Accent Theme
              </label>
              <div className="flex flex-wrap items-center gap-2">
                {colorPresets.map((c) => (
                  <button
                    key={c.hex}
                    type="button"
                    onClick={() => setAccentColor(c.hex)}
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border text-[11px] font-semibold transition-all ${
                      accentColor === c.hex
                        ? 'border-stone-900 bg-stone-900 text-white shadow-xs'
                        : 'border-stone-200 bg-stone-50 text-stone-700 hover:border-stone-300'
                    }`}
                  >
                    <span
                      className="w-3.5 h-3.5 rounded-full border border-black/10 shrink-0"
                      style={{ backgroundColor: c.hex }}
                    />
                    <span>{c.name}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* ================= COLUMN 2: RUNNING MARQUEE TICKER MANAGER ================= */}
        <div className="bg-white rounded-3xl p-5 border border-stone-200 shadow-xs space-y-5 flex flex-col">
          <div className="border-b border-stone-100 pb-3 flex items-center justify-between">
            <div>
              <h3 className="font-serif font-bold text-base text-[#0f1c2e] flex items-center gap-2">
                <Megaphone className="w-4 h-4 text-[#c5a059]" />
                <span>2. Live Marquee Announcement Ticker</span>
              </h3>
              <p className="text-xs text-stone-500">
                Manage the continuous running top banner messages and speed.
              </p>
            </div>

            {/* Toggle Marquee Switch */}
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-stone-700">
                {marqueeEnabled ? 'Active' : 'Paused'}
              </span>
              <button
                type="button"
                onClick={() => setMarqueeEnabled(!marqueeEnabled)}
                className={`w-11 h-6 flex items-center rounded-full p-1 transition-colors duration-200 ease-in-out ${
                  marqueeEnabled ? 'bg-emerald-600' : 'bg-stone-300'
                }`}
              >
                <div
                  className={`bg-white w-4 h-4 rounded-full shadow-md transform transition-transform duration-200 ease-in-out ${
                    marqueeEnabled ? 'translate-x-5' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>
          </div>

          {/* Marquee Speed Controls */}
          <div className="space-y-2 text-xs">
            <div className="flex items-center justify-between">
              <label className="font-semibold text-stone-800 flex items-center gap-1.5">
                <Sliders className="w-3.5 h-3.5 text-[#c5a059]" />
                <span>Ticker Scrolling Speed: {marqueeSpeed} seconds</span>
              </label>
              <div className="flex items-center gap-1.5">
                {[
                  { label: 'Fast (16s)', val: 16 },
                  { label: 'Medium (26s)', val: 26 },
                  { label: 'Relaxed (38s)', val: 38 },
                ].map((s) => (
                  <button
                    key={s.val}
                    type="button"
                    onClick={() => setMarqueeSpeed(s.val)}
                    className={`px-2 py-0.5 rounded-lg text-[10px] font-semibold border ${
                      marqueeSpeed === s.val
                        ? 'bg-[#0f1c2e] text-white border-[#0f1c2e]'
                        : 'bg-stone-50 text-stone-600 border-stone-200 hover:bg-stone-100'
                    }`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
            <input
              type="range"
              min={12}
              max={50}
              step={2}
              value={marqueeSpeed}
              onChange={(e) => setMarqueeSpeed(Number(e.target.value))}
              className="w-full accent-[#c5a059] cursor-pointer"
            />
          </div>

          {/* Running Announcements List */}
          <div className="space-y-2.5 flex-1 text-xs">
            <div className="flex items-center justify-between">
              <label className="font-semibold text-stone-800">
                Active Marquee Messages ({messages.length})
              </label>
              <span className="text-[10px] text-stone-400">Repeats continuously in loop</span>
            </div>

            <div className="space-y-2 max-h-56 overflow-y-auto p-1">
              {messages.map((msg, index) => (
                <div
                  key={index}
                  className="flex items-center gap-2 bg-stone-50 p-2 rounded-xl border border-stone-200"
                >
                  <span className="w-5 h-5 rounded-full bg-stone-200 text-stone-600 font-bold text-[10px] flex items-center justify-center shrink-0">
                    {index + 1}
                  </span>
                  <input
                    type="text"
                    value={msg}
                    onChange={(e) => handleUpdateMessage(index, e.target.value)}
                    className="flex-1 bg-white px-2.5 py-1.5 rounded-lg border border-stone-300 text-stone-900 text-xs focus:outline-none focus:ring-1 focus:ring-[#c5a059]"
                  />
                  <button
                    type="button"
                    onClick={() => handleRemoveMessage(index)}
                    className="p-1.5 text-stone-400 hover:text-red-600 rounded-lg hover:bg-stone-200 transition-colors shrink-0"
                    title="Remove message"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>

            {/* Add New Message Bar */}
            <div className="flex gap-2 pt-1">
              <input
                type="text"
                placeholder="Type new running announcement (e.g. 🌟 Weekend Promo: 15% off)..."
                value={newMessage}
                onChange={(e) => setNewMessage(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleAddMessage()}
                className="flex-1 px-3 py-2 rounded-xl border border-stone-300 bg-white text-stone-900 placeholder:text-stone-400 text-xs focus:outline-none focus:ring-2 focus:ring-[#c5a059]"
              />
              <button
                type="button"
                onClick={handleAddMessage}
                className="px-3.5 py-2 bg-[#0f1c2e] hover:bg-stone-800 text-white font-bold rounded-xl text-xs flex items-center gap-1 transition-colors shrink-0"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add</span>
              </button>
            </div>

            {/* Quick Template Suggestions */}
            <div className="pt-2">
              <span className="text-[10px] text-stone-500 font-semibold uppercase tracking-wider block mb-1.5">
                1-Click Preset Announcement Ideas:
              </span>
              <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
                {presetTemplates.map((t, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setMessages((prev) => [...prev, t])}
                    className="text-[10px] bg-amber-50 hover:bg-amber-100 text-amber-900 border border-amber-200 px-2 py-1 rounded-lg text-left truncate max-w-xs transition-colors flex items-center gap-1"
                  >
                    <Plus className="w-2.5 h-2.5 text-amber-700 shrink-0" />
                    <span className="truncate">{t}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Bottom Save Action */}
          <div className="pt-2 border-t border-stone-100 space-y-2">
            {saveError && (
              <p role="alert" className="text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs font-medium">
                {saveError}
              </p>
            )}
            <button
              type="button"
              onClick={handleSave}
              className="w-full py-3 bg-[#0f1c2e] hover:bg-stone-800 active:scale-98 text-white font-bold text-xs rounded-xl shadow-md flex items-center justify-center gap-2 transition-all"
            >
              <Check className="w-4 h-4 text-amber-300" />
              <span>Apply & Save Store Branding & Marquee</span>
            </button>
          {auto && autosave.bar}
          </div>
        </div>

      </div>

      <BankDetailsCard bank={bank} onSave={onUpdateBank} auto={auto} />
    </div>
  );
};
