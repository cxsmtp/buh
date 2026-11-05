import React from 'react';
import { LOCALE_BOOT_SCRIPT } from '@/lib/i18n/boot';

/** First in the shop's markup: the visitor's language direction before anything paints (src/lib/i18n/boot.ts). */
export function LocaleBoot() {
  // eslint-disable-next-line react/no-danger
  return <script dangerouslySetInnerHTML={{ __html: LOCALE_BOOT_SCRIPT }} />;
}
