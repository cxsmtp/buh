'use client';

import React from 'react';
import { Palette, Truck, ShieldCheck, ArrowRight } from 'lucide-react';

interface HeroBannerProps {
  onExploreClick: () => void;
}

export const HeroBanner: React.FC<HeroBannerProps> = ({ onExploreClick }) => {
  return (
    <div className="relative overflow-hidden bg-gradient-to-r from-[#0f1c2e] via-[#16253c] to-[#0f1c2e] text-white py-3.5 sm:py-4 px-3 sm:px-5 rounded-2xl mx-1 sm:mx-2 my-2 shadow-md border border-stone-800">
      {/* Background Subtle Glow */}
      <div className="absolute -top-20 -right-20 w-52 h-52 rounded-full bg-[#c5a059]/10 blur-2xl pointer-events-none"></div>

      <div className="relative flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 max-w-7xl mx-auto">
        {/* Left: Compact Headline & Tagline */}
        <div className="space-y-0.5">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-400/20 text-amber-300 text-[10px] font-semibold border border-amber-400/30">
              <Palette className="w-2.5 h-2.5 text-[#c5a059]" />
              <span>Handprinted & Machine-Printed Linens</span>
            </span>
            <span className="text-[10px] text-stone-300 hidden md:inline">
              • Tailored for UAE Beds (40cm Deep Pockets)
            </span>
          </div>

          <h1 className="font-serif text-base sm:text-xl md:text-2xl font-bold tracking-tight text-white leading-tight">
            The Art of <span className="text-[#c5a059]">Block-Printed</span> Bed Linens
          </h1>

          <p className="text-stone-300 text-[10px] sm:text-xs max-w-2xl font-light line-clamp-1 sm:line-clamp-none">
            100% Giza Egyptian cotton & French flax linen. Botanical mineral dyes with guaranteed extra-deep mattress fit.
          </p>
        </div>

        {/* Right: Quick Trust Badges & Action */}
        <div className="flex items-center gap-2 shrink-0">
          <div className="hidden lg:flex items-center gap-2.5 text-[10px] text-stone-300 bg-white/5 border border-white/10 px-2.5 py-1.5 rounded-xl">
            <span className="flex items-center gap-1 font-medium">
              <Truck className="w-3 h-3 text-[#c5a059]" />
              Express Delivery
            </span>
            <span>•</span>
            <span className="flex items-center gap-1 font-medium">
              <ShieldCheck className="w-3 h-3 text-emerald-400" />
              COD & Bank Transfer
            </span>
          </div>

          <button
            onClick={onExploreClick}
            className="inline-flex items-center gap-1 bg-gradient-to-r from-[#c5a059] to-[#dfc082] text-[#0f1c2e] font-bold text-[11px] sm:text-xs px-3.5 py-1.5 sm:py-2 rounded-xl shadow hover:brightness-105 active:scale-95 transition-all whitespace-nowrap"
          >
            <span>Shop Editions</span>
            <ArrowRight className="w-3 h-3" />
          </button>
        </div>
      </div>
    </div>
  );
};
