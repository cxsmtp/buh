'use client';

import React, { useState } from 'react';
import { Product, BedProfileMeasurement, BedSizeProfileId } from '@/types';
import { DEFAULT_BED_PROFILES, ALL_BED_PROFILES_LIST } from '@/data/bedProfiles';
import { AI_STAGING_PRESETS, transformProductImage, AiStagingPreset } from '@/lib/aiImageTransform';
import { 
  Plus, 
  Camera, 
  Sparkles, 
  Layers, 
  Ruler, 
  Check, 
  Upload, 
  Trash2, 
  Edit3, 
  Package, 
  CheckCircle2, 
  ArrowRight,
  Sliders,
  Image as ImageIcon
} from 'lucide-react';

interface AdminInventoryTabProps {
  products: Product[];
  onAddProduct: (product: Product) => void;
  onUpdateProduct: (product: Product) => void;
}

export const AdminInventoryTab: React.FC<AdminInventoryTabProps> = ({
  products,
  onAddProduct,
}) => {
  const [isAdding, setIsAdding] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  // Add Product Form State
  const [title, setTitle] = useState('');
  const [price, setPrice] = useState<number>(349);
  const [compareAtPrice, setCompareAtPrice] = useState<number>(450);
  const [material, setMaterial] = useState('100% Giza Egyptian Cotton');
  const [threadCount, setThreadCount] = useState<number>(800);
  const [stockCount, setStockCount] = useState<number>(30);
  const [category, setCategory] = useState<Product['category']>('bedsheets');
  const [colorsText, setColorsText] = useState('Pearl White, Desert Sand, Royal Navy');

  // Images & AI Staging
  const [rawPhotoUrl, setRawPhotoUrl] = useState<string | null>(null);
  const [aiTransformedUrl, setAiTransformedUrl] = useState<string | null>(null);
  const [selectedPresetId, setSelectedPresetId] = useState<string>('dubai-luxury-master');
  const [isTransforming, setIsTransforming] = useState<boolean>(false);
  const [aiPromptNotes, setAiPromptNotes] = useState<string>('');
  const [sliderPos, setSliderPos] = useState<number>(50);

  // Smart Profiles Selected
  const [selectedProfileIds, setSelectedProfileIds] = useState<BedSizeProfileId[]>([
    'single',
    'double',
    'queen',
    'king',
    'super-king',
  ]);
  const [customProfiles, setCustomProfiles] = useState<Record<BedSizeProfileId, BedProfileMeasurement>>({
    ...DEFAULT_BED_PROFILES,
  });

  // Handle Photo Capture from Mobile Camera or Upload
  const handlePhotoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const dataUrl = event.target?.result as string;
        setRawPhotoUrl(dataUrl);
        // Reset transformed image so user can trigger AI
        setAiTransformedUrl(null);
      };
      reader.readAsDataURL(file);
    }
  };

  // Handle Custom Transformed Image Upload
  const handleCustomAiUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        setAiTransformedUrl(event.target?.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  // Run AI Transformation
  const handleTriggerAiTransform = async () => {
    if (!rawPhotoUrl) return;
    setIsTransforming(true);

    try {
      const result = await transformProductImage(rawPhotoUrl, selectedPresetId);
      setAiTransformedUrl(result.transformedUrl);
      setAiPromptNotes(result.transformationNotes);
    } catch (err) {
      console.error('AI Transform failed:', err);
      alert('AI image staging encountered an error. Using preset template.');
    } finally {
      setIsTransforming(false);
    }
  };

  // Toggle Bed Profile
  const toggleProfile = (id: BedSizeProfileId) => {
    if (selectedProfileIds.includes(id)) {
      if (selectedProfileIds.length === 1) {
        alert('You must offer at least one bed size profile.');
        return;
      }
      setSelectedProfileIds(selectedProfileIds.filter((p) => p !== id));
    } else {
      setSelectedProfileIds([...selectedProfileIds, id]);
    }
  };

  // Save Product to Inventory
  const handleSaveProduct = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title) {
      alert('Please provide a title for the bedding set.');
      return;
    }

    const featuredImg = aiTransformedUrl || rawPhotoUrl || 'https://images.unsplash.com/photo-1631049307264-da0ec9d70304?auto=format&fit=crop&w=1200&q=80';

    const colorItems = colorsText.split(',').map((c) => ({
      name: c.trim(),
      hex: c.toLowerCase().includes('white') ? '#FFFFFF' : c.toLowerCase().includes('sand') ? '#E6DCB8' : '#2B2B2B',
    }));

    const finalProfiles = selectedProfileIds.map((id) => customProfiles[id]);

    const newProd: Product = {
      id: `prod-${Date.now()}`,
      title,
      slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      description: `${title}. Made of ${material} with ${threadCount} thread count. Premium bed sheet set tailored for UAE deep mattresses.`,
      shortDescription: `${material} • ${threadCount} TC • Silky Sateen Finish • Deep Pocket Fit`,
      category,
      price,
      compareAtPrice,
      material,
      threadCount,
      weave: 'Sateen',
      colors: colorItems.length > 0 ? colorItems : [{ name: 'Standard White', hex: '#FFFFFF' }],
      featuredImage: featuredImg,
      galleryImages: [featuredImg, rawPhotoUrl || featuredImg].filter(Boolean),
      rawOriginalImage: rawPhotoUrl || undefined,
      aiTransformedImage: aiTransformedUrl || undefined,
      isAiEnhanced: Boolean(aiTransformedUrl),
      stockCount,
      isFeatured: true,
      isNewArrival: true,
      rating: 5.0,
      reviewsCount: 1,
      profiles: finalProfiles,
      defaultProfileId: selectedProfileIds.includes('king') ? 'king' : selectedProfileIds[0],
      createdAt: new Date().toISOString(),
    };

    onAddProduct(newProd);
    setIsAdding(false);
    
    // Reset Form
    setTitle('');
    setRawPhotoUrl(null);
    setAiTransformedUrl(null);
  };

  const filteredProducts = products.filter((p) =>
    p.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
    p.material.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="space-y-4">
      {/* Top Action Bar */}
      <div className="flex items-center justify-between gap-2">
        <div className="relative flex-1">
          <input
            type="text"
            placeholder="Search inventory..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full px-3 py-2 text-xs rounded-xl border border-stone-300 bg-white"
          />
        </div>

        <button
          onClick={() => setIsAdding(!isAdding)}
          className="flex items-center gap-1.5 bg-[#0f1c2e] hover:bg-stone-800 text-white font-bold text-xs px-3.5 py-2.5 rounded-xl transition-all shadow shrink-0"
        >
          {isAdding ? (
            <span>Close Form</span>
          ) : (
            <>
              <Plus className="w-4 h-4 text-amber-300" />
              <span>Add Bedding (+ AI Photo)</span>
            </>
          )}
        </button>
      </div>

      {/* MOBILE ADD PRODUCT FORM WITH CAMERA & AI TRANSFORMATION */}
      {isAdding && (
        <form
          onSubmit={handleSaveProduct}
          className="bg-white rounded-3xl p-4 sm:p-6 border border-stone-200 shadow-xl space-y-5 animate-in slide-in-from-top-4 duration-200"
        >
          <div className="flex items-center justify-between border-b border-stone-200 pb-3">
            <div>
              <h3 className="font-serif font-bold text-base text-[#0f1c2e] flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-[#c5a059]" />
                <span>Add New Bed Sheet Inventory</span>
              </h3>
              <p className="text-xs text-stone-500">
                Snap photo from camera → AI enhances to luxury bedroom → Select bed size measurements
              </p>
            </div>
            <button
              type="button"
              onClick={() => setIsAdding(false)}
              className="text-xs font-semibold text-stone-400 hover:text-stone-700"
            >
              ✕
            </button>
          </div>

          {/* STEP 1: MOBILE CAMERA SNAP & AI STAGING STUDIO */}
          <div className="space-y-3 bg-gradient-to-br from-amber-50/40 via-stone-50 to-amber-50/20 p-4 rounded-2xl border border-amber-200/60">
            <div className="flex items-center justify-between">
              <span className="text-xs font-black uppercase tracking-wider text-stone-900 flex items-center gap-1.5">
                <Camera className="w-4 h-4 text-[#c5a059]" />
                <span>Step 1: Snap Bed Sheet & AI Transformation</span>
              </span>
              <span className="text-[10px] bg-amber-200 text-amber-900 font-bold px-2 py-0.5 rounded-full">
                AI Staging Engine
              </span>
            </div>

            {/* Camera Capture Controls */}
            {!rawPhotoUrl ? (
              <div className="border-2 border-dashed border-stone-300 rounded-2xl p-6 text-center space-y-3 bg-white">
                <div className="w-12 h-12 rounded-full bg-amber-100 text-amber-800 flex items-center justify-center mx-auto">
                  <Camera className="w-6 h-6" />
                </div>
                <div>
                  <strong className="text-xs text-stone-800 block">Take Photo with Phone Camera</strong>
                  <span className="text-[11px] text-stone-500 block mt-0.5">
                    Take a simple photo of the folded bed sheet or flatbed sample
                  </span>
                </div>

                <div className="flex items-center justify-center gap-2 pt-1">
                  <label className="bg-[#0f1c2e] hover:bg-stone-800 text-white font-bold text-xs px-4 py-2.5 rounded-xl cursor-pointer flex items-center gap-2 shadow transition-all">
                    <Camera className="w-4 h-4 text-amber-300" />
                    <span>Open Camera / Upload</span>
                    <input
                      type="file"
                      accept="image/*"
                      capture="environment"
                      onChange={handlePhotoUpload}
                      className="hidden"
                    />
                  </label>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {/* Visual Preview: Clean Beautiful Picture in One Go */}
                <div className="relative aspect-[16/10] bg-stone-900 rounded-2xl overflow-hidden select-none border border-stone-800 shadow-md group">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={aiTransformedUrl || rawPhotoUrl}
                    alt="Luxury Staged Bedding"
                    className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-102"
                  />

                  <div className="absolute top-2.5 left-2.5 bg-[#0f1c2e]/90 text-amber-300 text-[10px] font-bold px-2.5 py-1 rounded-full border border-amber-400/40 flex items-center gap-1.5 shadow">
                    <Sparkles className="w-3.5 h-3.5 text-[#c5a059]" />
                    <span>{aiTransformedUrl ? 'AI Transformed Luxury Bedroom' : 'Photo Loaded — Ready to Transform'}</span>
                  </div>

                  {aiTransformedUrl && (
                    <div className="absolute bottom-2.5 right-2.5 bg-emerald-600/90 text-white text-[10px] font-bold px-2.5 py-1 rounded-lg flex items-center gap-1 shadow">
                      <Check className="w-3 h-3" />
                      <span>Transformed in One Go</span>
                    </div>
                  )}
                </div>

                {/* AI Preset Selection Pills */}
                <div className="space-y-1.5">
                  <label className="text-[11px] font-bold text-stone-700 block">
                    Choose AI Staging Architecture:
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    {AI_STAGING_PRESETS.map((preset) => {
                      const isSelected = selectedPresetId === preset.id;
                      return (
                        <button
                          key={preset.id}
                          type="button"
                          onClick={() => setSelectedPresetId(preset.id)}
                          className={`p-2 rounded-xl text-left border transition-all text-xs ${
                            isSelected
                              ? 'border-[#0f1c2e] bg-[#0f1c2e] text-white'
                              : 'border-stone-200 bg-white text-stone-700 hover:border-stone-300'
                          }`}
                        >
                          <strong className="block text-[11px] leading-tight truncate">
                            {preset.name}
                          </strong>
                          <span className={`text-[9px] block ${isSelected ? 'text-amber-200' : 'text-stone-500'}`}>
                            {preset.tagline}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Action Buttons for AI */}
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <button
                    type="button"
                    disabled={isTransforming}
                    onClick={handleTriggerAiTransform}
                    className="flex-1 bg-gradient-to-r from-[#c5a059] to-[#dfc082] hover:brightness-105 active:scale-95 text-[#0f1c2e] font-bold text-xs py-2.5 px-4 rounded-xl shadow flex items-center justify-center gap-2 transition-all disabled:opacity-50"
                  >
                    <Sparkles className="w-4 h-4" />
                    <span>{isTransforming ? 'Transforming via AI...' : 'Transform into Luxury Bedroom'}</span>
                  </button>

                  <label className="bg-white border border-stone-300 hover:bg-stone-50 text-stone-700 font-semibold text-xs px-3 py-2.5 rounded-xl cursor-pointer flex items-center gap-1.5 transition-colors">
                    <Upload className="w-3.5 h-3.5 text-[#c5a059]" />
                    <span>Upload Custom Staged</span>
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handleCustomAiUpload}
                      className="hidden"
                    />
                  </label>

                  <button
                    type="button"
                    onClick={() => {
                      setRawPhotoUrl(null);
                      setAiTransformedUrl(null);
                    }}
                    className="text-stone-400 hover:text-red-600 p-2"
                    title="Retake photo"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* STEP 2: SMART BED PROFILE DIMENSION PRESETS (Requested by user) */}
          <div className="space-y-3 bg-stone-50 p-4 rounded-2xl border border-stone-200">
            <div className="flex items-center justify-between">
              <span className="text-xs font-black uppercase tracking-wider text-stone-900 flex items-center gap-1.5">
                <Ruler className="w-4 h-4 text-[#c5a059]" />
                <span>Step 2: Bed Size Dimension Profiles (Shown to Customers)</span>
              </span>
              <span className="text-[10px] text-stone-500 font-medium">
                Auto-fills UAE measurements
              </span>
            </div>

            {/* Checkboxes for available sizes */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              {(Object.keys(DEFAULT_BED_PROFILES) as BedSizeProfileId[])
                .filter((id) => id !== 'custom')
                .map((id) => {
                  const profile = customProfiles[id];
                  const isChecked = selectedProfileIds.includes(id);
                  return (
                    <div
                      key={id}
                      onClick={() => toggleProfile(id)}
                      className={`p-2.5 rounded-xl border cursor-pointer transition-all ${
                        isChecked
                          ? 'border-[#0f1c2e] bg-[#0f1c2e] text-white shadow-sm'
                          : 'border-stone-200 bg-white text-stone-600'
                      }`}
                    >
                      <div className="flex items-center justify-between text-xs font-bold">
                        <span>{profile.name.split(' ')[0]}</span>
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => {}}
                          className="rounded text-amber-500"
                        />
                      </div>
                      <span className={`text-[10px] block mt-0.5 truncate ${isChecked ? 'text-amber-200' : 'text-stone-500'}`}>
                        {profile.mattressSize.split('(')[0]}
                      </span>
                    </div>
                  );
                })}
            </div>

            {/* Live Measurements Preview for Shoppers */}
            <div className="bg-white rounded-xl p-3 border border-stone-200 space-y-2 text-xs">
              <span className="text-[11px] font-bold text-stone-800 block">
                Measurements preview for selected profiles:
              </span>
              <div className="space-y-1.5">
                {selectedProfileIds.map((id) => {
                  const p = customProfiles[id];
                  return (
                    <div key={id} className="flex items-center justify-between text-[11px] text-stone-600 border-b border-stone-100 pb-1">
                      <strong className="text-stone-900">{p.name}:</strong>
                      <span>Fitted: {p.fittedSheet} • Flat: {p.flatSheet} • {p.pillowcases}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* STEP 3: PRODUCT SPECS, PRICING & STOCK */}
          <div className="space-y-3">
            <span className="text-xs font-black uppercase tracking-wider text-stone-900 block border-b border-stone-100 pb-1">
              Step 3: Title, Pricing & Fabric Specs
            </span>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div className="sm:col-span-2">
                <label className="block text-stone-700 font-semibold mb-1">
                  Product Name / Title <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Royal Giza 800TC Sateen Bed Sheet Set"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs focus:ring-2 focus:ring-[#c5a059]"
                />
              </div>

              <div>
                <label className="block text-stone-700 font-semibold mb-1">
                  Base Price (AED) <span className="text-red-500">*</span>
                </label>
                <input
                  type="number"
                  required
                  value={price}
                  onChange={(e) => setPrice(Number(e.target.value))}
                  className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs focus:ring-2 focus:ring-[#c5a059]"
                />
              </div>

              <div>
                <label className="block text-stone-700 font-semibold mb-1">
                  Compare at Price (AED)
                </label>
                <input
                  type="number"
                  value={compareAtPrice}
                  onChange={(e) => setCompareAtPrice(Number(e.target.value))}
                  className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs focus:ring-2 focus:ring-[#c5a059]"
                />
              </div>

              <div>
                <label className="block text-stone-700 font-semibold mb-1">
                  Material & Fabric
                </label>
                <input
                  type="text"
                  value={material}
                  onChange={(e) => setMaterial(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs focus:ring-2 focus:ring-[#c5a059]"
                />
              </div>

              <div>
                <label className="block text-stone-700 font-semibold mb-1">
                  Thread Count (TC)
                </label>
                <input
                  type="number"
                  value={threadCount}
                  onChange={(e) => setThreadCount(Number(e.target.value))}
                  className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs focus:ring-2 focus:ring-[#c5a059]"
                />
              </div>

              <div>
                <label className="block text-stone-700 font-semibold mb-1">
                  Initial Stock Count
                </label>
                <input
                  type="number"
                  value={stockCount}
                  onChange={(e) => setStockCount(Number(e.target.value))}
                  className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs focus:ring-2 focus:ring-[#c5a059]"
                />
              </div>

              <div>
                <label className="block text-stone-700 font-semibold mb-1">
                  Color Variants (Comma Separated)
                </label>
                <input
                  type="text"
                  value={colorsText}
                  onChange={(e) => setColorsText(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-stone-300 text-xs focus:ring-2 focus:ring-[#c5a059]"
                />
              </div>
            </div>
          </div>

          {/* Publish Action */}
          <div className="pt-2">
            <button
              type="submit"
              className="w-full bg-[#0f1c2e] hover:bg-stone-800 text-white font-bold text-sm py-4 rounded-xl shadow-xl flex items-center justify-center gap-2 transition-all active:scale-95"
            >
              <CheckCircle2 className="w-5 h-5 text-amber-300" />
              <span>Save & Publish to Customer Storefront</span>
            </button>
          </div>
        </form>
      )}

      {/* INVENTORY LIST */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {filteredProducts.map((p) => (
          <div
            key={p.id}
            className="bg-white rounded-2xl p-3 border border-stone-200 flex gap-3 shadow-sm hover:border-stone-300"
          >
            {/* Product Image */}
            <div className="w-24 h-24 rounded-xl overflow-hidden bg-stone-100 shrink-0 relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={p.featuredImage}
                alt={p.title}
                className="w-full h-full object-cover"
              />
              {p.isAiEnhanced && (
                <span className="absolute bottom-1 right-1 bg-[#0f1c2e] text-amber-300 text-[8px] font-bold px-1.5 py-0.5 rounded shadow">
                  AI Staged
                </span>
              )}
            </div>

            {/* Info */}
            <div className="flex-1 min-w-0 flex flex-col justify-between">
              <div>
                <h4 className="font-serif font-bold text-xs text-stone-900 truncate">
                  {p.title}
                </h4>
                <div className="text-[11px] text-stone-500 mt-0.5">
                  {p.material} • {p.threadCount} TC
                </div>
                <div className="flex items-center gap-1 mt-1 flex-wrap">
                  {p.profiles.map((prof) => (
                    <span
                      key={prof.id}
                      className="text-[9px] px-1 py-0.2 bg-stone-100 rounded text-stone-600 font-medium"
                    >
                      {prof.name.split(' ')[0]}
                    </span>
                  ))}
                </div>
              </div>

              <div className="flex items-center justify-between pt-1 border-t border-stone-100 mt-1">
                <span className="text-xs font-bold text-[#0f1c2e]">AED {p.price}</span>
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                  p.stockCount > 10 ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'
                }`}>
                  {p.stockCount} in stock
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
