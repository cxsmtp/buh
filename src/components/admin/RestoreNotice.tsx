'use client';

import React, { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { getJson, sendJson } from '@/lib/apiClient';

interface Notice {
  restoredAt: string;
  backup: string;
  suspendedPasskeys: number;
  recoveryCodesLeft: number;
}

/**
 * After the shop was restored from a backup: the backup may be older than a
 * passkey the owner removed or a new set of recovery codes, so restored
 * passkeys are switched off and old codes voided until the owner reviews them.
 */
export function RestoreNotice({ onReview }: { onReview: () => void }) {
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    void getJson<{ notice: Notice | null }>('/api/admin/restore-notice').then(({ ok, data }) => {
      if (ok) setNotice(data.notice);
    });
  }, []);

  if (!notice) return null;
  const when = notice.restoredAt ? new Date(notice.restoredAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'recently';

  const done = async () => {
    const { ok } = await sendJson('DELETE', '/api/admin/restore-notice');
    if (ok) setNotice(null);
  };

  return (
    <div role="alert" className="rounded-2xl border border-warning-line bg-warning-soft text-warning p-3 text-xs flex flex-wrap items-start gap-3">
      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-warning" aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="font-bold">The shop was restored from a backup ({when}). Review your passkeys and create new recovery codes.</p>
        <p>
          The backup may be older than a passkey you removed (a lost phone) or your newest recovery codes, so
          {notice.suspendedPasskeys > 0
            ? ` ${notice.suspendedPasskeys} restored passkey${notice.suspendedPasskeys === 1 ? ' is' : 's are'} switched off until you keep or remove ${notice.suspendedPasskeys === 1 ? 'it' : 'them'},`
            : ' restored passkeys were switched off,'}
          {' '}and the old recovery codes no longer work{notice.recoveryCodesLeft > 0 ? ` (you have ${notice.recoveryCodesLeft} new ones)` : ''}.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={onReview} className="px-3 py-1.5 rounded-lg bg-ink text-paper font-bold">Review now</button>
        <button type="button" onClick={() => void done()} className="px-3 py-1.5 rounded-lg border border-gold bg-surface text-ink font-bold">Done, hide this</button>
      </div>
    </div>
  );
}
