'use client';

import React, { useState } from 'react';
import { Product } from '@/types';
import { Star, Sparkles, Layers, ArrowRight } from 'lucide-react';
import { useShop } from '@/lib/client/shop';
import { LocalPrice } from '@/lib/client/currency';

interface ProductCardProps {
  product: Product;
  onSelect: (product: Product) => void;
}

export const ProductCard: React.FC<ProductCardProps> = ({ product, onSelect }) => {
  // Always display the primary luxury staged photo directly in one go
  const currentImage = product.aiTransformedImage || product.featuredImage || product.galleryImages[0];
  const { lowStockThreshold } = useShop();
  const soldOut = product.stockCount === 0;
  const fewLeft = !soldOut && product.stockCount <= lowStockThreshold;

  return (
    <div
      onClick={() => onSelect(product)}
      className="group bg-white rounded-2xl overflow-hidden border border-stone-200 hover:border-[#c5a059]/60 shadow-xs hover:shadow-md transition-all cursor-pointer flex flex-col justify-between"
    >
      {/* Product Image Container */}
      <div className="relative aspect-[4/3] sm:aspect-[4/3] bg-stone-100 overflow-hidden">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={currentImage}
          alt={product.title}
          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
          loading="lazy"
        />

        {/* Luxury Artisan Tag */}
        <div className="absolute top-1.5 sm:top-2.5 left-1.5 sm:left-2.5">
          <span className="bg-[#0f1c2e]/85 backdrop-blur-md text-amber-200 text-[9px] sm:text-[10px] font-semibold px-2 py-0.5 sm:px-2.5 sm:py-1 rounded-full shadow border border-amber-300/30 flex items-center gap-1">
            <Sparkles className="w-2.5 h-2.5 sm:w-3 sm:h-3 text-[#c5a059]" />
            <span>Artisan Linens</span>
          </span>
        </div>

        {/* Most designs are one or two pieces: say so */}
        {(soldOut || fewLeft) && (
          <span className={`absolute top-8 sm:top-10 left-1.5 sm:left-2.5 text-[9px] sm:text-[10px] font-bold px-2 py-0.5 rounded-full shadow ${soldOut ? 'bg-stone-700 text-white' : 'bg-amber-500 text-white'}`}>
            {soldOut ? 'Sold out' : product.stockCount === 1 ? 'Only 1 left' : `Only ${product.stockCount} left`}
          </span>
        )}

        {/* Savings Badge */}
        {product.compareAtPrice && product.compareAtPrice > product.price && (
          <span className="absolute top-1.5 sm:top-2.5 right-1.5 sm:right-2.5 bg-red-600 text-white text-[9px] sm:text-[10px] font-bold px-1.5 sm:px-2 py-0.5 rounded-full shadow">
            Save AED {product.compareAtPrice - product.price}
          </span>
        )}

        {/* Bottom Material & Thread Count Pill */}
        <div className="absolute bottom-1.5 sm:bottom-2 left-1.5 sm:left-2 right-1.5 sm:right-2 flex items-center justify-between text-[9px] sm:text-[10px] bg-black/65 backdrop-blur-md text-white px-2 py-0.5 rounded-md">
          <span className="font-medium truncate">{product.material.split('(')[0]}</span>
          <span className="font-bold text-amber-300 ml-1 shrink-0">{product.threadCount} TC</span>
        </div>
      </div>

      {/* Product Information */}
      <div className="p-2.5 sm:p-3.5 flex flex-col flex-1 justify-between gap-1.5">
        <div>
          {/* Star Rating */}
          <div className="flex items-center gap-1 text-[10px] sm:text-[11px] text-stone-500 mb-0.5">
            <div className="flex items-center text-amber-500">
              <Star className="w-2.5 h-2.5 sm:w-3 sm:h-3 fill-amber-400 text-amber-400" />
            </div>
            <span className="font-semibold text-stone-800">{product.rating}</span>
            <span className="hidden sm:inline">({product.reviewsCount} reviews)</span>
          </div>

          {/* Title */}
          <h3 className="font-serif font-bold text-xs sm:text-sm text-stone-900 group-hover:text-[#9f7e38] transition-colors line-clamp-1 sm:line-clamp-2 leading-snug">
            {product.title}
          </h3>

          {/* Size Pills Available */}
          <div className="flex items-center gap-1 mt-1 sm:mt-1.5 flex-wrap">
            <span className="text-[9px] text-stone-500 font-medium hidden sm:inline-flex items-center gap-0.5">
              <Layers className="w-2.5 h-2.5 text-[#c5a059]" />
              Sizes:
            </span>
            {product.profiles.slice(0, 3).map((p) => (
              <span
                key={p.id}
                className="text-[8px] sm:text-[9px] px-1 sm:px-1.5 py-0.2 rounded bg-stone-100 text-stone-600 border border-stone-200"
              >
                {p.name.split(' ')[0]}
              </span>
            ))}
            {product.profiles.length > 3 && (
              <span className="text-[8px] text-stone-500">+{product.profiles.length - 3}</span>
            )}
          </div>
        </div>

        {/* Price & Action */}
        <div className="pt-1.5 border-t border-stone-100 flex items-center justify-between gap-1 mt-1">
          <div>
            <div className="flex items-baseline gap-1">
              <span className="text-[10px] text-stone-500">From</span>
              <span className="text-xs sm:text-sm md:text-base font-bold text-[#0f1c2e]">
                AED {product.price}
              </span>
            </div>
            <LocalPrice aed={product.price} className="text-[10px] block" />
            <span className="text-[9px] text-emerald-600 font-medium hidden sm:block">
              Express Delivery
            </span>
          </div>

          <button
            onClick={(e) => {
              e.stopPropagation();
              onSelect(product);
            }}
            className="flex items-center gap-1 bg-stone-900 group-hover:bg-[#c5a059] text-white text-[10px] sm:text-xs font-semibold px-2.5 py-1 sm:px-3 sm:py-1.5 rounded-lg transition-colors shadow-xs shrink-0"
          >
            <span>Sizes</span>
            <ArrowRight className="w-2.5 h-2.5 sm:w-3 sm:h-3" />
          </button>
        </div>
      </div>
    </div>
  );
};
