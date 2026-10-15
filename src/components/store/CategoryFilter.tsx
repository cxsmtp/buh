'use client';

import React from 'react';

/** 'all' or a category id from Settings → Catalogue. */
export type CategoryOption = string;

interface CategoryFilterProps {
  selectedCategory: CategoryOption;
  onSelectCategory: (category: CategoryOption) => void;
  /** The shop's categories (Settings → Catalogue); only those with products are shown. */
  categories: Array<{ id: string; label: string; icon: string }>;
}

export const CategoryFilter: React.FC<CategoryFilterProps> = ({
  selectedCategory,
  onSelectCategory,
  categories,
}) => {
  const all = [{ id: 'all', label: 'All Editions', icon: '✨' }, ...categories];

  return (
    <div className="px-1 sm:px-2 mb-2">
      <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-0.5">
        {all.map((cat) => {
          const isSelected = selectedCategory === cat.id;
          return (
            <button
              key={cat.id}
              onClick={() => onSelectCategory(cat.id)}
              className={`flex items-center gap-1 px-2.5 py-1 sm:py-1.5 rounded-xl text-[11px] sm:text-xs font-semibold whitespace-nowrap transition-all shrink-0 ${
                isSelected
                  ? 'bg-[#0f1c2e] text-white shadow-xs ring-1 ring-[#c5a059]'
                  : 'bg-white text-stone-700 hover:bg-stone-100 border border-stone-200'
              }`}
            >
              <span>{cat.icon}</span>
              <span>{cat.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
