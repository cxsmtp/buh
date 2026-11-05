'use client';

import React, { useEffect, useId, useState } from 'react';
import { CheckCircle2, CloudUpload, Loader2, XCircle } from 'lucide-react';
import { getJson, postJson, sendJson } from '@/lib/apiClient';

interface Status {
  enabled: boolean;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  keep: number;
  accessKeyId: string;
  accessKeyHint?: string;
  secretSet: boolean;
  secretHint?: string;
  passwordSet: boolean;
  running: boolean;
  state: { lastAttemptAt?: string; lastSuccessAt?: string; lastFile?: string; lastSize?: number; lastError?: string };
}

/** Where to find the endpoint and region at each provider (typed by the owner; nothing is guessed). */
const PROVIDERS: Array<{ id: string; name: string; endpoint: string; region: string; note: string }> = [
  { id: 'r2', name: 'Cloudflare R2', endpoint: 'https://<account id>.r2.cloudflarestorage.com', region: 'auto', note: 'R2 → Manage API tokens: make a token with "Object Read & Write" for the bucket.' },
  { id: 'b2', name: 'Backblaze B2', endpoint: 'https://s3.<region>.backblazeb2.com', region: 'e.g. us-west-004', note: 'B2 → Application Keys: add a key for the bucket (its keyID and applicationKey).' },
  { id: 'aws', name: 'Amazon S3', endpoint: 'https://s3.<region>.amazonaws.com', region: 'e.g. me-central-1', note: 'IAM: a user with PutObject, ListBucket and DeleteObject on the bucket only.' },
];

const when = (iso?: string) => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

/**
 * Settings → System & backups → a second place for the backups (asked by the owner): an
 * S3-compatible bucket (Cloudflare R2, Backblaze B2, Amazon S3). Each encrypted backup is copied
 * there too; the newest ones are kept. The secret is never shown again: only that it is saved and
 * its last 4 characters.
 */
export function S3BackupCard() {
  const id = useId();
  const [s, setS] = useState<Status | null>(null);
  const [endpoint, setEndpoint] = useState('');
  const [region, setRegion] = useState('auto');
  const [bucket, setBucket] = useState('');
  const [prefix, setPrefix] = useState('beautifuluaehome');
  const [keep, setKeep] = useState('30');
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState<'' | 'save' | 'test'>('');
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const fill = (v: Status) => {
    setS(v);
    setEndpoint(v.endpoint);
    setRegion(v.region || 'auto');
    setBucket(v.bucket);
    setPrefix(v.prefix);
    setKeep(String(v.keep));
  };
  useEffect(() => {
    let alive = true;
    void getJson<Status>('/api/admin/backup/s3').then(({ ok, data }) => {
      if (alive && ok) fill(data);
    });
    return () => {
      alive = false;
    };
  }, []);

  const save = async (enabled: boolean) => {
    setBusy('save');
    setNote(null);
    const { ok, data } = await sendJson<Status & { message?: string }>('PUT', '/api/admin/backup/s3', {
      enabled,
      endpoint: endpoint.trim(),
      region: region.trim() || 'auto',
      bucket: bucket.trim(),
      prefix: prefix.trim(),
      keep: Number(keep),
      ...(accessKeyId.trim() ? { accessKeyId: accessKeyId.trim() } : {}),
      ...(secret ? { secretAccessKey: secret.trim() } : {}),
    });
    setBusy('');
    if (!ok) return setNote({ ok: false, text: data.message || 'Not saved.' });
    fill(data);
    setSecret('');
    setAccessKeyId('');
    setNote({ ok: true, text: enabled ? 'Saved: each new backup is copied here too.' : 'Saved.' });
  };
  const test = async () => {
    setBusy('test');
    setNote(null);
    const { data } = await postJson<{ ok?: boolean; message?: string }>('/api/admin/backup/s3/test', {});
    setBusy('');
    setNote({ ok: Boolean(data.ok), text: data.message || 'No answer.' });
  };

  const field = 'w-full min-w-0 min-h-10 px-3 rounded-xl border border-line-strong bg-surface text-ink text-xs focus:outline-none focus:ring-2 focus:ring-gold';
  const label = 'block text-[11px] font-semibold text-ink-soft mb-1';
  const st = s?.state;
  return (
    <section aria-labelledby={`${id}-t`} data-testid="s3-backup" className="rounded-2xl border border-line bg-surface p-3 sm:p-4 space-y-3 min-w-0">
      <h3 id={`${id}-t`} className="text-sm font-bold text-ink flex items-center gap-1.5">
        <CloudUpload className="w-4 h-4 text-gold-deep" aria-hidden="true" /> Second backup place (S3, Backblaze B2, Cloudflare R2)
      </h3>
      <p>Each encrypted backup is also copied to a storage bucket of yours, so a copy is safe even if Google Drive disconnects. Cloudflare R2 and Backblaze B2 have free allowances that fit this shop&rsquo;s backups.</p>
      {s && !s.passwordSet && <p role="status" className="text-warning font-semibold">Set a backup password above first: copies outside the server are always encrypted.</p>}
      {s && (
        <p role="status" data-testid="s3-status" className={st?.lastError ? 'text-danger font-semibold' : 'text-ink'}>
          {s.enabled ? 'On' : 'Off'}
          {st?.lastSuccessAt ? ` · last copy ${when(st.lastSuccessAt)} (${st.lastFile})` : ''}
          {st?.lastError ? ` · last try failed: ${st.lastError}` : ''}
          {s.running ? ' · copying now…' : ''}
        </p>
      )}
      <details className="text-ink-soft">
        <summary className="min-h-9 flex items-center cursor-pointer font-semibold">Where to find these at your provider</summary>
        <ul className="mt-1 space-y-1">
          {PROVIDERS.map((p) => (
            <li key={p.id}>
              <strong className="text-ink">{p.name}</strong>: endpoint <code className="break-all">{p.endpoint}</code>, region {p.region}. {p.note}
            </li>
          ))}
        </ul>
      </details>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div className="sm:col-span-2">
          <label className={label} htmlFor={`${id}-ep`}>Endpoint</label>
          <input id={`${id}-ep`} className={field} placeholder="https://….r2.cloudflarestorage.com" value={endpoint} maxLength={300} onChange={(e) => setEndpoint(e.target.value)} />
        </div>
        <div>
          <label className={label} htmlFor={`${id}-b`}>Bucket</label>
          <input id={`${id}-b`} className={field} placeholder="e.g. buh-backups" value={bucket} maxLength={63} onChange={(e) => setBucket(e.target.value)} />
        </div>
        <div>
          <label className={label} htmlFor={`${id}-r`}>Region</label>
          <input id={`${id}-r`} className={field} placeholder="auto" value={region} maxLength={40} onChange={(e) => setRegion(e.target.value)} />
        </div>
        <div>
          <label className={label} htmlFor={`${id}-k`}>Access key ID</label>
          <input id={`${id}-k`} className={`${field} font-mono`} autoComplete="off" spellCheck={false} placeholder={s?.accessKeyId ? `${s.accessKeyHint ?? s.accessKeyId} saved — leave blank to keep` : 'Not set'} value={accessKeyId} maxLength={128} onChange={(e) => setAccessKeyId(e.target.value)} />
        </div>
        <div>
          <label className={label} htmlFor={`${id}-s`}>Secret access key</label>
          <input id={`${id}-s`} type="password" className={`${field} font-mono`} autoComplete="off" spellCheck={false} placeholder={s?.secretSet ? `${s.secretHint ?? '••••'} saved — leave blank to keep` : 'Not set'} value={secret} maxLength={256} onChange={(e) => setSecret(e.target.value)} />
        </div>
        <div>
          <label className={label} htmlFor={`${id}-p`}>Folder in the bucket</label>
          <input id={`${id}-p`} className={field} value={prefix} maxLength={100} onChange={(e) => setPrefix(e.target.value)} />
        </div>
        <div>
          <label className={label} htmlFor={`${id}-n`}>Copies to keep</label>
          <input id={`${id}-n`} className={field} type="number" inputMode="numeric" min={1} max={365} value={keep} onChange={(e) => setKeep(e.target.value)} />
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={Boolean(busy)} onClick={() => void save(true)} className="min-h-10 px-3 rounded-lg bg-ink text-paper text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-50">
          {busy === 'save' && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />} {s?.enabled ? 'Save' : 'Save and switch on'}
        </button>
        <button type="button" disabled={Boolean(busy)} onClick={() => void test()} className="min-h-10 px-3 rounded-lg border border-line-strong bg-surface text-ink text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-50">
          {busy === 'test' && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />} Test the connection
        </button>
        {s?.enabled && (
          <button type="button" disabled={Boolean(busy)} onClick={() => void save(false)} className="min-h-10 px-3 rounded-lg border border-line-strong bg-surface text-ink text-xs font-semibold disabled:opacity-50">
            Switch off
          </button>
        )}
      </div>
      {note && (
        <p role={note.ok ? 'status' : 'alert'} data-testid="s3-note" className={`flex items-start gap-1.5 font-semibold break-anywhere ${note.ok ? 'text-success' : 'text-danger'}`}>
          {note.ok ? <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" /> : <XCircle className="w-4 h-4 shrink-0" aria-hidden="true" />} {note.text}
        </p>
      )}
      <p className="text-ink-muted">To restore from it: download the newest file from the bucket, put it on the server and run the restore command in the guide (the backup password opens it).</p>
    </section>
  );
}
