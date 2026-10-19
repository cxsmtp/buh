'use client';

import React, { useState } from 'react';
import { BedDouble, Loader2, PlugZap, Sparkles } from 'lucide-react';
import { postJson } from '@/lib/apiClient';
import { AI_MODELS, type AiModel, type AiProvider, type AiSettings } from '@/types';
import { useAutoSave, type AutoSaveHooks } from './useAutoSave';

/**
 * Settings → AI writing:
 * - which AI writes "Write from photo" (product editor): Anthropic (Claude) or Google Gemini, with
 *   each one's key and model, and the switch (off until the chosen AI's key is saved);
 * - Google Gemini also makes "Style in a bedroom" photos (Claude does not make images): its Test
 *   reads the models the key can use from Google and fills the two lists (writing, images);
 * - "Label styled photos for customers" (on by default).
 * Keys are write-only: the hub only ever shows their last 4 characters, they are never sent to a
 * browser, a log or a backup.
 */

const field = 'w-full min-h-11 px-3 py-2 rounded-xl border border-line-strong bg-surface text-ink text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-gold';
const label = 'block text-xs font-semibold text-ink-soft mb-1';
const testBtn = 'min-h-11 px-3 rounded-xl border border-line-strong text-sm font-semibold inline-flex items-center justify-center gap-1.5 disabled:opacity-50';

const MODEL_NAMES: Record<AiModel, string> = {
  'claude-opus-5-5': 'Claude Opus 5.5 (recommended, best writing)',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5 (faster, lower cost)',
  'claude-haiku-5-5': 'Claude Haiku 5.5 (fastest, lowest cost)',
};

interface ModelLists {
  writing: string[];
  image: string[];
  suggested: { writing: string; image: string };
}

/** The list to choose from: Google's (after Test), always with the saved choice in it. */
function options(list: string[] | undefined, current: string): string[] {
  const all = [...(list ?? [])];
  if (current && !all.includes(current)) all.unshift(current);
  return all;
}

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
  const typingKey = Boolean(d.anthropicApiKey || d.geminiApiKey);
  // Keys are never autosaved (a half-typed one would replace a working one): Save sends them.
  const autosave = useAutoSave({ settingsKey: 'ai', value: { ...d, anthropicApiKey: '', geminiApiKey: '' }, enabled: Boolean(auto) && !typingKey, ...auto });
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState<AiProvider | null>(null);
  const [test, setTest] = useState<{ provider: AiProvider; ok: boolean; text: string } | null>(null);
  const [lists, setLists] = useState<ModelLists | null>(null);
  const anthropicSaved = Boolean(secretsSet.anthropicApiKey);
  const geminiSaved = Boolean(secretsSet.geminiApiKey);
  const chosenKeySaved = d.provider === 'gemini' ? geminiSaved || Boolean(d.geminiApiKey) : anthropicSaved || Boolean(d.anthropicApiKey);

  const save = async () => {
    autosave.cancel();
    setSaving(true);
    setStatus(null);
    const problem = await onSave(d);
    setSaving(false);
    if (!problem) setD((x) => ({ ...x, anthropicApiKey: '', geminiApiKey: '' }));
    setStatus(problem ? { ok: false, text: problem } : { ok: true, text: d.enabled ? 'Saved. “Write from photo” is on in the product editor.' : 'Saved. AI writing is off.' });
  };

  const runTest = async (provider: AiProvider) => {
    setTesting(provider);
    setTest(null);
    if (provider === 'anthropic') {
      const { ok, data } = await postJson<{ message?: string }>('/api/admin/ai/test', { settings: { provider, model: d.model, ...(d.anthropicApiKey.trim() ? { anthropicApiKey: d.anthropicApiKey.trim() } : {}) } });
      setTesting(null);
      return setTest({ provider, ok, text: ok ? `Works: Anthropic answered with ${MODEL_NAMES[d.model].replace(/ \(.*\)$/, '')}.` : data.message || 'The test did not work.' });
    }
    const { ok, data } = await postJson<{ message?: string; models?: ModelLists }>('/api/admin/ai/test', { settings: { provider, ...(d.geminiApiKey.trim() ? { geminiApiKey: d.geminiApiKey.trim() } : {}) } });
    setTesting(null);
    if (!ok || !data.models) return setTest({ provider, ok: false, text: data.message || 'The test did not work.' });
    const m = data.models;
    setLists(m);
    // Fill in what isn't chosen yet (or is no longer offered): the newest Pro (else Flash) for
    // writing, Gemini 3.1 Flash Image (else the newest image model) for photos.
    setD((x) => ({
      ...x,
      geminiModel: x.geminiModel && m.writing.includes(x.geminiModel) ? x.geminiModel : m.suggested.writing,
      geminiImageModel: x.geminiImageModel && m.image.includes(x.geminiImageModel) ? x.geminiImageModel : m.suggested.image,
    }));
    setTest({ provider, ok: true, text: `Works: Google offers ${m.writing.length} writing and ${m.image.length} image ${m.image.length === 1 ? 'model' : 'models'} to this key. Choose them below and save.` });
  };

  const writingOptions = options(lists?.writing, d.geminiModel);
  const imageOptions = options(lists?.image, d.geminiImageModel);

  return (
    <div className="space-y-5 text-sm" data-testid="ai-settings">
      <section className="space-y-2">
        <h3 className="font-bold text-ink flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-gold-deep" aria-hidden="true" /> Write from photo
        </h3>
        <p className="text-xs text-ink-soft">
          In the product editor, &ldquo;Write name &amp; descriptions from photo&rdquo; looks at the product&rsquo;s photo and suggests a name, a short and a full description, its colours and the weave. You check and edit them before anything is saved. It uses your own AI account: each description costs a fraction of a cent.
        </p>
        <fieldset className="space-y-1">
          <legend className={label}>Writing AI</legend>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {(
              [
                ['anthropic', 'Anthropic (Claude)'],
                ['gemini', 'Google Gemini'],
              ] as const
            ).map(([id, name]) => (
              <label key={id} className={`min-h-11 px-3 rounded-xl border flex items-center gap-2 font-semibold cursor-pointer ${d.provider === id ? 'border-ink bg-sand' : 'border-line-strong bg-surface'}`}>
                <input type="radio" name="ai-provider" className="w-5 h-5" checked={d.provider === id} onChange={() => setD((x) => ({ ...x, provider: id }))} />
                {name}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="flex items-center gap-2 text-sm font-semibold min-h-11">
          <input type="checkbox" className="w-5 h-5" checked={d.enabled} onChange={(e) => setD((x) => ({ ...x, enabled: e.target.checked }))} />
          Use AI writing
        </label>
        {!chosenKeySaved && <p className="text-xs text-ink-muted">Off until you add the {d.provider === 'gemini' ? 'Gemini' : 'Anthropic'} API key below.</p>}
      </section>

      <section className="grid grid-cols-1 sm:grid-cols-2 gap-3 rounded-xl border border-line p-3" aria-label="Anthropic (Claude)">
        <h4 className="sm:col-span-2 font-bold text-ink">Anthropic (Claude){d.provider === 'anthropic' ? ' · writes the text' : ''}</h4>
        <div className="sm:col-span-2">
          <label className={label} htmlFor="ai-key">
            Anthropic API key
          </label>
          <input
            id="ai-key"
            type="password"
            className={`${field} font-mono`}
            placeholder={anthropicSaved ? `${secretsHint?.anthropicApiKey ?? '••••'} saved` : 'sk-ant-…'}
            autoComplete="off"
            spellCheck={false}
            value={d.anthropicApiKey}
            maxLength={300}
            onChange={(e) => {
              const v = e.target.value.trim();
              // A first key for the chosen AI switches it on (the owner can still untick it before saving).
              setD((x) => ({ ...x, anthropicApiKey: v, enabled: x.provider === 'anthropic' && !anthropicSaved && !x.anthropicApiKey && v ? true : x.enabled }));
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
          <button type="button" onClick={() => void runTest('anthropic')} disabled={testing !== null || (!anthropicSaved && !d.anthropicApiKey)} className={testBtn} aria-label="Test Anthropic">
            {testing === 'anthropic' ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <PlugZap className="w-4 h-4" aria-hidden="true" />} Test
          </button>
        </div>
        {test?.provider === 'anthropic' && (
          <p role="status" data-testid="ai-test-result" className={`sm:col-span-2 text-xs font-semibold break-anywhere ${test.ok ? 'text-success' : 'text-danger'}`}>
            {test.text}
          </p>
        )}
      </section>

      <section className="grid grid-cols-1 sm:grid-cols-2 gap-3 rounded-xl border border-line p-3" aria-label="Google Gemini" data-testid="gemini-settings">
        <h4 className="sm:col-span-2 font-bold text-ink">Google Gemini{d.provider === 'gemini' ? ' · writes the text' : ''} · styled photos</h4>
        <p className="sm:col-span-2 text-xs text-ink-soft">
          Gemini also makes &ldquo;Style in a bedroom&rdquo; photos in the product editor: the same product placed in a bedroom, as a new photo next to your real one. Claude doesn&rsquo;t make pictures, so this needs a Gemini key even when Claude writes.
        </p>
        <div className="sm:col-span-2">
          <label className={label} htmlFor="ai-gemini-key">
            Gemini API key
          </label>
          <input
            id="ai-gemini-key"
            type="password"
            className={`${field} font-mono`}
            placeholder={geminiSaved ? `${secretsHint?.geminiApiKey ?? '••••'} saved` : 'AIza…'}
            autoComplete="off"
            spellCheck={false}
            value={d.geminiApiKey}
            maxLength={100}
            onChange={(e) => {
              const v = e.target.value.trim();
              setD((x) => ({ ...x, geminiApiKey: v, enabled: x.provider === 'gemini' && !geminiSaved && !x.geminiApiKey && v ? true : x.enabled }));
            }}
          />
          <p className="text-[11px] text-ink-muted mt-1">aistudio.google.com → Get API key → Create API key. Then press Test to choose the models. Leave blank to keep the saved key. Kept on the shop&rsquo;s server only, never in backups.</p>
        </div>
        <div className="sm:col-span-2">
          <button type="button" onClick={() => void runTest('gemini')} disabled={testing !== null || (!geminiSaved && !d.geminiApiKey)} className={`${testBtn} w-full sm:w-auto`} aria-label="Test Gemini">
            {testing === 'gemini' ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <PlugZap className="w-4 h-4" aria-hidden="true" />} Test and list models
          </button>
        </div>
        {test?.provider === 'gemini' && (
          <p role="status" data-testid="gemini-test-result" className={`sm:col-span-2 text-xs font-semibold break-anywhere ${test.ok ? 'text-success' : 'text-danger'}`}>
            {test.text}
          </p>
        )}
        <div className="min-w-0">
          <label className={label} htmlFor="ai-gemini-model">
            Writing model
          </label>
          <select id="ai-gemini-model" className={field} value={d.geminiModel} onChange={(e) => setD((x) => ({ ...x, geminiModel: e.target.value }))} disabled={!writingOptions.length}>
            {!d.geminiModel && <option value="">Press Test to list the models</option>}
            {writingOptions.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-0">
          <label className={label} htmlFor="ai-gemini-image-model">
            Image model (styled photos)
          </label>
          <select id="ai-gemini-image-model" className={field} value={d.geminiImageModel} onChange={(e) => setD((x) => ({ ...x, geminiImageModel: e.target.value }))}>
            {imageOptions.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className="space-y-1">
        <h3 className="font-bold text-ink flex items-center gap-2">
          <BedDouble className="w-4 h-4 text-gold-deep" aria-hidden="true" /> Styled photos in the shop
        </h3>
        <label className="flex items-center gap-2 text-sm font-semibold min-h-11">
          <input type="checkbox" className="w-5 h-5" checked={d.labelStyledPhotos} onChange={(e) => setD((x) => ({ ...x, labelStyledPhotos: e.target.checked }))} />
          Label styled photos for customers
        </label>
        <p className="text-xs text-ink-soft">Shows a small &ldquo;Styled image&rdquo; tag on photos made by &ldquo;Style in a bedroom&rdquo;, so customers know the room is not real. Recommended: keep it on.</p>
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => void save()} disabled={saving} className="min-h-11 px-4 rounded-xl bg-ink text-paper text-xs font-bold flex items-center gap-1.5 disabled:opacity-60">
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />} Save AI settings
        </button>
        {auto && !typingKey && autosave.bar}
        {status && (
          <p role="status" className={`text-xs font-semibold ${status.ok ? 'text-success' : 'text-danger'}`}>
            {status.text}
          </p>
        )}
      </div>
    </div>
  );
}
