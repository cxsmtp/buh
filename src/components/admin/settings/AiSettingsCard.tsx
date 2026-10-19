'use client';

import React, { useState } from 'react';
import { Loader2, PlugZap, Sparkles } from 'lucide-react';
import { postJson } from '@/lib/apiClient';
import { AI_MODELS, type AiModel, type AiSettings } from '@/types';
import { useAutoSave, type AutoSaveHooks } from './useAutoSave';

/**
 * Settings → AI writing: the Anthropic API key that "Write from photo" (product editor) uses, the
 * model, and the switch. Off until a key is saved. The key is write-only: the hub only ever shows
 * its last 4 characters, it is never sent to a browser, a log or a backup.
 */

const field = 'w-full min-h-11 px-3 py-2 rounded-xl border border-line-strong bg-surface text-ink text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-gold';
const label = 'block text-xs font-semibold text-ink-soft mb-1';

const MODEL_NAMES: Record<AiModel, string> = {
  'claude-opus-5-5': 'Claude Opus 5.5 (recommended, best writing)',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5 (faster, lower cost)',
  'claude-haiku-5-5': 'Claude Haiku 5.5 (fastest, lowest cost)',
};

export function AiSettingsCard({
  value,
  secretsSet,
  secretsHint,
  onSave,
  auto,
}: {
  value: AiSettings;
  secretsSet: Record<string, boolean>;
  secretsHint?: Record<string, string>;
  onSave: (v: AiSettings) => Promise<string | null>;
  auto?: AutoSaveHooks;
}) {
  const [d, setD] = useState<AiSettings>(value);
  // The key is never autosaved (a half-typed one would replace a working one): Save sends it.
  const autosave = useAutoSave({ settingsKey: 'ai', value: { ...d, anthropicApiKey: '' }, enabled: Boolean(auto) && !d.anthropicApiKey, ...auto });
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const keySaved = Boolean(secretsSet.anthropicApiKey);
  const hint = secretsHint?.anthropicApiKey;

  const save = async () => {
    autosave.cancel();
    setSaving(true);
    setStatus(null);
    const problem = await onSave(d);
    setSaving(false);
    if (!problem) setD((x) => ({ ...x, anthropicApiKey: '' }));
    setStatus(problem ? { ok: false, text: problem } : { ok: true, text: d.enabled ? 'Saved. “Write from photo” is on in the product editor.' : 'Saved. AI writing is off.' });
  };

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    const { ok, data } = await postJson<{ message?: string; detail?: string; model?: string }>('/api/admin/ai/test', { settings: { model: d.model, ...(d.anthropicApiKey.trim() ? { anthropicApiKey: d.anthropicApiKey.trim() } : {}) } });
    setTesting(false);
    setTest(ok ? { ok: true, text: `Works: Anthropic answered with ${MODEL_NAMES[d.model].replace(/ \(.*\)$/, '')}.` } : { ok: false, text: data.message || 'The test did not work.' });
  };

  return (
    <div className="space-y-4 text-sm" data-testid="ai-settings">
      <section className="space-y-2">
        <h3 className="font-bold text-ink flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-gold-deep" aria-hidden="true" /> Write from photo
        </h3>
        <p className="text-xs text-ink-soft">
          In the product editor, &ldquo;Write name &amp; descriptions from photo&rdquo; looks at the product&rsquo;s photo and suggests a name, a short and a full description, its colours and the weave. You check and edit them before anything is saved. It uses your own Anthropic account: each description costs a fraction of a cent.
        </p>
        <label className="flex items-center gap-2 text-sm font-semibold min-h-11">
          <input type="checkbox" className="w-5 h-5" checked={d.enabled} onChange={(e) => setD((x) => ({ ...x, enabled: e.target.checked }))} />
          Use AI writing
        </label>
        {!keySaved && !d.anthropicApiKey && <p className="text-xs text-ink-muted">Off until you add your API key below.</p>}
      </section>

      <section className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="sm:col-span-2">
          <label className={label} htmlFor="ai-key">
            Anthropic API key
          </label>
          <input
            id="ai-key"
            type="password"
            className={`${field} font-mono`}
            placeholder={keySaved ? `${hint ?? '••••'} saved` : 'sk-ant-…'}
            autoComplete="off"
            spellCheck={false}
            value={d.anthropicApiKey}
            maxLength={300}
            onChange={(e) => {
              const v = e.target.value.trim();
              // A first key switches it on (the owner can still untick it before saving).
              setD((x) => ({ ...x, anthropicApiKey: v, enabled: !keySaved && !x.anthropicApiKey && v ? true : x.enabled }));
            }}
          />
          <p className="text-[11px] text-ink-muted mt-1">console.anthropic.com → API keys → Create key. Leave blank to keep the saved key. It is kept on the shop&rsquo;s server only: never shown again, never sent to a browser, never in backups (type it again after restoring one).</p>
        </div>
        <div>
          <label className={label} htmlFor="ai-model">
            Model
          </label>
          <select id="ai-model" className={field} value={d.model} onChange={(e) => setD((x) => ({ ...x, model: e.target.value as AiModel }))}>
            {AI_MODELS.map((m) => (
              <option key={m} value={m}>
                {MODEL_NAMES[m]}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col justify-end gap-1">
          <button type="button" onClick={() => void runTest()} disabled={testing || (!keySaved && !d.anthropicApiKey)} className="min-h-11 px-3 rounded-xl border border-line-strong text-sm font-semibold inline-flex items-center justify-center gap-1.5 disabled:opacity-50">
            {testing ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <PlugZap className="w-4 h-4" aria-hidden="true" />} Test
          </button>
        </div>
        {test && (
          <p role="status" data-testid="ai-test-result" className={`sm:col-span-2 text-xs font-semibold break-anywhere ${test.ok ? 'text-success' : 'text-danger'}`}>
            {test.text}
          </p>
        )}
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => void save()} disabled={saving} className="min-h-11 px-4 rounded-xl bg-ink text-paper text-xs font-bold flex items-center gap-1.5 disabled:opacity-60">
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />} Save AI settings
        </button>
        {auto && !d.anthropicApiKey && autosave.bar}
        {status && (
          <p role="status" className={`text-xs font-semibold ${status.ok ? 'text-success' : 'text-danger'}`}>
            {status.text}
          </p>
        )}
      </div>
    </div>
  );
}
