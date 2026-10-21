'use client';

import React, { useMemo, useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, BedDouble, CircleAlert, CircleCheck, Copy, ExternalLink, Eye, ImagePlus, Loader2, Lock, PlugZap, Plus, RotateCcw, Trash2, X } from 'lucide-react';
import { postJson } from '@/lib/apiClient';
import { shrinkPhoto } from '@/lib/shrinkPhoto';
import { GEMINI_MODEL_ID, type AiSettings } from '@/types';
import { FAL_MODELS, FAL_MODEL_ID, OPENAI_IMAGE_MODEL_ID, PICTURE_PROVIDERS, PROVIDER_INFO, falModel, type PictureProvider } from '@/lib/pictureProviders';
import {
  DEFAULT_PICTURE_LOOK,
  DEFAULT_SCENES,
  DEFAULT_STAGING_SET,
  STAGING_FIXED_RULES,
  STAGING_LOOK_MAX,
  STAGING_MAX_SCENES,
  STAGING_NAME_MAX,
  STAGING_SCENE_MAX,
  STAGING_TRIO,
  STYLE_REFS_MAX,
  STYLE_UPLOAD_SIDE,
  angleName,
  splitAngles,
  stagingPrompt,
  usesReferences,
  type AiPicturesSettings,
  type StagingScene,
} from '@/lib/staging';

/**
 * Settings → AI pictures: everything about the pictures an AI makes of the products (the Picture
 * studio in Inventory and the editor's Photos step).
 * - The picture service: Google Gemini, OpenAI (GPT Image) or fal.ai (many models), each with its own
 *   key (shown as ••••last4 only), Test (lists the image models the key can use), the model, the
 *   setup steps and a rough cost. Writing (Settings → AI writing) stays separate.
 * - Style photos ("Make them look like these"): up to 5 of the owner's own photos, sent after the
 *   product photo so the pictures match their light, angle and mood.
 * - The scenes (name, description, style photos or the description only), added, removed and
 *   reordered (at most 16), and the default trio made with one press.
 * - The look and mood (editable), the fixed rules (read-only, always last), and a preview.
 */

const field = 'w-full px-3 py-2 rounded-xl border border-line-strong bg-surface text-ink text-base sm:text-sm focus:outline-none focus:ring-2 focus:ring-gold';
const label = 'block text-xs font-semibold text-ink-soft mb-1';
const small = 'min-h-11 px-3 rounded-xl border border-line-strong bg-surface text-ink text-xs font-semibold inline-flex items-center justify-center gap-1.5 disabled:opacity-40';
const icon = 'min-h-11 min-w-11 rounded-xl border border-line-strong bg-surface text-ink inline-flex items-center justify-center disabled:opacity-30';

const SHORT: Record<PictureProvider, string> = { gemini: 'Gemini', openai: 'OpenAI', fal: 'fal.ai' };
const KEY_FIELD: Record<PictureProvider, 'geminiApiKey' | 'openaiApiKey' | 'falApiKey'> = { gemini: 'geminiApiKey', openai: 'openaiApiKey', fal: 'falApiKey' };
const KEY_LABEL: Record<PictureProvider, string> = { gemini: 'Gemini API key', openai: 'OpenAI API key', fal: 'fal.ai key' };

type Status = 'ready' | 'no_provider' | 'no_key' | 'no_model';

/** A new scene's id: from its name, made unique. */
function newId(name: string, taken: string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'scene';
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

const modelValid = (p: PictureProvider, m: string) => (p === 'gemini' ? GEMINI_MODEL_ID.test(m) : p === 'openai' ? OPENAI_IMAGE_MODEL_ID.test(m) : FAL_MODEL_ID.test(m));

export function AiPicturesCard({
  ai,
  secretsSet,
  secretsHint,
  value,
  onSaveAi,
  onSavePictures,
}: {
  ai: AiSettings;
  secretsSet: Record<string, boolean>;
  secretsHint?: Record<string, string>;
  value: AiPicturesSettings;
  onSaveAi: (v: Partial<AiSettings>) => Promise<string | null>;
  onSavePictures: (v: AiPicturesSettings) => Promise<string | null>;
}) {
  const saved: Record<PictureProvider, boolean> = { gemini: Boolean(secretsSet.geminiApiKey), openai: Boolean(secretsSet.openaiApiKey), fal: Boolean(secretsSet.falApiKey) };
  const savedProvider: PictureProvider | '' = ai.picturesProvider || (saved.gemini ? 'gemini' : saved.openai ? 'openai' : saved.fal ? 'fal' : '');
  const savedModels: Record<PictureProvider, string> = { gemini: ai.geminiImageModel, openai: ai.openaiImageModel ?? '', fal: ai.falModel ?? FAL_MODELS[0].id };
  const [provider, setProvider] = useState<PictureProvider | ''>(savedProvider);
  const [keys, setKeys] = useState<Record<PictureProvider, string>>({ gemini: '', openai: '', fal: '' });
  const [models, setModels] = useState<Record<PictureProvider, string>>(savedModels);
  const [lists, setLists] = useState<Partial<Record<PictureProvider, string[]>>>({});
  const [labelStyled, setLabelStyled] = useState(ai.labelStyledPhotos);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ provider: PictureProvider; ok: boolean; text: string } | null>(null);
  const [savingKey, setSavingKey] = useState(false);
  const [keyStatus, setKeyStatus] = useState<{ ok: boolean; text: string } | null>(null);

  const [scenes, setScenes] = useState<StagingScene[]>(value.scenes?.length ? value.scenes : DEFAULT_SCENES);
  const [trio, setTrio] = useState<string[]>(value.defaultSet?.length ? value.defaultSet : DEFAULT_STAGING_SET);
  const [look, setLook] = useState(value.look?.trim() ? value.look : DEFAULT_PICTURE_LOOK);
  const [references, setReferences] = useState<string[]>(value.references ?? []);
  const [useRefs, setUseRefs] = useState(value.useReferences !== false);
  const [autoCreate, setAutoCreate] = useState(value.autoCreate !== false);
  const [photoOrder, setPhotoOrder] = useState<AiPicturesSettings['photoOrder']>(value.photoOrder ?? 'styled-first');
  const [uploading, setUploading] = useState(0);
  const [refStatus, setRefStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [preview, setPreview] = useState(false);
  const [copied, setCopied] = useState(false);
  const [savingScenes, setSavingScenes] = useState(false);
  const [scenesStatus, setScenesStatus] = useState<{ ok: boolean; text: string } | null>(null);

  const p = provider;
  const model = p ? models[p] : '';
  const tested = p && test?.provider === p && test.ok;
  const keyWorks = p ? saved[p] || Boolean(tested && keys[p]) : false;
  const modelGood = p ? modelValid(p, model) && (!lists[p] || p === 'fal' || lists[p]!.includes(model)) : false;
  const unsaved = p !== savedProvider || (p && model !== savedModels[p]) || (p && keys[p]);
  const status: Status = !p ? 'no_provider' : !keyWorks ? 'no_key' : !modelGood || unsaved ? 'no_model' : 'ready';
  const statusText = status === 'no_provider' ? 'Choose a picture service' : status === 'no_key' ? `Needs ${p === 'openai' ? 'an' : 'a'} ${PROVIDER_INFO[p as PictureProvider].name.replace(/ \(.*\)$/, '')} key` : status === 'no_model' ? 'Key works, choose an image model' : `Ready (${SHORT[p as PictureProvider]} ${model})`;

  const runTest = async () => {
    if (!p) return;
    setTesting(true);
    setTest(null);
    const typed = keys[p].trim();
    const { ok, data } = await postJson<{ message?: string; models?: { image: string[]; suggested: { image: string } } }>('/api/admin/ai/test', { settings: { provider: p, ...(typed ? { [KEY_FIELD[p]]: typed } : {}) } });
    setTesting(false);
    if (!ok || !data.models) return setTest({ provider: p, ok: false, text: data.message || 'The test did not work.' });
    const m = data.models;
    setLists((l) => ({ ...l, [p]: m.image }));
    if (p !== 'fal') setModels((x) => ({ ...x, [p]: x[p] && m.image.includes(x[p]) ? x[p] : m.suggested.image }));
    if (!m.image.length) return setTest({ provider: p, ok: false, text: `The key works, but ${SHORT[p]} offers it no image models. Check the key’s account (billing may need to be switched on).` });
    setTest({ provider: p, ok: true, text: `Works: ${SHORT[p]} offers ${m.image.length} image ${m.image.length === 1 ? 'model' : 'models'} to this key. Choose one and save.` });
  };

  const saveKey = async () => {
    if (!p) return;
    setSavingKey(true);
    setKeyStatus(null);
    const modelField = p === 'gemini' ? 'geminiImageModel' : p === 'openai' ? 'openaiImageModel' : 'falModel';
    const problem = await onSaveAi({ picturesProvider: p, ...(keys[p].trim() ? { [KEY_FIELD[p]]: keys[p].trim() } : {}), [modelField]: models[p], labelStyledPhotos: labelStyled });
    setSavingKey(false);
    if (!problem) setKeys((k) => ({ ...k, [p]: '' }));
    setKeyStatus(problem ? { ok: false, text: problem } : { ok: true, text: `Saved: ${SHORT[p]} makes your pictures. Make them in Inventory → a product → Make pictures.` });
  };

  const settings: AiPicturesSettings = { look: look.trim() === DEFAULT_PICTURE_LOOK ? '' : look.trim(), scenes, defaultSet: trio.filter((t) => scenes.some((s) => s.id === t)), references, useReferences: useRefs, autoCreate, photoOrder };

  const saveScenes = async () => {
    setSavingScenes(true);
    setScenesStatus(null);
    const problem = await onSavePictures(settings);
    setSavingScenes(false);
    setScenesStatus(problem ? { ok: false, text: problem } : { ok: true, text: 'Saved. The studio offers these scenes now.' });
  };

  const patch = (i: number, q: Partial<StagingScene>) => setScenes((all) => all.map((s, j) => (j === i ? { ...s, ...q } : s)));
  const move = <T,>(list: T[], i: number, d: -1 | 1): T[] => {
    const j = i + d;
    if (j < 0 || j >= list.length) return list;
    const next = [...list];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  };
  const remove = (i: number) => {
    const gone = scenes[i];
    setScenes((all) => all.filter((_, j) => j !== i));
    setTrio((t) => t.filter((x) => x !== gone.id));
  };
  const addScene = () => setScenes((all) => [...all, { id: newId(`scene ${all.length + 1}`, all.map((s) => s.id)), name: '', scene: '' }]);
  const toggleTrio = (id: string) => setTrio((t) => (t.includes(id) ? t.filter((x) => x !== id) : t.length >= STAGING_TRIO ? t : [...t, id]));
  const resetScenes = () => {
    setScenes(DEFAULT_SCENES);
    setTrio(DEFAULT_STAGING_SET);
    setScenesStatus({ ok: true, text: 'Back to the shop’s scenes. Press Save to keep them.' });
  };

  /** Style photos: each shrunk to about 1,024 px here, then checked and stored on the server. */
  const uploadRefs = async (files: FileList | null) => {
    const list = [...(files ?? [])].slice(0, STYLE_REFS_MAX - references.length);
    if (!list.length) return setRefStatus({ ok: false, text: `At most ${STYLE_REFS_MAX} style photos: remove one first.` });
    setRefStatus(null);
    setUploading(list.length);
    const added: string[] = [];
    let problem = '';
    for (const f of list) {
      try {
        const image = await shrinkPhoto(f, STYLE_UPLOAD_SIDE);
        const { ok, data } = await postJson<{ url?: string; message?: string }>('/api/admin/ai/style-photo', { image });
        if (ok && data.url) added.push(data.url);
        else problem = data.message || 'A photo could not be added.';
      } catch (err) {
        problem = (err as Error).message || 'A photo could not be read.';
      }
      setUploading((n) => n - 1);
    }
    setReferences((r) => [...r, ...added.filter((u) => !r.includes(u))].slice(0, STYLE_REFS_MAX));
    setRefStatus(problem ? { ok: false, text: problem } : { ok: true, text: `${added.length === 1 ? 'Added' : `${added.length} added`}. Press “Save scenes and prompt” to use ${added.length === 1 ? 'it' : 'them'}.` });
  };

  const firstScene = scenes.find((s) => trio.includes(s.id)) ?? scenes[0];
  const refsInPreview = usesReferences({ references, useReferences: useRefs }, firstScene) ? Math.min(references.length, p ? (p === 'fal' ? falModel(model).maxImages : 6) - 1 : references.length) : 0;
  // Numbered angles in the prompt: one picture each, one request each (the list never goes in a request).
  const split = useMemo(() => splitAngles(look.trim() || DEFAULT_PICTURE_LOOK), [look]);
  const assembled = useMemo(
    () =>
      split.angles.length
        ? stagingPrompt(split.angles[0], '', '4:5', { title: 'Indigo Chevron Hand Block Print Bed Set', colors: ['Indigo', 'Ivory'] }, split.shared || DEFAULT_PICTURE_LOOK, refsInPreview, { angle: split.angles[0] })
        : stagingPrompt(firstScene?.scene || '(the scene)', '', '4:5', { title: 'Indigo Chevron Hand Block Print Bed Set', colors: ['Indigo', 'Ivory'] }, look.trim() || DEFAULT_PICTURE_LOOK, refsInPreview),
    [firstScene?.scene, split, look, refsInPreview]
  );
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(assembled);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const options = p && p !== 'fal' ? [...(lists[p] ?? [])] : [];
  if (p && p !== 'fal' && model && !options.includes(model)) options.unshift(model);
  const curated = FAL_MODELS.some((m) => m.id === models.fal);
  const writer = ai.provider === 'deepseek' ? 'DeepSeek' : ai.provider === 'gemini' ? 'Gemini' : 'Claude';

  return (
    <div className="space-y-5 text-sm" data-testid="ai-pictures">
      <p className="text-sm text-ink">Pictures are made by the picture service you choose here: Google Gemini, OpenAI or fal.ai (DeepSeek and Claude can&rsquo;t make pictures). Your writing AI can stay {writer}.</p>
      <p role="status" data-testid="pictures-status" className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold max-w-full break-anywhere ${status === 'ready' ? 'bg-success-soft text-success' : 'bg-warning-soft text-warning'}`}>
        {status === 'ready' ? <CircleCheck className="w-4 h-4 shrink-0" aria-hidden="true" /> : <CircleAlert className="w-4 h-4 shrink-0" aria-hidden="true" />} {statusText}
      </p>

      <section className="space-y-3 rounded-xl border border-line p-3" aria-labelledby="pictures-key-h" data-testid="pictures-service">
        <h3 id="pictures-key-h" className="font-bold text-ink">
          Picture service
        </h3>
        <fieldset className="space-y-2">
          <legend className="sr-only">Who makes the pictures</legend>
          {PICTURE_PROVIDERS.map((id) => (
            <label key={id} className={`flex items-start gap-2 rounded-xl border px-3 py-2 cursor-pointer min-h-11 ${p === id ? 'border-ink bg-sand' : 'border-line-strong bg-surface'}`}>
              <input type="radio" name="pictures-provider" className="w-5 h-5 mt-0.5 shrink-0" checked={p === id} onChange={() => setProvider(id)} aria-label={PROVIDER_INFO[id].name} />
              <span className="min-w-0">
                <span className="block font-semibold text-ink">
                  {PROVIDER_INFO[id].name}
                  {saved[id] ? <span className="ml-1 text-xs font-normal text-success">key saved</span> : null}
                </span>
                <span className="block text-xs text-ink-soft">{PROVIDER_INFO[id].cost}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {p && (
          <div className="space-y-3" data-testid={`pictures-${p}`}>
            {!saved[p] && (
              <div className="space-y-2" data-testid="pictures-key-steps">
                <ol className="list-decimal pl-5 space-y-1 text-sm text-ink">
                  {PROVIDER_INFO[p].steps.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ol>
                <a href={PROVIDER_INFO[p].keyUrl} target="_blank" rel="noopener noreferrer" className="min-h-12 w-full sm:w-auto px-4 rounded-xl bg-ink text-paper font-bold inline-flex items-center justify-center gap-2 text-center">
                  <ExternalLink className="w-5 h-5 text-gold shrink-0" aria-hidden="true" /> Create API key ({PROVIDER_INFO[p].keyUrlLabel})
                </a>
              </div>
            )}
            {PROVIDER_INFO[p].note && <p className="text-xs text-ink-soft">{PROVIDER_INFO[p].note}</p>}
            <div>
              <label className={label} htmlFor={`pictures-key-${p}`}>
                {KEY_LABEL[p]}
              </label>
              <input
                id={`pictures-key-${p}`}
                type="password"
                className={`${field} min-h-11 font-mono`}
                placeholder={saved[p] ? `${secretsHint?.[KEY_FIELD[p]] ?? '••••'} saved` : PROVIDER_INFO[p].keyPlaceholder}
                autoComplete="off"
                spellCheck={false}
                value={keys[p]}
                maxLength={300}
                onChange={(e) => setKeys((k) => ({ ...k, [p]: e.target.value.trim() }))}
              />
              <p className="text-[11px] text-ink-muted mt-1">
                {saved[p] ? 'Leave blank to keep the saved key. ' : ''}Kept on the shop&rsquo;s server only: never shown again, never in backups or logs.{p === 'gemini' ? ' The same key also works for Gemini writing.' : ''}
              </p>
            </div>
            <button type="button" onClick={() => void runTest()} disabled={testing || (!saved[p] && !keys[p])} className={`${small} w-full sm:w-auto`} aria-label={`Test the ${SHORT[p]} key`}>
              {testing ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <PlugZap className="w-4 h-4" aria-hidden="true" />} Test and list image models
            </button>
            {test?.provider === p && (
              <p role="status" data-testid="pictures-test-result" className={`text-xs font-semibold break-anywhere ${test.ok ? 'text-success' : 'text-danger'}`}>
                {test.text}
              </p>
            )}
            {p === 'fal' ? (
              <fieldset className="space-y-2" data-testid="fal-models">
                <legend className="text-xs font-semibold text-ink-soft mb-1">fal model (edit models that keep your product)</legend>
                {FAL_MODELS.map((m) => (
                  <label key={m.id} className={`flex items-start gap-2 rounded-xl border px-3 py-2 cursor-pointer ${models.fal === m.id ? 'border-ink bg-sand' : 'border-line'}`}>
                    <input type="radio" name="fal-model" className="w-5 h-5 mt-0.5 shrink-0" checked={models.fal === m.id} onChange={() => setModels((x) => ({ ...x, fal: m.id }))} aria-label={m.name} />
                    <span className="min-w-0">
                      <span className="block font-semibold text-ink break-words">{m.name}</span>
                      <span className="block text-xs text-ink-soft break-words">
                        {m.price} · up to {m.maxImages - 1} style {m.maxImages - 1 === 1 ? 'photo' : 'photos'} · {m.note}
                      </span>
                      <span className="block text-[11px] text-ink-muted font-mono break-all">{m.id}</span>
                    </span>
                  </label>
                ))}
                <div>
                  <label className={label} htmlFor="fal-model-id">
                    Or any fal model id
                  </label>
                  <input id="fal-model-id" className={`${field} min-h-11 font-mono`} value={curated ? '' : models.fal} placeholder="e.g. fal-ai/nano-banana/edit" maxLength={120} spellCheck={false} onChange={(e) => setModels((x) => ({ ...x, fal: e.target.value.trim().toLowerCase() || FAL_MODELS[0].id }))} />
                  {!modelValid('fal', models.fal) && <p className="text-xs text-danger mt-1">A fal model id looks like owner/model, e.g. fal-ai/flux-2/edit.</p>}
                </div>
              </fieldset>
            ) : (
              <div className="min-w-0">
                <label className={label} htmlFor="pictures-image-model">
                  Image model
                </label>
                <select id="pictures-image-model" className={`${field} min-h-11`} value={model} onChange={(e) => setModels((x) => ({ ...x, [p]: e.target.value }))}>
                  {!model && <option value="">Press Test to list the models</option>}
                  {options.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        )}
        <label className="flex items-center gap-2 text-sm font-semibold min-h-11">
          <input type="checkbox" className="w-5 h-5" checked={labelStyled} onChange={(e) => setLabelStyled(e.target.checked)} />
          Label styled photos for customers
        </label>
        <p className="text-xs text-ink-soft -mt-2">Shows a small &ldquo;Styled image&rdquo; tag on AI pictures in the shop, so customers know the room is not real. Recommended: keep it on.</p>
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => void saveKey()} disabled={savingKey || !p || (!saved[p] && !keys[p])} className="min-h-11 px-4 rounded-xl bg-ink text-paper text-xs font-bold inline-flex items-center gap-1.5 disabled:opacity-60">
            {savingKey && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />} Save key and model
          </button>
          {keyStatus && (
            <p role="status" className={`text-xs font-semibold ${keyStatus.ok ? 'text-success' : 'text-danger'}`}>
              {keyStatus.text}
            </p>
          )}
        </div>
      </section>

      <section className="space-y-3 rounded-xl border border-line p-3" aria-labelledby="pictures-refs-h" data-testid="pictures-references">
        <h3 id="pictures-refs-h" className="font-bold text-ink flex items-center gap-2">
          <ImagePlus className="w-4 h-4 text-gold-deep" aria-hidden="true" /> Make them look like these ({references.length} of {STYLE_REFS_MAX})
        </h3>
        <p className="text-xs text-ink-soft">Add 2 or 3 photos whose look you love: your own past shoots, or rooms you like. Every new picture copies their light, colours, camera angle and mood, with your new bed linen in it. Their bedding, people and text are never copied.</p>
        {references.length > 0 && (
          <ol className="flex flex-wrap gap-3" aria-label="Style photos">
            {references.map((src, i) => (
              <li key={src} className="w-28 space-y-1" data-testid="style-photo">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={src} alt={`Style photo ${i + 1}`} className="w-28 aspect-[4/5] object-cover rounded-xl border border-line" />
                <div className="grid grid-cols-3 gap-1">
                  <button type="button" className={icon} onClick={() => setReferences((r) => move(r, i, -1))} disabled={i === 0} aria-label={`Move style photo ${i + 1} earlier`}>
                    <ArrowLeft className="w-4 h-4" aria-hidden="true" />
                  </button>
                  <button type="button" className={icon} onClick={() => setReferences((r) => move(r, i, 1))} disabled={i === references.length - 1} aria-label={`Move style photo ${i + 1} later`}>
                    <ArrowRight className="w-4 h-4" aria-hidden="true" />
                  </button>
                  <button type="button" className={`${icon} text-danger`} onClick={() => setReferences((r) => r.filter((x) => x !== src))} aria-label={`Remove style photo ${i + 1}`}>
                    <X className="w-4 h-4" aria-hidden="true" />
                  </button>
                </div>
              </li>
            ))}
          </ol>
        )}
        <label className={`${small} cursor-pointer w-full sm:w-auto focus-within:ring-2 focus-within:ring-gold ${references.length >= STYLE_REFS_MAX ? 'opacity-40 pointer-events-none' : ''}`}>
          {uploading ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Plus className="w-4 h-4" aria-hidden="true" />} {uploading ? 'Adding…' : 'Add style photos'}
          <input type="file" multiple accept="image/png,image/jpeg,image/webp" className="sr-only" aria-label="Upload style photos" disabled={references.length >= STYLE_REFS_MAX} onChange={(e) => void uploadRefs(e.target.files).then(() => (e.target.value = ''))} />
        </label>
        {refStatus && (
          <p role="status" className={`text-xs font-semibold ${refStatus.ok ? 'text-success' : 'text-danger'}`}>
            {refStatus.text}
          </p>
        )}
        <label className="flex items-center gap-2 text-sm font-semibold min-h-11">
          <input type="checkbox" className="w-5 h-5" checked={useRefs} onChange={(e) => setUseRefs(e.target.checked)} />
          Use my style photos (when there are some)
        </label>
      </section>

      <section className="space-y-3 rounded-xl border border-line p-3" aria-labelledby="pictures-scenes-h" data-testid="pictures-scenes">
        <div className="flex flex-wrap items-center gap-2">
          <h3 id="pictures-scenes-h" className="font-bold text-ink flex items-center gap-2 flex-1 min-w-0">
            <BedDouble className="w-4 h-4 text-gold-deep" aria-hidden="true" /> Scenes ({scenes.length} of {STAGING_MAX_SCENES})
          </h3>
          <button type="button" onClick={resetScenes} className={small}>
            <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" /> Reset to the shop&rsquo;s scenes
          </button>
        </div>
        <p className="text-xs text-ink-soft">Where the studio shows your product. Tick up to {STAGING_TRIO} to make with one press (the default trio). Describe the setting only: the product always stays as photographed.</p>
        <ol className="space-y-3">
          {scenes.map((s, i) => (
            <li key={s.id} className="rounded-xl border border-line p-3 space-y-2" data-testid="pictures-scene" aria-label={s.name || `Scene ${i + 1}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-bold text-ink-muted w-6">{i + 1}.</span>
                <label className="flex items-center gap-2 text-xs font-semibold min-h-11 flex-1 min-w-0">
                  <input type="checkbox" className="w-5 h-5 shrink-0" checked={trio.includes(s.id)} disabled={!trio.includes(s.id) && trio.length >= STAGING_TRIO} onChange={() => toggleTrio(s.id)} aria-label={`Make with one press: ${s.name || `scene ${i + 1}`}`} />
                  Make with one press
                </label>
                <button type="button" className={icon} onClick={() => setScenes((all) => move(all, i, -1))} disabled={i === 0} aria-label={`Move ${s.name || `scene ${i + 1}`} up`}>
                  <ArrowUp className="w-4 h-4" aria-hidden="true" />
                </button>
                <button type="button" className={icon} onClick={() => setScenes((all) => move(all, i, 1))} disabled={i === scenes.length - 1} aria-label={`Move ${s.name || `scene ${i + 1}`} down`}>
                  <ArrowDown className="w-4 h-4" aria-hidden="true" />
                </button>
                <button type="button" className={`${icon} text-danger`} onClick={() => remove(i)} disabled={scenes.length <= 1} aria-label={`Remove ${s.name || `scene ${i + 1}`}`}>
                  <Trash2 className="w-4 h-4" aria-hidden="true" />
                </button>
              </div>
              <div>
                <label className={label} htmlFor={`scene-name-${s.id}`}>
                  Name
                </label>
                <input id={`scene-name-${s.id}`} className={`${field} min-h-11`} value={s.name} maxLength={STAGING_NAME_MAX} onChange={(e) => patch(i, { name: e.target.value })} placeholder="e.g. Majlis guest room" />
              </div>
              <div>
                <label className={label} htmlFor={`scene-text-${s.id}`}>
                  Scene ({s.scene.length} / {STAGING_SCENE_MAX})
                </label>
                <textarea id={`scene-text-${s.id}`} rows={3} className={field} value={s.scene} maxLength={STAGING_SCENE_MAX} onChange={(e) => patch(i, { scene: e.target.value })} placeholder="e.g. show the bedding neatly made on a bed in a calm guest room with a carved wooden headboard and soft daylight" />
              </div>
              <label className="flex items-center gap-2 text-xs font-semibold min-h-11">
                <input type="checkbox" className="w-5 h-5 shrink-0" checked={s.style !== 'scene'} onChange={(e) => patch(i, { style: e.target.checked ? undefined : 'scene' })} aria-label={`Use my style photos: ${s.name || `scene ${i + 1}`}`} />
                Use my style photos (untick: this scene description only)
              </label>
            </li>
          ))}
        </ol>
        <button type="button" onClick={addScene} disabled={scenes.length >= STAGING_MAX_SCENES} className={small}>
          <Plus className="w-4 h-4" aria-hidden="true" /> Add a scene
        </button>
      </section>

      <section className="space-y-3 rounded-xl border border-line p-3" aria-labelledby="pictures-new-h" data-testid="pictures-new-products">
        <h3 id="pictures-new-h" className="font-bold text-ink">
          New products
        </h3>
        <label className="flex items-start gap-3 min-h-11">
          <input type="checkbox" className="mt-1 w-5 h-5 shrink-0" checked={autoCreate} onChange={(e) => setAutoCreate(e.target.checked)} />
          <span className="text-sm text-ink">
            <span className="font-semibold">Write and make pictures for new products by themselves</span>
            <span className="block text-xs text-ink-soft">Add a product with just its photo, price and stock: the name, descriptions and AI pictures are made in the background and it goes in the shop when ready. Edit anything later.</span>
          </span>
        </label>
        <fieldset>
          <legend className="text-xs font-semibold text-ink-soft mb-1">Where AI pictures go</legend>
          <div className="flex flex-col gap-1">
            <label className="flex items-center gap-3 min-h-11 text-sm text-ink">
              <input type="radio" name="photo-order" className="w-5 h-5" checked={photoOrder === 'styled-first'} onChange={() => setPhotoOrder('styled-first')} /> First, with your own photo last
            </label>
            <label className="flex items-center gap-3 min-h-11 text-sm text-ink">
              <input type="radio" name="photo-order" className="w-5 h-5" checked={photoOrder === 'photo-first'} onChange={() => setPhotoOrder('photo-first')} /> After your own photo (it stays the cover)
            </label>
          </div>
        </fieldset>
        <p className="text-[11px] text-ink-muted">Saved with &ldquo;Save scenes and prompt&rdquo; below.</p>
      </section>

      <section className="space-y-3 rounded-xl border border-line p-3" aria-labelledby="pictures-look-h" data-testid="pictures-look">
        <h3 id="pictures-look-h" className="font-bold text-ink">
          The picture prompt
        </h3>
        <div>
          <div className="flex flex-wrap items-end justify-between gap-2 mb-1">
            <label className="block text-xs font-semibold text-ink-soft" htmlFor="pictures-look-text">
              Look and mood (every picture)
            </label>
            <button type="button" className={small} onClick={() => setLook(DEFAULT_PICTURE_LOOK)} disabled={look === DEFAULT_PICTURE_LOOK} aria-label="Reset the look and mood to the shop's default">
              <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" /> Reset to the shop&rsquo;s default
            </button>
          </div>
          <textarea id="pictures-look-text" rows={6} className={field} value={look} maxLength={STAGING_LOOK_MAX} onChange={(e) => setLook(e.target.value)} />
          <p className="text-[11px] text-ink-muted mt-1">
            {look.length} / {STAGING_LOOK_MAX.toLocaleString('en-GB')} characters. The default asks for real-looking photographs: window daylight, real creases, true scale, a 35–50 mm lens.
          </p>
          {split.angles.length > 0 && (
            <div className="mt-2 rounded-xl border border-success-line bg-success-soft p-3 text-xs text-ink" data-testid="pictures-angles">
              <p className="font-bold">
                {split.angles.length} angles found: {split.angles.length} pictures, one request each, one after another
              </p>
              <ol className="list-decimal pl-5 mt-1 space-y-0.5">
                {split.angles.map((a, i) => (
                  <li key={i}>{angleName(a, i).replace(/^Angle \d+: /, '')}</li>
                ))}
              </ol>
              <p className="mt-1 text-ink-soft">The rest of the prompt goes with every picture, and the first picture is sent with the next ones so the room stays the same. One press in the studio (and every new product) makes these instead of the scenes.</p>
            </div>
          )}
        </div>
        <div className="space-y-1 rounded-xl border border-line bg-sand p-3" data-testid="pictures-fixed">
          <p className="text-xs font-bold text-ink flex items-center gap-1.5">
            <Lock className="w-3.5 h-3.5" aria-hidden="true" /> Fixed rules: always sent last, can&rsquo;t be removed
          </p>
          <p className="text-xs text-ink">These rules come first, whatever is written above:</p>
          <ul className="text-xs text-ink-soft space-y-0.5">
            {STAGING_FIXED_RULES.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => void saveScenes()} disabled={savingScenes || uploading > 0} className="min-h-11 px-4 rounded-xl bg-ink text-paper text-xs font-bold inline-flex items-center gap-1.5 disabled:opacity-60">
            {savingScenes && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />} Save scenes and prompt
          </button>
          <button type="button" onClick={() => setPreview((v) => !v)} className={small} aria-expanded={preview} aria-controls="pictures-preview">
            <Eye className="w-3.5 h-3.5" aria-hidden="true" /> {preview ? 'Hide preview' : 'Preview'}
          </button>
          {scenesStatus && (
            <p role="status" className={`text-xs font-semibold ${scenesStatus.ok ? 'text-success' : 'text-danger'}`}>
              {scenesStatus.text}
            </p>
          )}
        </div>
        {preview && (
          <div id="pictures-preview" className="space-y-2" data-testid="pictures-preview">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs text-ink-soft flex-1 min-w-0">
                The whole prompt for &ldquo;{split.angles.length ? angleName(split.angles[0], 0) : firstScene?.name || 'the first scene'}&rdquo; and a sample product, sent with the product&rsquo;s photo{refsInPreview ? ` and ${refsInPreview} style ${refsInPreview === 1 ? 'photo' : 'photos'}` : ''}. Read-only.
              </p>
              <button type="button" onClick={() => void copy()} className={small}>
                <Copy className="w-3.5 h-3.5" aria-hidden="true" /> {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <pre tabIndex={0} aria-label="The whole picture prompt" className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words rounded-xl border border-line bg-surface p-3 text-xs text-ink font-mono">
              {assembled}
            </pre>
          </div>
        )}
      </section>
    </div>
  );
}
