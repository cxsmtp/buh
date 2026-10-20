'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarClock, ExternalLink, Loader2, Search } from 'lucide-react';
import { getJson, sendJson } from '@/lib/apiClient';
import { DESCRIPTION_MAX, TITLE_MAX } from '@/lib/seo/text';
import { MAX_LEAD_DAYS, MIN_LEAD_DAYS, SEO_LIMITS, type FestivalPageMode, type SeoOverview, type SeoPageText, type SeoPageView, type SeoSettings } from '@/lib/seo/types';
import { CharCount, SnippetPreview } from '../SnippetPreview';

/**
 * Settings → Search (SEO): what Google sees and how to steer it.
 *
 * - Festival schedule: each festival's gift page for the next 12 months, when it goes live and
 *   ends, and the owner's switch (automatic / off / always live) and own words.
 * - What Google sees: every page (home, categories, festivals, products) as a Google result, with
 *   its status and problems; Edit changes the title and description (and a landing page's heading
 *   and introduction). Empty fields are automatic; Reset goes back to them.
 * - Health checks, the sitemap, a sample of the structured data, the verification codes, IndexNow
 *   and the Search Console steps.
 */

const field = 'w-full px-3 py-2 rounded-xl border border-line-strong bg-surface text-ink text-sm placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-gold';
const label = 'block text-xs font-semibold text-ink-soft';
const button = 'inline-flex items-center justify-center gap-1.5 min-h-11 px-3 rounded-xl border border-line-strong bg-surface text-xs font-semibold text-ink hover:border-ink-muted disabled:opacity-50';
const primary = 'inline-flex items-center justify-center gap-1.5 min-h-11 px-4 rounded-xl bg-ink text-paper text-xs font-semibold disabled:opacity-50';

const STATUS: Record<SeoPageView['status'], { text: string; tone: string }> = {
  live: { text: 'Live', tone: 'bg-success-soft text-success border-success-line' },
  waiting: { text: 'Waiting', tone: 'bg-sand text-ink-soft border-line' },
  off: { text: 'Off', tone: 'bg-danger-soft text-danger border-danger-line' },
  evergreen: { text: 'Live', tone: 'bg-success-soft text-success border-success-line' },
};

const MODES: Array<{ id: FestivalPageMode; label: string }> = [
  { id: 'auto', label: 'Automatic' },
  { id: 'off', label: 'Off' },
  { id: 'live', label: 'Always live' },
];

const fmt = (d?: string) => {
  if (!d) return '';
  const [y, m, day] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
};

function statusText(p: Pick<SeoPageView, 'status' | 'liveFrom' | 'liveUntil' | 'kind'>): string {
  if (p.status === 'waiting') return p.liveFrom ? `Waiting until ${fmt(p.liveFrom)}` : 'Waiting';
  if (p.status === 'off') return 'Off (not in Google)';
  if (p.status === 'live' && p.kind === 'festival' && p.liveUntil) return `Live until ${fmt(p.liveUntil)}`;
  return 'Live';
}

function StatusBadge({ page }: { page: Pick<SeoPageView, 'status' | 'liveFrom' | 'liveUntil' | 'kind'> }) {
  const s = STATUS[page.status];
  return <span className={`shrink-0 inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${s.tone}`}>{statusText(page)}</span>;
}

type Saver = (text: SeoPageText) => Promise<string | null>;

/** Title and description (and, for landing pages, heading and introduction), with a live preview. */
function PageEditor({ page, onSave, onClose }: { page: SeoPageView; onSave: Saver; onClose: () => void }) {
  const landing = page.kind === 'festival' || page.kind === 'category';
  const [draft, setDraft] = useState<Required<SeoPageText>>({ title: page.own?.title ?? '', description: page.own?.description ?? '', h1: page.own?.h1 ?? '', intro: page.own?.intro ?? '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const autoTitle = page.defaults?.title ?? (page.custom ? '' : page.title);
  const autoDescription = page.defaults?.description ?? (page.custom ? '' : page.description);
  const shownTitle = draft.title.trim() || autoTitle || page.title;
  const shownDescription = draft.description.trim() || autoDescription || page.description;
  const save = async (text: SeoPageText, done: string) => {
    setBusy(true);
    setMsg(null);
    const problem = await onSave(text);
    setBusy(false);
    setMsg(problem ? { ok: false, text: problem } : { ok: true, text: done });
  };
  const idp = `seo-${page.kind}-${page.id || 'home'}`;
  return (
    <div className="space-y-3 border-t border-line pt-3 mt-2" data-testid="seo-page-editor">
      <SnippetPreview title={shownTitle} url={page.url} description={shownDescription} testId="seo-editor-preview" />
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor={`${idp}-title`} className={label}>Title</label>
          <CharCount n={shownTitle.length} max={TITLE_MAX} />
        </div>
        <input id={`${idp}-title`} className={field} value={draft.title} maxLength={SEO_LIMITS.title} placeholder={autoTitle} onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))} />
      </div>
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor={`${idp}-description`} className={label}>Description</label>
          <CharCount n={shownDescription.length} max={DESCRIPTION_MAX} />
        </div>
        <textarea id={`${idp}-description`} className={`${field} min-h-20`} value={draft.description} maxLength={SEO_LIMITS.description} placeholder={autoDescription} onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))} />
      </div>
      {landing && (
        <>
          <div className="space-y-1">
            <label htmlFor={`${idp}-h1`} className={label}>Heading on the page</label>
            <input id={`${idp}-h1`} className={field} value={draft.h1} maxLength={SEO_LIMITS.h1} placeholder={page.defaults?.h1} onChange={(e) => setDraft((d) => ({ ...d, h1: e.target.value }))} />
          </div>
          <div className="space-y-1">
            <label htmlFor={`${idp}-intro`} className={label}>Introduction</label>
            <textarea id={`${idp}-intro`} className={`${field} min-h-24`} value={draft.intro} maxLength={SEO_LIMITS.intro} placeholder={page.defaults?.intro} onChange={(e) => setDraft((d) => ({ ...d, intro: e.target.value }))} />
          </div>
        </>
      )}
      <p className="text-[11px] text-ink-muted">Empty fields are written by the shop (shown greyed) and stay up to date by themselves.</p>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={primary} disabled={busy} onClick={() => save(landing ? draft : { title: draft.title, description: draft.description }, 'Saved.')}>
          {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />} Save
        </button>
        <button
          type="button"
          className={button}
          disabled={busy}
          onClick={() => {
            setDraft({ title: '', description: '', h1: '', intro: '' });
            void save({}, 'Back to automatic.');
          }}
        >
          Reset to automatic
        </button>
        <button type="button" className={button} onClick={onClose}>Close</button>
        {msg && <span role={msg.ok ? 'status' : 'alert'} className={`text-xs ${msg.ok ? 'text-success' : 'text-danger'}`}>{msg.text}</span>}
      </div>
    </div>
  );
}

function PageRow({ page, open, onToggle, onSave }: { page: SeoPageView; open: boolean; onToggle: () => void; onSave: Saver }) {
  return (
    <li className="rounded-2xl border border-line bg-ivory/40 p-3 space-y-2 min-w-0" data-testid="seo-page-row" data-kind={page.kind} data-id={page.id}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">{page.kind === 'home' ? 'Home' : page.kind === 'category' ? 'Category' : page.kind === 'festival' ? 'Festival' : 'Product'}</span>
        <StatusBadge page={page} />
        {page.custom && <span className="text-[11px] text-gold-deep font-semibold">Your words</span>}
        {page.problems.map((p) => (
          <span key={p} className="inline-flex rounded-full border border-warning-line bg-warning-soft px-2 py-0.5 text-[11px] font-semibold text-warning">{p}</span>
        ))}
        <span className="ml-auto flex items-center gap-2">
          {page.status !== 'off' && (
            <a href={page.path} target="_blank" rel="noopener" className="inline-flex items-center gap-1 min-h-11 px-2 text-xs font-semibold text-ink underline underline-offset-4">
              Open <ExternalLink className="w-3 h-3" aria-hidden="true" />
              <span className="sr-only"> {page.name}</span>
            </a>
          )}
          <button type="button" className={button} aria-expanded={open} onClick={onToggle}>
            {open ? 'Close' : 'Edit'}<span className="sr-only"> {page.name}</span>
          </button>
        </span>
      </div>
      <SnippetPreview title={page.title} url={page.url} description={page.description} />
      {open && <PageEditor page={page} onSave={onSave} onClose={onToggle} />}
    </li>
  );
}

type Filter = 'all' | 'site' | 'festival' | 'product' | 'problems';
const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'site', label: 'Home & categories' },
  { id: 'festival', label: 'Festivals' },
  { id: 'product', label: 'Products' },
  { id: 'problems', label: 'Needs a look' },
];

export function SeoSettingsCard() {
  const [data, setData] = useState<SeoOverview | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [codes, setCodes] = useState({ google: '', bing: '', lead: '45' });
  const [codesMsg, setCodesMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await getJson<SeoOverview & { message?: string }>('/api/admin/seo');
    if (!res.ok) return setError(res.data?.message || 'Could not load the search settings.');
    setError('');
    setData(res.data);
    setCodes({ google: res.data.settings.googleVerification, bing: res.data.settings.bingVerification, lead: String(res.data.settings.leadDays) });
  }, []);
  useEffect(() => {
    // Loaded once when the section opens; saves refresh it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const saveSettings = useCallback(async (patch: Partial<SeoSettings>): Promise<string | null> => {
    const res = await sendJson<SeoOverview & { message?: string }>('PUT', '/api/admin/seo', { settings: patch });
    if (!res.ok) return res.data?.message || 'Could not save.';
    setData(res.data);
    return null;
  }, []);

  const saverFor = (page: SeoPageView): Saver => async (text) => {
    if (!data) return 'Not loaded yet.';
    const s = data.settings;
    if (page.kind === 'home') return saveSettings({ home: { title: text.title, description: text.description } });
    if (page.kind === 'category') return saveSettings({ categories: { ...s.categories, [page.id]: text } });
    if (page.kind === 'festival') return saveSettings({ festivals: { ...s.festivals, [page.id]: { ...(s.festivals[page.id]?.mode ? { mode: s.festivals[page.id].mode } : {}), ...text } } });
    const res = await sendJson<{ message?: string }>('PUT', '/api/admin/seo/product', { id: page.id, seoTitle: text.title ?? '', seoDescription: text.description ?? '' });
    if (!res.ok) return res.data?.message || 'Could not save.';
    await load();
    return null;
  };

  const setMode = async (id: string, mode: FestivalPageMode) => {
    if (!data) return;
    const s = data.settings;
    setBusy(true);
    const problem = await saveSettings({ festivals: { ...s.festivals, [id]: { ...(s.festivals[id] ?? {}), mode } } });
    setBusy(false);
    if (problem) setError(problem);
  };

  const pages = useMemo(() => {
    if (!data) return [];
    return data.pages.filter((p) =>
      filter === 'all' ? true : filter === 'site' ? p.kind === 'home' || p.kind === 'category' : filter === 'problems' ? p.problems.length > 0 : p.kind === filter,
    );
  }, [data, filter]);

  // Each festival's next days: all within the coming year.
  const schedule = data?.schedule ?? [];

  if (error && !data) return <p role="alert" className="text-xs text-danger">{error}</p>;
  if (!data) return <p className="text-xs text-ink-muted flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> Loading…</p>;

  const pageByKey = new Map(data.pages.map((p) => [`${p.kind}:${p.id}`, p]));

  return (
    <div className="space-y-8 text-xs min-w-0" data-testid="seo-settings">
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}

      <section className="space-y-2" aria-labelledby="seo-auto-title">
        <h3 id="seo-auto-title" className="font-bold text-sm text-ink">What happens by itself</h3>
        <p className="text-ink-soft leading-relaxed">
          Every category has its own page (<code>/shop/…</code>) and every major festival a gift page (<code>/gifts/diwali</code>, <code>/gifts/eid-al-fitr</code>…). A festival page goes live {data.settings.leadDays} days before the festival: Google is told, the home page links to it and its title becomes the festival&rsquo;s. After the festival the page stays at the same address (it keeps what it earned) and shows next year&rsquo;s dates. Product pages carry their price and stock for Google. Empty fields below are written by the shop and kept up to date.
        </p>
      </section>

      <section className="space-y-2" aria-labelledby="seo-schedule-title" data-testid="seo-schedule">
        <h3 id="seo-schedule-title" className="font-bold text-sm text-ink flex items-center gap-2"><CalendarClock className="w-4 h-4" aria-hidden="true" /> Festival schedule (next 12 months)</h3>
        <ul className="space-y-2">
          {schedule.map((f) => {
            const page = pageByKey.get(`festival:${f.id}`);
            const key = `festival:${f.id}`;
            return (
              <li key={f.id} className="rounded-2xl border border-line bg-surface p-3 space-y-2 min-w-0" data-testid="seo-schedule-row" data-id={f.id}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-sm text-ink">{f.name}</span>
                  <span className="text-ink-soft">{fmt(f.start)}{f.end !== f.start ? ` – ${fmt(f.end)}` : ''}</span>
                  <StatusBadge page={{ status: f.status, liveFrom: f.liveFrom, liveUntil: f.liveUntil, kind: 'festival' }} />
                </div>
                {f.mode === 'auto' && <p className="text-ink-muted">Live {fmt(f.liveFrom)} → {fmt(f.liveUntil)}</p>}
                <div className="flex flex-wrap items-center gap-2">
                  <div role="group" aria-label={`${f.name} page`} className="inline-flex rounded-xl border border-line-strong overflow-hidden">
                    {MODES.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        aria-pressed={f.mode === m.id}
                        disabled={busy}
                        onClick={() => void setMode(f.id, m.id)}
                        className={`min-h-11 px-3 text-xs font-semibold ${f.mode === m.id ? 'bg-ink text-paper' : 'bg-surface text-ink'} disabled:opacity-60`}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                  {page && (
                    <button type="button" className={button} aria-expanded={openKey === key} onClick={() => setOpenKey(openKey === key ? null : key)}>
                      {openKey === key ? 'Close' : 'Edit words'}<span className="sr-only"> for {f.name}</span>
                    </button>
                  )}
                  {f.status !== 'off' && (
                    <a href={f.path} target="_blank" rel="noopener" className="inline-flex items-center gap-1 min-h-11 px-2 font-semibold text-ink underline underline-offset-4">
                      Open page <ExternalLink className="w-3 h-3" aria-hidden="true" />
                    </a>
                  )}
                </div>
                {openKey === key && page && <PageEditor page={page} onSave={saverFor(page)} onClose={() => setOpenKey(null)} />}
              </li>
            );
          })}
        </ul>
        <p className="text-ink-muted">Festivals without a gift page by default (Flag Day, Isra and Mi&rsquo;raj…) show as Off: choose Automatic to give one a page.</p>
      </section>

      <section className="space-y-2" aria-labelledby="seo-pages-title">
        <h3 id="seo-pages-title" className="font-bold text-sm text-ink flex items-center gap-2"><Search className="w-4 h-4" aria-hidden="true" /> What Google sees</h3>
        <div role="group" aria-label="Show" className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)} className={`min-h-11 px-3 rounded-full text-xs font-semibold border ${filter === f.id ? 'bg-ink text-paper border-ink' : 'bg-surface text-ink border-line-strong'}`}>
              {f.label}
              {f.id === 'problems' && ` (${data.pages.filter((p) => p.problems.length).length})`}
            </button>
          ))}
        </div>
        <ul className="space-y-2" data-testid="seo-pages">
          {pages.map((p) => {
            const key = `${p.kind}:${p.id}`;
            return (
              <PageRow
                key={key}
                page={p}
                open={openKey === `list:${key}`}
                onToggle={() => setOpenKey(openKey === `list:${key}` ? null : `list:${key}`)}
                onSave={saverFor(p)}
              />
            );
          })}
        </ul>
        {filter === 'festival' && (
          <p className="text-ink-muted">A festival marked Off is not in Google (noindex) and is not linked anywhere. Switch it with the buttons in the schedule above; festivals more than a year away are listed here.</p>
        )}
      </section>

      <section className="space-y-2" aria-labelledby="seo-health-title" data-testid="seo-health">
        <h3 id="seo-health-title" className="font-bold text-sm text-ink">Health checks</h3>
        <ul className="space-y-1.5">
          {data.health.map((h) => (
            <li key={h.id} className="flex items-start gap-2">
              <span aria-hidden="true" className={`mt-0.5 inline-block w-2.5 h-2.5 shrink-0 rounded-full ${h.ok ? 'bg-success' : 'bg-warning'}`} />
              <span className="min-w-0">
                <span className="font-semibold text-ink">{h.label}</span>
                <span className="sr-only">{h.ok ? ': fine' : ': needs a look'}</span> <span className="text-ink-soft break-words">{h.detail}</span>
              </span>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <a href="/sitemap.xml" target="_blank" rel="noopener" className={button}>Open sitemap <ExternalLink className="w-3 h-3" aria-hidden="true" /></a>
          <a href="/robots.txt" target="_blank" rel="noopener" className={button}>Open robots.txt <ExternalLink className="w-3 h-3" aria-hidden="true" /></a>
        </div>
        <p className="text-ink-muted break-all">Sitemap: {data.sitemapUrl}</p>
        {data.productJsonLd && (
          <details className="rounded-xl border border-line bg-surface px-3 py-2">
            <summary className="cursor-pointer min-h-11 flex items-center font-semibold text-ink">What a product page tells Google (structured data, read-only)</summary>
            <pre className="mt-2 max-h-80 overflow-auto text-[11px] leading-snug whitespace-pre-wrap break-all" data-testid="seo-jsonld-sample">{data.productJsonLd}</pre>
          </details>
        )}
      </section>

      <section className="space-y-3" aria-labelledby="seo-codes-title">
        <h3 id="seo-codes-title" className="font-bold text-sm text-ink">Google, Bing and IndexNow</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1">
            <label htmlFor="seo-google" className={label}>Google Search Console code</label>
            <input id="seo-google" className={field} value={codes.google} maxLength={300} placeholder="e.g. 4cJ1…xYz (the content=&quot;…&quot; part)" onChange={(e) => setCodes((c) => ({ ...c, google: e.target.value }))} />
          </div>
          <div className="space-y-1">
            <label htmlFor="seo-bing" className={label}>Bing Webmaster code (msvalidate.01)</label>
            <input id="seo-bing" className={field} value={codes.bing} maxLength={300} placeholder="Optional" onChange={(e) => setCodes((c) => ({ ...c, bing: e.target.value }))} />
          </div>
          <div className="space-y-1">
            <label htmlFor="seo-lead" className={label}>A festival page goes live this many days before</label>
            <input id="seo-lead" className={field} type="number" inputMode="numeric" min={MIN_LEAD_DAYS} max={MAX_LEAD_DAYS} value={codes.lead} onChange={(e) => setCodes((c) => ({ ...c, lead: e.target.value }))} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={primary}
            onClick={async () => {
              setCodesMsg(null);
              const problem = await saveSettings({ googleVerification: codes.google, bingVerification: codes.bing, leadDays: Number(codes.lead) });
              setCodesMsg(problem ? { ok: false, text: problem } : { ok: true, text: 'Saved. The codes are on the home page within a minute or two.' });
            }}
          >
            Save
          </button>
          {codesMsg && <span role={codesMsg.ok ? 'status' : 'alert'} className={codesMsg.ok ? 'text-success' : 'text-danger'}>{codesMsg.text}</span>}
        </div>
        <label className="flex items-start gap-2 rounded-xl border border-line bg-surface p-3">
          <input
            type="checkbox"
            className="mt-0.5 w-5 h-5"
            checked={data.settings.indexNow}
            onChange={async (e) => {
              const problem = await saveSettings({ indexNow: e.target.checked });
              if (problem) setError(problem);
            }}
          />
          <span className="min-w-0">
            <span className="font-semibold text-ink block">Tell Bing at once about new and changed pages (IndexNow)</span>
            <span className="text-ink-soft">Off by default. When on, publishing or changing a product, and a festival page going live, are sent to IndexNow (Bing, Yandex and others). Google does not use it: it reads your sitemap.</span>
          </span>
        </label>
        {data.indexNow.on && (
          <div className="space-y-1" data-testid="seo-indexnow">
            {data.indexNow.keyUrl ? <p className="text-ink-soft break-all">Key file: {data.indexNow.keyUrl}</p> : <p className="text-warning">Set the shop&rsquo;s https address (NEXT_PUBLIC_APP_URL) so pings can be sent.</p>}
            {data.indexNow.last.length ? (
              <ul className="space-y-0.5">
                {data.indexNow.last.map((p) => (
                  <li key={p.at} className="text-ink-soft">{new Date(p.at).toLocaleString('en-GB')}: {p.urls} {p.urls === 1 ? 'page' : 'pages'}, {p.ok ? 'accepted' : `not accepted (${p.status})`}</li>
                ))}
              </ul>
            ) : (
              <p className="text-ink-muted">No pings yet.</p>
            )}
          </div>
        )}
      </section>

      <section className="space-y-2" aria-labelledby="seo-steps-title" data-testid="seo-steps">
        <h3 id="seo-steps-title" className="font-bold text-sm text-ink">Google Search Console: once, about 5 minutes</h3>
        <ol className="list-decimal pl-5 space-y-1 text-ink-soft leading-relaxed">
          <li>Open <a className="underline" href="https://search.google.com/search-console" target="_blank" rel="noopener noreferrer">search.google.com/search-console</a> and add a property: choose <strong>URL prefix</strong> and type <strong>{data.base.replace(/^http:/, 'https:')}</strong>.</li>
          <li>Choose <strong>HTML tag</strong>, copy the code inside content=&quot;…&quot;, paste it above (Google Search Console code) and press Save.</li>
          <li>Back in Search Console press <strong>Verify</strong> (wait a minute or two after saving).</li>
          <li>Open <strong>Sitemaps</strong>, type <strong>sitemap.xml</strong> and press Submit. That is all: Google comes back by itself, and the shop keeps the sitemap current.</li>
          <li>Optional: Bing Webmaster Tools can import the site from Search Console in one click (or use its code above).</li>
        </ol>
      </section>
    </div>
  );
}

/** The Overview's card: which festival pages are live, the next one, and how many pages need a look. */
export function SeoOverviewCard({ onOpen }: { onOpen: () => void }) {
  const [data, setData] = useState<SeoOverview | null>(null);
  useEffect(() => {
    let alive = true;
    void getJson<SeoOverview>('/api/admin/seo').then((r) => {
      if (alive && r.ok) setData(r.data);
    });
    return () => {
      alive = false;
    };
  }, []);
  if (!data) return null;
  const live = data.schedule.filter((f) => f.status === 'live');
  const next = data.schedule.find((f) => f.status === 'waiting');
  const problems = data.pages.filter((p) => p.problems.length).length;
  return (
    <section aria-labelledby="seo-overview-title" className="space-y-2" data-testid="seo-overview">
      <div className="flex items-center gap-2">
        <h2 id="seo-overview-title" className="font-serif font-bold text-lg text-ink flex items-center gap-2">
          <Search className="w-5 h-5 text-gold-deep" aria-hidden="true" /> Search (Google)
        </h2>
        <button type="button" onClick={onOpen} className="ml-auto min-h-11 px-3 rounded-xl border border-line-strong bg-surface text-xs font-semibold text-ink">
          Open Search (SEO)
        </button>
      </div>
      <ul className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <li className="rounded-2xl border border-line bg-surface px-3 py-3 min-w-0">
          <span className="block text-xs font-semibold text-ink-soft">Festival pages live</span>
          <span className="block text-sm font-semibold text-ink break-words">{live.length ? live.map((f) => f.name).join(', ') : 'None right now'}</span>
        </li>
        <li className="rounded-2xl border border-line bg-surface px-3 py-3 min-w-0">
          <span className="block text-xs font-semibold text-ink-soft">Next to go live</span>
          <span className="block text-sm font-semibold text-ink break-words">{next ? `${next.name} on ${fmt(next.liveFrom)}` : '—'}</span>
        </li>
        <li className="rounded-2xl border border-line bg-surface px-3 py-3 min-w-0">
          <span className="block text-xs font-semibold text-ink-soft">Pages that need a look</span>
          <span className="block text-2xl font-bold text-ink tabular-nums">{problems}</span>
        </li>
      </ul>
    </section>
  );
}
