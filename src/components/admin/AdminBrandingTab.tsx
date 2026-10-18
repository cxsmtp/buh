'use client';

import React, { useState } from 'react';
import { BankTransferDetails, BrandSettings } from '@/types';
import { BankDetailsCard } from './BankDetailsCard';
import { 
  Palette, 
  Sparkles, 
  Upload, 
  Trash2,
  RotateCcw, 
  Check, 
  Image as ImageIcon, 
  Type, 
  CheckCircle2,
  Eye,
} from 'lucide-react';
import { useAutoSave, type AutoSaveHooks } from './settings/useAutoSave';
import { INITIAL_BRAND_SETTINGS } from '@/data/initialData';
import { PALETTE } from '@/lib/design/tokens';

/** Branding without the announcement bar (that is edited in Settings → Store & contact). */
export type BrandDraft = Omit<BrandSettings, 'marquee'>;

interface AdminBrandingTabProps {
  brandSettings: BrandSettings;
  /** Saves on the server; resolves to an error message, or null when saved. */
  onUpdateBrandSettings: (updated: BrandDraft) => Promise<string | null>;
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
  
  const [savedSuccess, setSavedSuccess] = useState(false);

  // Quick preset colors
  // The logo's letters sit on one of the shop's own tones (the shop keeps one palette).
  const colorPresets = [
    { name: 'Champagne gold', hex: PALETTE.gold },
    { name: 'Antique gold', hex: PALETTE['gold-deep'] },
    { name: 'Ink', hex: PALETTE.ink },
    { name: 'Dusty rose', hex: PALETTE['rose-deep'] },
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

  // A new logo is uploaded once: after that the stored address is sent, not the picture again.
  const [sentLogo, setSentLogo] = useState('');
  const draft = (): BrandDraft => ({
      storeName: storeName.trim() || 'BEAUTIFUL UAE HOME',
      tagline: tagline.trim() || 'HANDPRINTED & MACHINE BLOCK LINENS • DUBAI',
      badgeText: badgeText.trim() || 'UAE ATELIER',
      logoType,
      logoText: logoText.trim() || 'BU',
      logoImageUrl: logoImageUrl.trim() || undefined,
      accentColor: accentColor || PALETTE.gold,
    });
  const current = draft();
  const autosave = useAutoSave({
    settingsKey: 'brand',
    value: current.logoImageUrl && current.logoImageUrl === sentLogo ? { ...current, logoImageUrl: brandSettings.logoImageUrl } : current,
    enabled: Boolean(auto),
    ...auto,
    onSent: (sent) => {
      if (sent.logoImageUrl?.startsWith('data:')) setSentLogo(sent.logoImageUrl);
    },
  });

  // Save all settings
  const handleSave = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    autosave.cancel();
    const updated = draft();
    if (updated.logoImageUrl?.startsWith('data:')) setSentLogo(updated.logoImageUrl);
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
    if (confirm('Reset the logo, name and tagline to the Beautiful UAE Home defaults?')) {
      setStoreName(INITIAL_BRAND_SETTINGS.storeName);
      setTagline(INITIAL_BRAND_SETTINGS.tagline);
      setBadgeText(INITIAL_BRAND_SETTINGS.badgeText);
      setLogoType(INITIAL_BRAND_SETTINGS.logoType);
      setLogoText(INITIAL_BRAND_SETTINGS.logoText);
      setLogoImageUrl(INITIAL_BRAND_SETTINGS.logoImageUrl || '');
      setAccentColor(INITIAL_BRAND_SETTINGS.accentColor);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { marquee, ...defaults } = INITIAL_BRAND_SETTINGS;
      void onUpdateBrandSettings(defaults).then((error) => {
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
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-surface p-4 rounded-2xl border border-line shadow-xs">
        <div>
          <div className="flex items-center gap-2">
            <Palette className="w-5 h-5 text-gold" />
            <h2 className="font-serif text-lg font-bold text-ink">
              Logo and branding
            </h2>
          </div>
          <p className="text-xs text-ink-muted mt-0.5">
            Your shop’s name, tagline and logo.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleResetDefaults}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-ink-soft hover:text-ink bg-sand hover:bg-sand-deep rounded-xl transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Reset Defaults</span>
          </button>

          <button
            type="button"
            onClick={handleSave}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-paper bg-ink hover:bg-ink rounded-xl transition-colors shadow"
          >
            <Check className="w-4 h-4 text-gold-light" />
            <span>Save All Changes</span>
          </button>
        </div>
      </div>

      {/* Success Notification Alert */}
      {savedSuccess && (
        <div className="bg-success-soft text-success border border-success-line p-3.5 rounded-2xl text-xs flex items-center justify-between animate-in fade-in-50">
          <div className="flex items-center gap-2 font-medium">
            <CheckCircle2 className="w-4 h-4 text-success" />
            <span>Branding saved.</span>
          </div>
          <span className="text-[10px] bg-success-line text-success font-bold px-2 py-0.5 rounded-full">
            Live
          </span>
        </div>
      )}

      {/* LIVE STOREFRONT HEADER PREVIEW */}
      <div className="bg-ink text-paper rounded-3xl p-4 sm:p-5 shadow-lg border border-ink space-y-3">
        <div className="flex items-center justify-between border-b border-ink pb-2">
          <span className="text-xs font-bold text-gold-light uppercase tracking-wider flex items-center gap-1.5">
            <Eye className="w-3.5 h-3.5" />
            <span>Live Storefront Header Preview</span>
          </span>
          <span className="text-[10px] text-sand">Updates live as you edit below</span>
        </div>

        {/* Live Header Logo & Title Preview */}
        <div className="bg-surface text-ink p-3.5 rounded-2xl flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            {logoType === 'image' && logoImageUrl ? (
              <img
                src={logoImageUrl}
                alt={storeName}
                className="w-10 h-10 object-contain rounded-xl border border-line shadow-xs"
              />
            ) : (
              <div 
                className="w-10 h-10 rounded-xl flex items-center justify-center text-white shadow font-serif text-lg font-bold"
                style={{ background: `linear-gradient(135deg, ${accentColor}, ${PALETTE['gold-light']})` }}
              >
                {logoText || 'BU'}
              </div>
            )}
            <div className="min-w-0">
              <div className="font-serif tracking-wide text-base sm:text-lg text-ink leading-tight flex flex-wrap items-center gap-2">
                <span className="break-anywhere">{storeName || 'BEAUTIFUL UAE HOME'}</span>
                {badgeText && (
                  <span className="text-[9px] uppercase font-sans font-semibold tracking-wider px-2 py-0.5 rounded-full bg-warning-soft text-warning border border-warning-line">
                    {badgeText}
                  </span>
                )}
              </div>
              <p className="text-[10px] text-ink-muted tracking-wider font-medium">
                {tagline || 'HANDPRINTED & MACHINE BLOCK LINENS • DUBAI'}
              </p>
            </div>
          </div>

          <div className="text-[11px] font-semibold text-ink-muted hidden sm:block">
            Storefront Header Live Simulation
          </div>
        </div>
      </div>

      {/* EDITING FORMS GRID */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        
        {/* ================= COLUMN 1: LOGO & BRANDING DETAILS ================= */}
        <div className="bg-surface rounded-3xl p-5 border border-line shadow-xs space-y-5">
          <div className="border-b border-line pb-3">
            <h3 className="font-serif font-bold text-base text-ink flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-gold" />
              <span>1. Logo & Brand Identity</span>
            </h3>
            <p className="text-xs text-ink-muted">
              Configure store name, atelier emblem, and artisan brand colors.
            </p>
          </div>

          {/* Logo Type Selection */}
          <div className="space-y-2 text-xs">
            <label className="block text-ink font-semibold">
              Select Logo Format
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setLogoType('text')}
                className={`p-3 rounded-2xl border text-left transition-all flex items-center gap-2.5 ${
                  logoType === 'text'
                    ? 'border-ink bg-ink text-paper shadow-xs'
                    : 'border-line bg-surface text-ink-soft hover:border-line-strong'
                }`}
              >
                <Type className={`w-4 h-4 ${logoType === 'text' ? 'text-gold-light' : 'text-gold'}`} />
                <div>
                  <strong className="block text-xs">Monogram Initials</strong>
                  <span className={`text-[10px] block ${logoType === 'text' ? 'text-sand' : 'text-ink-muted'}`}>
                    Artisan lettermark
                  </span>
                </div>
              </button>

              <button
                type="button"
                onClick={() => setLogoType('image')}
                className={`p-3 rounded-2xl border text-left transition-all flex items-center gap-2.5 ${
                  logoType === 'image'
                    ? 'border-ink bg-ink text-paper shadow-xs'
                    : 'border-line bg-surface text-ink-soft hover:border-line-strong'
                }`}
              >
                <ImageIcon className={`w-4 h-4 ${logoType === 'image' ? 'text-gold-light' : 'text-gold'}`} />
                <div>
                  <strong className="block text-xs">Custom Graphic Logo</strong>
                  <span className={`text-[10px] block ${logoType === 'image' ? 'text-sand' : 'text-ink-muted'}`}>
                    Upload image or URL
                  </span>
                </div>
              </button>
            </div>
          </div>

          {/* Monogram or Image Input */}
          {logoType === 'text' ? (
            <div className="space-y-2 text-xs">
              <label className="block text-ink font-semibold">
                Monogram Letters / Initials (Max 3 Characters)
              </label>
              <div className="flex items-center gap-3">
                <input
                  type="text"
                  maxLength={3}
                  value={logoText}
                  onChange={(e) => setLogoText(e.target.value.toUpperCase())}
                  placeholder="BU"
                  className="w-24 px-3.5 py-2 rounded-xl border border-line-strong bg-surface text-ink font-serif font-bold text-base text-center tracking-wider focus:outline-none focus:ring-2 focus:ring-gold"
                />
                <div className="text-[11px] text-ink-muted">
                  Displayed inside luxury gradient emblem tile.
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-3 text-xs">
              <label className="block text-ink font-semibold">
                Upload Logo Image or Enter Image URL
              </label>
              
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 px-3.5 py-2.5 bg-ivory hover:bg-sand border border-line-strong rounded-xl cursor-pointer text-ink text-xs font-semibold transition-colors">
                  <Upload className="w-4 h-4 text-gold" />
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
                    className="text-danger hover:text-danger text-xs font-medium flex items-center gap-1"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Clear</span>
                  </button>
                )}
              </div>

              <div>
                <span className="text-[11px] text-ink-muted block mb-1">Or direct image URL:</span>
                <input
                  type="url"
                  placeholder="https://example.com/logo.png"
                  value={logoImageUrl}
                  onChange={(e) => setLogoImageUrl(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-line-strong bg-surface text-ink placeholder:text-ink-muted text-xs focus:outline-none focus:ring-2 focus:ring-gold"
                />
              </div>
            </div>
          )}

          {/* Store Name, Tagline & Badge */}
          <div className="space-y-3.5 text-xs">
            <div>
              <label className="block text-ink font-semibold mb-1">
                Store Brand Name
              </label>
              <input
                type="text"
                value={storeName}
                onChange={(e) => setStoreName(e.target.value)}
                placeholder="BEAUTIFUL UAE HOME"
                className="w-full px-3.5 py-2.5 rounded-xl border border-line-strong bg-surface text-ink font-serif font-bold tracking-wide focus:outline-none focus:ring-2 focus:ring-gold"
              />
            </div>

            <div>
              <label className="block text-ink font-semibold mb-1">
                Atelier Badge Label
              </label>
              <input
                type="text"
                value={badgeText}
                onChange={(e) => setBadgeText(e.target.value)}
                placeholder="UAE ATELIER"
                className="w-full px-3.5 py-2.5 rounded-xl border border-line-strong bg-surface text-ink font-sans font-semibold text-xs focus:outline-none focus:ring-2 focus:ring-gold"
              />
            </div>

            <div>
              <label className="block text-ink font-semibold mb-1">
                Tagline / Subtitle
              </label>
              <input
                type="text"
                value={tagline}
                onChange={(e) => setTagline(e.target.value)}
                placeholder="HANDPRINTED & MACHINE BLOCK LINENS • DUBAI"
                className="w-full px-3.5 py-2.5 rounded-xl border border-line-strong bg-surface text-ink font-sans text-xs focus:outline-none focus:ring-2 focus:ring-gold"
              />
            </div>

            {/* Accent Color Picker */}
            <div>
              <label className="block text-ink font-semibold mb-1.5">
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
                        ? 'border-ink bg-ink text-paper shadow-xs'
                        : 'border-line bg-ivory text-ink-soft hover:border-line-strong'
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

        <div className="bg-surface rounded-3xl p-5 border border-line space-y-3 text-xs self-start">
          <p className="text-ink-soft">
            The announcement bar at the top of the shop is in <strong className="text-ink">Settings → Store &amp; contact</strong>.
          </p>
          {saveError && (
            <p role="alert" className="text-danger bg-danger-soft border border-danger-line rounded-lg px-3 py-2 text-xs font-medium">
              {saveError}
            </p>
          )}
          <button
            type="button"
            onClick={handleSave}
            className="w-full py-3 bg-ink hover:bg-ink-2 text-paper font-semibold text-xs rounded-xl flex items-center justify-center gap-2 transition-colors"
          >
            <Check className="w-4 h-4 text-gold-light" />
            <span>Save branding</span>
          </button>
          {auto && autosave.bar}
        </div>
      </div>

      <BankDetailsCard bank={bank} onSave={onUpdateBank} auto={auto} />
    </div>
  );
};
