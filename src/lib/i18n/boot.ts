/** Where the visitor's language choice is kept in the browser. */
export const LOCALE_KEY = 'buh_lang';

/**
 * Rendered first in the shop's markup (LocaleBoot), so it runs before the shop paints: an Arabic
 * visitor's page is right to left from the start, never jumping. The same rule as detectLocale
 * (their choice, else the device's language). Only the shop renders it (never the Admin Hub).
 */
export const LOCALE_BOOT_SCRIPT = `(function(){try{var s=null;try{s=localStorage.getItem('${LOCALE_KEY}')}catch(e){}var a=s?s==='ar':(navigator.languages&&navigator.languages.length?navigator.languages:[navigator.language]).some(function(l){return /^ar\\b/i.test(l||'')});if(a){document.documentElement.lang='ar-AE';document.documentElement.dir='rtl';}}catch(e){}})();`;
