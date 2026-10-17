import { adminAccountInfo } from './adminAuth';
import { createLinkIfAbsent, linkUrl, maskSegment, rotateLink, setLinkNotice, storeReveal } from './adminLink';
import { audit } from './audit';
import { logEvent } from './log';
import { emailConfigured, sender, transport } from './mail';
import { appUrl } from './runtimeConfig';
import { getSettings } from './settings';

/**
 * Print the admin link on the server's console, like the first admin password:
 * readable there, once. (logEvent lines, which may be shared, only ever carry a
 * masked form.)
 */
function printLink(segment: string, heading: string) {
  const base = appUrl();
  console.log(
    [
      '',
      '==================================================================',
      `  Beautiful UAE Home — ${heading}`,
      `  Admin link: ${linkUrl(segment, base)}`,
      ...(base ? [] : ['  (put your shop\'s address in front, e.g. https://yourshop.ae/…)']),
      '  The Admin Hub is only at this address: bookmark it on your phone',
      '  and laptop. It is shown once (only a fingerprint of it is kept).',
      '  Lost it? On the server run:',
      '    podman exec beautifuluaehome node scripts/admin-link.mjs --new',
      '==================================================================',
      '',
    ].join('\n')
  );
}

/** Email the link to the admin email, when email is set up. Never throws; true when sent. */
export async function emailAdminLink(segment: string, why: 'created' | 'changed', baseOverride?: string): Promise<boolean> {
  if (!emailConfigured()) return false;
  try {
    const base = baseOverride || appUrl();
    const { email } = await adminAccountInfo();
    const shop = getSettings('brand').storeName || 'Beautiful UAE Home';
    const link = linkUrl(segment, base);
    await (await transport()).sendMail({
      from: sender(),
      to: email,
      subject: `[${shop}] Your private Admin Hub link`,
      text: [
        why === 'changed' ? `The Admin Hub link of ${shop} was changed. The old link no longer works.` : `The Admin Hub of ${shop} now has its own private link; it is no longer on the shop's pages.`,
        '',
        `Your Admin Hub: ${link}`,
        '',
        'Open it on your phone and on your laptop and bookmark it (or add it to the home screen). Keep it private: do not share or post it.',
        '',
        "If this wasn't you, change the link at once in Admin Hub → Settings → Security, and your password too.",
      ].join('\n'),
    });
    return true;
  } catch (err) {
    logEvent('warn', 'admin_link_email_failed', { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/**
 * At start: the first link, when there is none yet (a new shop, or the update that
 * brought private links). Printed once on the console, emailed to the admin email
 * when email is set up, and shown once to an owner who is signed in right now.
 */
export function ensureAdminLink(): void {
  const segment = createLinkIfAbsent('startup');
  if (!segment) return;
  printLink(segment, 'the Admin Hub has a private link');
  storeReveal(segment);
  setLinkNotice('created');
  logEvent('info', 'admin_link_created', { link: `/${maskSegment(segment)}`, via: 'startup' });
  const emailing = emailConfigured();
  audit('admin.link_created', { via: 'startup', emailing });
  // Not awaited: the shop starts without waiting for the mail server.
  if (emailing) void emailAdminLink(segment, 'created');
}

/** Settings → Security → "Change the admin link". Returns the new segment. */
export function changeAdminLink(by: { ip?: string | null; base?: string }): { segment: string; emailing: boolean } {
  const segment = rotateLink('hub');
  const emailing = emailConfigured();
  // Written before the answer reports it done; the link itself is never in the audit log.
  audit('admin.link_changed', { via: 'hub', ip: by.ip ?? null, emailing });
  logEvent('info', 'admin_link_changed', { link: `/${maskSegment(segment)}`, via: 'hub' });
  // Not awaited: a slow mail server must not hold up the answer.
  if (emailing) void emailAdminLink(segment, 'changed', by.base);
  return { segment, emailing };
}
