'use client';

import React from 'react';

export type CategoryOption = 'all' | 'bedsheets' | 'duvet-covers' | 'fitted-sheets' | 'hotel-luxury' | 'silk-collection';

interface CategoryFilterProps {
  selectedCategory: CategoryOption;
  onSelectCategory: (category: CategoryOption) => void;
}

export const CategoryFilter: React.FC<CategoryFilterProps> = ({
  selectedCategory,
  onSelectCategory,
}) => {
  const categories: { id: CategoryOption; label: string; icon: string }[] = [
    { id: 'all', label: 'All Editions', icon: '✨' },
    { id: 'bedsheets', label: 'Hand Block Sets', icon: '🛏️' },
    { id: 'hotel-luxury', label: 'Mughal & Hotel 1000TC', icon: '👑' },
    { id: 'silk-collection', label: 'Indigo Mud-Resist', icon: '💎' },
    { id: 'fitted-sheets', label: '40cm Deep Fitted', icon: '📐' },
    { id: 'duvet-covers', label: 'Duvet Covers', icon: '☁️' },
  ];

  return (
    <div className="px-1 sm:px-2 mb-2">
      <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-0.5">
        {categories.map((cat) => {
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
