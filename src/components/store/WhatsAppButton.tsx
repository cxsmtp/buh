'use client';

import React from 'react';
import { MessageCircle } from 'lucide-react';
import { useShop, whatsappLink } from '@/lib/client/shop';

/** The floating "Chat on WhatsApp" button (Settings → Store & contact). Hidden without a number. */
export function WhatsAppButton() {
  const { store } = useShop();
  const href = store.showWhatsAppButton ? whatsappLink(store, store.whatsappGreeting) : null;
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Chat with us on WhatsApp"
      className="fixed z-40 right-3 bottom-20 md:bottom-6 md:right-6 w-12 h-12 rounded-full bg-[#1f9d55] text-white shadow-lg flex items-center justify-center hover:brightness-110 focus:outline-none focus-visible:ring-4 focus-visible:ring-emerald-300"
    >
      <MessageCircle className="w-6 h-6" />
    </a>
  );
}
