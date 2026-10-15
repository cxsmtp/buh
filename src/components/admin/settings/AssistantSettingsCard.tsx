'use client';

import React, { useMemo, useState } from 'react';
import { Bot, Download, Loader2, Plus, Trash2, Upload } from 'lucide-react';
import type { AssistantEntry, AssistantSettings, BedProfileMeasurement } from '@/types';
import { useAutoSave, type AutoSaveHooks } from './useAutoSave';
import { reply } from '@/lib/assistant';

/**
 * Settings → Chat assistant. Its "memory" is the list of answers below: it
 * replies with one of them when a question matches its keywords, answers size
 * questions from the size presets, and hands anything else to you. It never
 * makes up an answer (or a discount). The memory can be downloaded as a file
 * and loaded back, e.g. to keep a copy or to edit it on a computer.
 */

const field = 'w-full px-3 py-2 rounded-xl border border-stone-300 bg-white text-stone-900 text-sm focus:outline-none focus:ring-2 focus:ring-[#c5a059]';
const label = 'block text-xs font-semibold text-stone-700 mb-1';

const newId = (entries: AssistantEntry[]) => {
  let n = entries.length + 1;
  while (entries.some((e) => e.id === `answer-${n}`)) n++;
  return `answer-${n}`;
};

export function AssistantSettingsCard({ value, sizes, onSave, auto }: { value: AssistantSettings; sizes: BedProfileMeasurement[]; onSave: (v: AssistantSettings) => Promise<string | null>; auto?: AutoSaveHooks }) {
  const [d, setD] = useState<AssistantSettings>(value);
  // Answers being written (question or answer still empty) wait until they're complete.
  const complete = { ...d, entries: d.entries.filter((e) => e.question.trim() && e.answer.trim()) };
  const autosave = useAutoSave({ settingsKey: 'assistant', value: complete, enabled: Boolean(auto), ...auto });
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [trial, setTrial] = useState('');
  const set = <K extends keyof AssistantSettings>(k: K, v: AssistantSettings[K]) => setD((x) => ({ ...x, [k]: v }));
  const setEntry = (i: number, patch: Partial<AssistantEntry>) => setD((x) => ({ ...x, entries: x.entries.map((e, j) => (j === i ? { ...e, ...patch } : e)) }));

  const answer = useMemo(() => (trial.trim() ? reply(trial, d, sizes) : null), [trial, d, sizes]);

  const save = async () => {
    autosave.cancel();
    setSaving(true);
    setStatus(null);
    const problem = await onSave(d);
    setSaving(false);
    setStatus(problem ? { ok: false, text: problem } : { ok: true, text: 'Saved. The chat uses it straight away.' });
  };

  const download = () => {
    const blob = new Blob([JSON.stringify({ kind: 'buh-assistant-memory', version: 1, savedAt: new Date().toISOString(), entries: d.entries }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'chat-assistant-memory.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const load = async (file: File | undefined) => {
    if (!file) return;
    try {
      if (file.size > 512 * 1024) throw new Error('too big');
      const parsed = JSON.parse(await file.text()) as { entries?: unknown };
      const list = Array.isArray(parsed) ? parsed : parsed.entries;
      if (!Array.isArray(list)) throw new Error('no entries');
      const entries = list.slice(0, 200).map((e, i) => {
        const o = (e ?? {}) as Record<string, unknown>;
        return {
          id: typeof o.id === 'string' ? o.id : `answer-${i + 1}`,
          question: String(o.question ?? ''),
          keywords: Array.isArray(o.keywords) ? o.keywords.map(String) : String(o.keywords ?? '').split(','),
          answer: String(o.answer ?? ''),
        };
      });
      set('entries', entries);
      setStatus({ ok: true, text: `Loaded ${entries.length} answers from the file. Check them, then Save.` });
    } catch {
      setStatus({ ok: false, text: 'That file is not a chat memory file (download one first to see the format).' });
    }
  };

  return (
    <div className="space-y-5 text-sm">
      <section className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="flex items-center gap-2 text-xs sm:col-span-2">
          <input type="checkbox" checked={d.enabled} onChange={(e) => set('enabled', e.target.checked)} />
          Show the chat on the shop (the “Help” button)
        </label>
        <div>
          <label className={label} htmlFor="as-name">Its name</label>
          <input id="as-name" className={field} value={d.name} maxLength={40} onChange={(e) => set('name', e.target.value)} />
        </div>
        <div>
          <label className={label} htmlFor="as-wait">If nobody replies, reassure the customer after</label>
          <select id="as-wait" className={field} value={d.waitSeconds} onChange={(e) => set('waitSeconds', Number(e.target.value))}>
            {[60, 120, 150, 180, 300, 600].map((s) => (
              <option key={s} value={s}>{s < 120 ? `${s} seconds` : `${s / 60} minutes`}</option>
            ))}
          </select>
        </div>
        <div className="sm:col-span-2">
          <label className={label} htmlFor="as-greet">Greeting</label>
          <textarea id="as-greet" className={field} rows={2} value={d.greeting} maxLength={500} onChange={(e) => set('greeting', e.target.value)} />
        </div>
        <label className="flex items-center gap-2 text-xs sm:col-span-2">
          <input type="checkbox" checked={d.answerSizes} onChange={(e) => set('answerSizes', e.target.checked)} />
          Answer size and measurement questions from Settings → Catalogue (always up to date)
        </label>
      </section>

      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-bold text-[#0f1c2e]">What it knows ({d.entries.length})</h3>
          <div className="ml-auto flex flex-wrap gap-1.5 text-xs">
            <button type="button" onClick={download} className="px-2.5 py-1.5 rounded-lg border border-stone-300 font-semibold inline-flex items-center gap-1"><Download className="w-3.5 h-3.5" /> Download memory</button>
            <label className="px-2.5 py-1.5 rounded-lg border border-stone-300 font-semibold inline-flex items-center gap-1 cursor-pointer">
              <Upload className="w-3.5 h-3.5" /> Load from file
              <input type="file" accept="application/json,.json" className="sr-only" onChange={(e) => void load(e.target.files?.[0])} />
            </label>
          </div>
        </div>
        <p className="text-xs text-stone-500">
          It replies with an answer when the question contains its keywords. Anything it has no answer for goes to you (Admin Hub → Chats, and by email). It never invents prices or discounts: only what you write here.
        </p>
        <ol className="space-y-2">
          {d.entries.map((e, i) => (
            <li key={i} className="rounded-2xl border border-stone-200 bg-white p-3 space-y-2">
              <div className="flex items-center gap-2">
                <input aria-label={`Answer ${i + 1}: question`} className={`${field} font-semibold`} value={e.question} maxLength={200} placeholder="The question, e.g. Do you deliver to Oman?" onChange={(ev) => setEntry(i, { question: ev.target.value })} />
                <button type="button" onClick={() => set('entries', d.entries.filter((_, j) => j !== i))} className="p-2 rounded-lg border border-red-200 text-red-700 shrink-0" aria-label={`Remove answer ${i + 1}`}>
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
              <input aria-label={`Answer ${i + 1}: keywords`} className={`${field} text-xs`} value={e.keywords.join(', ')} placeholder="Keywords, separated by commas: oman, gcc, abroad" onChange={(ev) => setEntry(i, { keywords: ev.target.value.split(',').map((k) => k.trimStart()) })} />
              <textarea aria-label={`Answer ${i + 1}: answer`} className={field} rows={3} value={e.answer} maxLength={1500} placeholder="The answer the customer sees" onChange={(ev) => setEntry(i, { answer: ev.target.value })} />
            </li>
          ))}
        </ol>
        <button type="button" onClick={() => set('entries', [...d.entries, { id: newId(d.entries), question: '', keywords: [], answer: '' }])} className="px-3 py-2 rounded-xl border border-dashed border-stone-400 text-xs font-bold inline-flex items-center gap-1.5">
          <Plus className="w-4 h-4" /> Add an answer
        </button>
      </section>

      <section className="rounded-2xl bg-stone-50 border border-stone-200 p-3 space-y-2">
        <label className={label} htmlFor="as-try">Try it (with the answers above, before saving)</label>
        <input id="as-try" className={field} value={trial} placeholder="e.g. What size is a king sheet?" onChange={(e) => setTrial(e.target.value)} />
        {answer && (
          <div className="text-xs flex gap-2">
            <Bot className="w-4 h-4 text-[#c5a059] shrink-0 mt-0.5" />
            <p className="whitespace-pre-wrap" role="status">
              {answer.kind === 'handover'
                ? answer.reason === 'asked'
                  ? '→ Hands over to you (they asked for a person).'
                  : '→ Hands over to you (no answer matches; add one above if it comes up often).'
                : answer.text}
            </p>
          </div>
        )}
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => void save()} disabled={saving} className="px-4 py-2 rounded-xl bg-[#0f1c2e] text-white text-xs font-bold flex items-center gap-1.5 disabled:opacity-60">
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Save chat assistant
        </button>
        {auto && autosave.bar}
        {status && <p role="status" className={`text-xs font-semibold ${status.ok ? 'text-emerald-700' : 'text-red-700'}`}>{status.text}</p>}
      </div>
    </div>
  );
}
