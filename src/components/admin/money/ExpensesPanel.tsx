'use client';

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Camera, History, Paperclip, Pencil, Plus, Trash2, X } from 'lucide-react';
import { getJson, sendJson } from '@/lib/apiClient';
import { dubaiToday } from '@/lib/reportPeriods';
import { shrinkPhoto } from '@/lib/shrinkPhoto';
import { aed, Card, inputClass, labelClass, niceDate, primaryButton, secondaryButton, uaeTime } from './moneyUi';

interface Bill {
  id: string;
  ext: string;
  mime: string;
  size: number;
  name: string;
  addedAt: string;
  addedBy: string;
  removed?: { at: string; by: string; why: string };
  url: string;
}
export interface ExpenseView {
  id: string;
  date: string;
  amountFils: number;
  categoryId: string;
  category: string;
  payee: string;
  method: 'cash' | 'card' | 'bank_transfer' | 'other';
  note: string;
  version: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
  removed?: { at: string; by: string; why: string };
  bills: Bill[];
}
interface Category {
  id: string;
  name: string;
}
interface Version {
  version: number;
  change: string;
  at: string;
  by: string;
  data: { date: string; amountFils: number; category: string; payee: string; method: string; note: string };
}

const METHODS: Array<[ExpenseView['method'], string]> = [
  ['cash', 'Cash'],
  ['card', 'Card'],
  ['bank_transfer', 'Bank transfer'],
  ['other', 'Other'],
];
const methodLabel = (m: string) => METHODS.find(([id]) => id === m)?.[1] ?? m;
const MAX_BILL_BYTES = 10 * 1024 * 1024;

const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '');

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('The file could not be read.'));
    r.readAsDataURL(file);
  });
}

/**
 * A bill as sent to the server: photos made smaller (2000 px) and re-encoded as JPEG in the
 * browser, which also drops their EXIF/GPS (the server strips it again). A photo the browser
 * can't draw (HEIC outside Safari) and PDFs go as they are, 10 MB at most.
 */
async function billDataUrl(file: File): Promise<string> {
  const pdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  if (!pdf) {
    try {
      return await shrinkPhoto(file, 2000);
    } catch {
      // not drawable here: sent as it is (the server checks what it really is)
    }
  }
  if (file.size > MAX_BILL_BYTES) throw new Error(`${file.name || 'The file'} is larger than 10 MB.`);
  return readAsDataUrl(file);
}

interface FormState {
  date: string;
  amount: string;
  categoryId: string;
  payee: string;
  method: ExpenseView['method'];
  note: string;
}

function ExpenseForm({
  categories,
  editing,
  onCategories,
  onDone,
  onCancel,
}: {
  categories: Category[];
  editing: ExpenseView | null;
  onCategories: (c: Category[]) => void;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [form, setForm] = useState<FormState>(() =>
    editing
      ? { date: editing.date, amount: (editing.amountFils / 100).toFixed(2), categoryId: editing.categoryId, payee: editing.payee, method: editing.method, note: editing.note }
      : { date: dubaiToday(), amount: '', categoryId: categories[0]?.id ?? '', payee: '', method: 'cash', note: '' }
  );
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [newCategory, setNewCategory] = useState('');
  const [addingCategory, setAddingCategory] = useState(false);
  // One key per form: a double tap or a retry saves one expense.
  const key = useRef(newKey());
  const savedId = useRef<string | null>(editing?.id ?? null);
  const camera = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const set = (k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    setFiles((f) => [...f, ...Array.from(list)].slice(0, 20));
  };

  const addCategory = async () => {
    const name = newCategory.trim();
    if (!name) return;
    const { ok, data } = await sendJson<{ category?: Category; categories?: Category[]; message?: string }>('POST', '/api/admin/expenses/categories', { name });
    if (!ok || !data.category) return setError(data.message || 'Could not add the category.');
    onCategories(data.categories ?? [...categories, data.category]);
    setForm((f) => ({ ...f, categoryId: data.category!.id }));
    setNewCategory('');
    setAddingCategory(false);
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const fields = { date: form.date, amount: form.amount.trim(), categoryId: form.categoryId, payee: form.payee, method: form.method, note: form.note };
      let expenseId = savedId.current;
      if (editing) {
        const { ok, data } = await sendJson<{ message?: string }>('PATCH', `/api/admin/expenses/${editing.id}`, { version: editing.version, ...fields });
        if (!ok) throw new Error(data.message || 'Could not save the changes.');
      } else if (!expenseId) {
        const { ok, data } = await sendJson<{ expense?: ExpenseView; message?: string }>('POST', '/api/admin/expenses', { key: key.current, ...fields });
        if (!ok || !data.expense) throw new Error(data.message || 'Could not save the expense.');
        expenseId = savedId.current = data.expense.id;
      }
      // The bills, one by one; one that fails is said, the rest still go.
      const failed: string[] = [];
      for (const file of files) {
        try {
          const dataUrl = await billDataUrl(file);
          const { ok, data } = await sendJson<{ message?: string }>('POST', `/api/admin/expenses/${expenseId}/bills`, { file: dataUrl, name: file.name.slice(0, 120) });
          if (!ok) throw new Error(data.message || 'Upload failed.');
        } catch (err) {
          failed.push(`${file.name || 'photo'}: ${err instanceof Error ? err.message : 'upload failed'}`);
        }
      }
      if (failed.length) {
        setFiles((f) => f.filter((x) => failed.some((m) => m.startsWith(`${x.name || 'photo'}:`))));
        throw new Error(`The expense is saved, but ${failed.length === 1 ? 'a bill' : 'some bills'} could not be attached. ${failed.join(' ')} Try again with Save.`);
      }
      onDone(editing ? 'Changes saved.' : 'Expense saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} className="space-y-3" aria-labelledby={`${id}-title`} data-testid="expense-form">
      <div className="flex items-center gap-2">
        <h3 id={`${id}-title`} className="font-serif text-lg text-ink flex-1">
          {editing ? `Edit ${editing.id}` : 'New expense'}
        </h3>
        <button type="button" onClick={onCancel} className="min-h-11 min-w-11 inline-flex items-center justify-center rounded-full text-ink-soft" aria-label="Close">
          <X className="w-5 h-5" aria-hidden="true" />
        </button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor={`${id}-date`} className={labelClass}>Date on the bill</label>
          <input id={`${id}-date`} type="date" required value={form.date} max={dubaiToday()} onChange={set('date')} className={inputClass} />
        </div>
        <div>
          <label htmlFor={`${id}-amount`} className={labelClass}>Amount (AED)</label>
          <input id={`${id}-amount`} type="text" inputMode="decimal" required placeholder="0.00" autoComplete="off" value={form.amount} onChange={set('amount')} className={`${inputClass} tabular-nums`} />
        </div>
      </div>
      <div>
        <label htmlFor={`${id}-category`} className={labelClass}>Category</label>
        <div className="flex gap-2">
          <select id={`${id}-category`} required value={form.categoryId} onChange={set('categoryId')} className={`${inputClass} flex-1 min-w-0`}>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <button type="button" className={secondaryButton} onClick={() => setAddingCategory((a) => !a)} aria-expanded={addingCategory}>
            <Plus className="w-4 h-4" aria-hidden="true" />
            <span>New</span>
          </button>
        </div>
        {addingCategory && (
          <div className="flex gap-2 mt-2">
            <label htmlFor={`${id}-newcat`} className="sr-only">New category name</label>
            <input id={`${id}-newcat`} type="text" maxLength={40} placeholder="e.g. Photography" value={newCategory} onChange={(e) => setNewCategory(e.target.value)} className={`${inputClass} flex-1 min-w-0`} />
            <button type="button" className={secondaryButton} onClick={() => void addCategory()}>Add</button>
          </div>
        )}
      </div>
      <div>
        <label htmlFor={`${id}-payee`} className={labelClass}>Paid to</label>
        <input id={`${id}-payee`} type="text" maxLength={120} placeholder="e.g. Al Noor Packaging" value={form.payee} onChange={set('payee')} className={inputClass} />
      </div>
      <fieldset>
        <legend className={labelClass}>Paid by</legend>
        <div className="grid grid-cols-2 gap-2">
          {METHODS.map(([m, label]) => (
            <label key={m} className={`min-h-11 px-3 rounded-xl border text-sm flex items-center gap-2 cursor-pointer ${form.method === m ? 'border-ink bg-sand text-ink font-semibold' : 'border-line-strong bg-surface text-ink-soft'}`}>
              <input type="radio" name={`${id}-method`} value={m} checked={form.method === m} onChange={() => setForm((f) => ({ ...f, method: m }))} className="accent-current" />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      <div>
        <label htmlFor={`${id}-note`} className={labelClass}>Note (optional)</label>
        <textarea id={`${id}-note`} rows={2} maxLength={1000} value={form.note} onChange={set('note')} className={`${inputClass} py-2`} />
      </div>
      <div>
        <p className={labelClass}>Bill{editing ? 's to add' : ''}</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={secondaryButton} onClick={() => camera.current?.click()}>
            <Camera className="w-4 h-4" aria-hidden="true" />
            <span>Take photo</span>
          </button>
          <button type="button" className={secondaryButton} onClick={() => picker.current?.click()}>
            <Paperclip className="w-4 h-4" aria-hidden="true" />
            <span>Photo or PDF</span>
          </button>
        </div>
        <input ref={camera} type="file" accept="image/*,application/pdf" capture="environment" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
        <input ref={picker} type="file" accept="image/*,application/pdf" multiple className="sr-only" aria-label="Attach a photo or PDF of the bill" data-testid="bill-input" onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
        {files.length > 0 && (
          <ul className="mt-2 space-y-1">
            {files.map((f, i) => (
              <li key={`${f.name}-${i}`} className="flex items-center gap-2 text-xs text-ink-soft">
                <Paperclip className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span className="flex-1 min-w-0 truncate">{f.name || 'photo'}</span>
                <button type="button" className="min-h-9 px-2 text-ink-soft underline" onClick={() => setFiles((list) => list.filter((_, j) => j !== i))} aria-label={`Don't attach ${f.name || 'this photo'}`}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {error && <p role="alert" className="text-xs text-danger bg-danger-soft border border-danger-line rounded-xl px-3 py-2">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className={`${primaryButton} flex-1`}>
          {busy ? 'Saving…' : editing ? 'Save changes' : 'Save expense'}
        </button>
        <button type="button" onClick={onCancel} className={secondaryButton}>Cancel</button>
      </div>
    </form>
  );
}

function ExpenseCard({ e, onEdit, onChanged }: { e: ExpenseView; onEdit: () => void; onChanged: (message: string) => void }) {
  const id = useId();
  const [removing, setRemoving] = useState(false);
  const [reason, setReason] = useState('');
  const [history, setHistory] = useState<Version[] | null>(null);
  const [error, setError] = useState('');
  const bills = e.bills.filter((b) => !b.removed);

  const remove = async (ev: React.FormEvent) => {
    ev.preventDefault();
    const { ok, data } = await sendJson<{ message?: string }>('DELETE', `/api/admin/expenses/${e.id}`, { reason });
    if (!ok) return setError(data.message || 'Could not remove it.');
    onChanged('Expense removed (kept in the records).');
  };
  const removeBill = async (b: Bill) => {
    const why = window.prompt('Why take this bill off? (It is kept in the records.)', 'Wrong photo');
    if (!why) return;
    const { ok, data } = await sendJson<{ message?: string }>('DELETE', `/api/admin/expenses/${e.id}/bills/${b.id}`, { reason: why });
    if (!ok) return setError(data.message || 'Could not take the bill off.');
    onChanged('Bill taken off (kept in the records).');
  };
  const toggleHistory = async () => {
    if (history) return setHistory(null);
    const { ok, data } = await getJson<{ versions: Version[] }>(`/api/admin/expenses/${e.id}`);
    if (ok) setHistory(data.versions);
  };

  return (
    <li>
      <Card className={e.removed ? 'opacity-70' : ''} data-testid="expense-item">
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-ink break-words">{e.payee || e.category}</p>
            <p className="text-xs text-ink-soft">
              {niceDate(e.date)} · {e.category} · {methodLabel(e.method)}
            </p>
            {e.note && <p className="text-xs text-ink-soft mt-1 break-words">{e.note}</p>}
            {e.removed && (
              <p className="text-xs text-danger mt-1 break-words">
                Removed {uaeTime(e.removed.at)} by {e.removed.by}: {e.removed.why}
              </p>
            )}
          </div>
          <p className={`text-sm font-bold tabular-nums shrink-0 ${e.removed ? 'line-through text-ink-soft' : 'text-ink'}`} data-testid="expense-amount">AED {aed(e.amountFils)}</p>
        </div>
        {bills.length > 0 && (
          <ul className="flex flex-wrap gap-2 mt-2">
            {bills.map((b, i) => (
              <li key={b.id} className="flex items-center gap-1">
                <a href={b.url} target="_blank" rel="noopener noreferrer" className="min-h-9 px-2.5 rounded-lg border border-line bg-ivory text-xs text-ink inline-flex items-center gap-1">
                  <Paperclip className="w-3.5 h-3.5" aria-hidden="true" />
                  {`Bill ${i + 1}`} <span className="sr-only">of {e.id} ({b.ext.toUpperCase()})</span>
                </a>
                {!e.removed && (
                  <button type="button" onClick={() => void removeBill(b)} className="min-h-9 min-w-9 inline-flex items-center justify-center text-ink-soft" aria-label={`Take bill ${i + 1} off`}>
                    <X className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {!e.removed && (
          <div className="flex flex-wrap gap-2 mt-3">
            <button type="button" onClick={onEdit} className={secondaryButton}>
              <Pencil className="w-4 h-4" aria-hidden="true" />
              <span>Edit</span>
            </button>
            <button type="button" onClick={() => setRemoving((r) => !r)} aria-expanded={removing} className={secondaryButton}>
              <Trash2 className="w-4 h-4" aria-hidden="true" />
              <span>Remove</span>
            </button>
            <button type="button" onClick={() => void toggleHistory()} aria-expanded={Boolean(history)} className={secondaryButton}>
              <History className="w-4 h-4" aria-hidden="true" />
              <span>History</span>
            </button>
          </div>
        )}
        {e.removed && (
          <div className="mt-2">
            <button type="button" onClick={() => void toggleHistory()} aria-expanded={Boolean(history)} className={secondaryButton}>
              <History className="w-4 h-4" aria-hidden="true" />
              <span>History</span>
            </button>
          </div>
        )}
        {removing && (
          <form onSubmit={remove} className="mt-3 space-y-2">
            <label htmlFor={`${id}-why`} className={labelClass}>Why remove it? (It stays in the records, out of the totals.)</label>
            <input id={`${id}-why`} type="text" required maxLength={300} value={reason} onChange={(ev) => setReason(ev.target.value)} placeholder="e.g. Entered twice" className={inputClass} />
            <button type="submit" className={primaryButton}>Remove expense</button>
          </form>
        )}
        {history && (
          <ol className="mt-3 space-y-1.5 border-t border-line pt-2" aria-label={`History of ${e.id}`}>
            {history.map((v) => (
              <li key={v.version} className="text-xs text-ink-soft break-words">
                <strong className="text-ink">v{v.version} {v.change}</strong> {uaeTime(v.at)} by {v.by}: AED {aed(v.data.amountFils)}, {niceDate(v.data.date)}, {v.data.category}, {methodLabel(v.data.method)}
                {v.data.payee ? `, ${v.data.payee}` : ''}
              </li>
            ))}
          </ol>
        )}
        {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
      </Card>
    </li>
  );
}

/** Money → Expenses: this month's expenses (any month), add one with a photo of the bill, edit, remove (kept), history. */
export function ExpensesPanel() {
  const id = useId();
  const [month, setMonth] = useState(() => dubaiToday().slice(0, 7));
  const [showRemoved, setShowRemoved] = useState(false);
  const [expenses, setExpenses] = useState<ExpenseView[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [form, setForm] = useState<{ editing: ExpenseView | null; n: number } | null>(null);
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    const [y, m] = month.split('-').map(Number);
    if (!y || !m) return;
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const { ok, data } = await getJson<{ expenses: ExpenseView[]; categories: Category[] }>(`/api/admin/expenses?from=${month}-01&to=${month}-${String(last).padStart(2, '0')}${showRemoved ? '&removed=1' : ''}`);
    if (ok) {
      setExpenses(data.expenses);
      setCategories(data.categories);
    }
    setLoaded(true);
  }, [month, showRemoved]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  const total = expenses.filter((e) => !e.removed).reduce((n, e) => n + e.amountFils, 0);
  const done = (message: string) => {
    setForm(null);
    setNotice(message);
    void load();
  };

  return (
    <section aria-labelledby={`${id}-h`} className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <h2 id={`${id}-h`} className="font-serif text-xl text-ink flex-1">Expenses</h2>
        {!form && (
          <button type="button" className={primaryButton} onClick={() => { setNotice(''); setForm({ editing: null, n: Date.now() }); }}>
            <Plus className="w-4 h-4" aria-hidden="true" />
            <span>Add expense</span>
          </button>
        )}
      </div>
      {notice && <p role="status" className="text-xs text-success bg-success-soft border border-success-line rounded-xl px-3 py-2">{notice}</p>}
      {form && (
        <Card>
          <ExpenseForm key={form.n} categories={categories} editing={form.editing} onCategories={setCategories} onDone={done} onCancel={() => setForm(null)} />
        </Card>
      )}
      <div className="flex items-end gap-3 flex-wrap">
        <div>
          <label htmlFor={`${id}-month`} className={labelClass}>Month</label>
          <input id={`${id}-month`} type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} className={inputClass} />
        </div>
        <label className="min-h-11 inline-flex items-center gap-2 text-sm text-ink-soft">
          <input type="checkbox" checked={showRemoved} onChange={(e) => setShowRemoved(e.target.checked)} />
          Show removed
        </label>
      </div>
      <Card>
        <p className="flex items-baseline justify-between gap-3 text-sm">
          <span className="text-ink-soft">{expenses.filter((e) => !e.removed).length} expense{expenses.filter((e) => !e.removed).length === 1 ? '' : 's'} this month</span>
          <strong className="text-ink tabular-nums" data-testid="expenses-total">AED {aed(total)}</strong>
        </p>
      </Card>
      {loaded && !expenses.length && <p className="text-sm text-ink-soft">No expenses this month yet. Tap “Add expense” and take a photo of the bill.</p>}
      <ul className="space-y-2" aria-label="Expenses">
        {expenses.map((e) => (
          <ExpenseCard key={`${e.id}-${e.version}`} e={e} onEdit={() => { setNotice(''); setForm({ editing: e, n: Date.now() }); window.scrollTo({ top: 0, behavior: 'smooth' }); }} onChanged={(m) => { setNotice(m); void load(); }} />
        ))}
      </ul>
    </section>
  );
}
