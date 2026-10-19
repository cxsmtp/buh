/**
 * Where the Admin Hub opens (BUH-02.17). On a phone-sized screen (the phone view): Orders, with
 * today's to-dos on top (orders to confirm, to dispatch, stock running low). On a laptop: the
 * Overview, with the same to-dos and the money highlights. Each device then remembers the section
 * the owner last chose, per view, in this browser only (localStorage, which may be blocked or
 * cleared: then the default above). The navigation itself is unchanged.
 */

export const HUB_TABS = ['overview', 'orders', 'add-product', 'inventory', 'crm', 'money', 'settings', 'chats'] as const;
export type HubTab = (typeof HUB_TABS)[number];
export type HubLayout = 'phone' | 'laptop';

const KEY = (view: HubLayout) => `buh_hub_tab_${view}`;
/** Sections not worth landing on again (a half-done "Add product" opens as Inventory's editor anyway). */
const NOT_REMEMBERED: readonly HubTab[] = ['add-product'];

/** The section a view opens on when this device has no choice remembered. */
export function defaultHubTab(view: HubLayout): HubTab {
  return view === 'phone' ? 'orders' : 'overview';
}

/** The section to open: this device's last choice for the view, else the view's default. */
export function initialHubTab(view: HubLayout, storage: Pick<Storage, 'getItem'> | null = safeStorage()): HubTab {
  try {
    const saved = storage?.getItem(KEY(view));
    if (saved && (HUB_TABS as readonly string[]).includes(saved) && !NOT_REMEMBERED.includes(saved as HubTab)) return saved as HubTab;
  } catch {
    // storage blocked: the default
  }
  return defaultHubTab(view);
}

/** Remember the owner's choice for this view on this device (best effort). */
export function rememberHubTab(view: HubLayout, tab: HubTab, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  if (NOT_REMEMBERED.includes(tab)) return;
  try {
    storage?.setItem(KEY(view), tab);
  } catch {
    // not remembered: this visit only
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}
