'use client';

import React, { useEffect, useState } from 'react';
import { CourierSettings, CourierProvider, Emirate } from '@/types';
import { Truck, CheckCircle2, AlertCircle, RefreshCw, FlaskConical, MapPin, Power, XCircle, MinusCircle } from 'lucide-react';
import { useAutoSave, type AutoSaveHooks } from './settings/useAutoSave';
import { postJson } from '@/lib/apiClient';
import { BLOCKED_MESSAGE, ECO_LIVE_NOT_CONNECTED, jeeblyMode, LIVE_OFF_WARNING, LIVE_OVERRIDE_PHRASE } from '@/lib/courierMode';

interface AdminCouriersTabProps {
  settings: CourierSettings;
  /** Which secret keys are saved on the server (their values never come back). */
  secretsSet: Record<string, boolean>;
  /** Saves on the server; resolves to an error message, or null when saved. */
  onUpdateSettings: (newSettings: CourierSettings) => Promise<string | null>;
  /** Settings changed on the server some other way (Live mode switched): reload them. */
  onReload?: () => void;
  auto?: AutoSaveHooks;
}

/** Placeholder for a write-only key field. */
export function secretPlaceholder(saved: boolean | undefined) {
  return saved ? '•••• saved — leave blank to keep' : 'Not set';
}

interface SandboxStep {
  step: 'create' | 'label' | 'tracking' | 'cancel';
  result: 'pass' | 'fail' | 'not_checked';
  httpStatus?: number;
  said: string;
}
interface SandboxCheck {
  at: string;
  by: string;
  passed: boolean;
  awb?: string;
  steps: SandboxStep[];
  fresh: boolean;
  validDays: number;
}

const EMIRATES: Emirate[] = ['Dubai', 'Abu Dhabi', 'Sharjah', 'Ajman', 'Ras Al Khaimah', 'Fujairah', 'Umm Al Quwain'];
const STEP_NAMES: Record<SandboxStep['step'], string> = { create: 'Create a TEST shipment', label: 'Fetch its label', tracking: 'Fetch its tracking', cancel: 'Cancel it' };

const input = 'w-full px-3 py-2 rounded-xl border border-line-strong bg-surface text-ink text-xs focus:outline-none focus:ring-2 focus:ring-gold';
const button = 'flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl font-semibold text-xs transition-all disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2';

export const AdminCouriersTab: React.FC<AdminCouriersTabProps> = ({ settings, secretsSet, onUpdateSettings, onReload, auto }) => {
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);
  const [activeCarrier, setActiveCarrier] = useState<'jeebly' | 'echo'>('jeebly');
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [check, setCheck] = useState<SandboxCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [liveBusy, setLiveBusy] = useState(false);
  const [liveError, setLiveError] = useState('');
  const [overridePhrase, setOverridePhrase] = useState('');

  // Local form state
  const [formData, setFormData] = useState<CourierSettings>(settings);
  // Keys are never autosaved (half-typed ones would replace working ones): Save sends them.
  const autosave = useAutoSave({
    settingsKey: 'courier',
    value: {
      ...formData,
      jeebly: { ...formData.jeebly, apiKey: '', clientKey: '', sandboxApiKey: '', sandboxClientKey: '' },
      echo: { ...formData.echo, apiKey: '' },
    },
    enabled: Boolean(auto),
    ...auto,
  });

  useEffect(() => {
    let live = true;
    void fetch('/api/courier/sandbox-check', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (live && d?.check) setCheck(d.check);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const j = formData.jeebly;
  const setJ = (patch: Partial<CourierSettings['jeebly']>) => setFormData({ ...formData, jeebly: { ...formData.jeebly, ...patch } });
  const hasLiveKeys = Boolean(secretsSet['jeebly.apiKey'] && secretsSet['jeebly.clientKey']);
  const hasSandboxKeys = Boolean(secretsSet['jeebly.sandboxApiKey'] && secretsSet['jeebly.sandboxClientKey']);
  const mode = jeeblyMode({ isLive: j.isLive, hasLiveKeys, hasSandboxKeys });
  // What Jeebly requires of the pickup (the same list the server checks, src/lib/jeebly.ts missingPickup).
  const pickupMissing = [
    !j.pickupPhone?.replace(/\D/g, '') && 'phone',
    !j.pickupUnit?.trim() && 'unit / shop / villa no.',
    !j.pickupBuilding?.trim() && 'building',
    !j.pickupArea?.trim() && 'area',
    !j.pickupLandmark?.trim() && 'landmark',
  ].filter(Boolean) as string[];

  const handleTestConnection = async (provider: 'jeebly' | 'echo') => {
    setTesting(true);
    setTestResult(null);
    const { data } = await postJson<{ reached?: boolean; carrierSaysOk?: boolean; summary?: string; message?: string }>('/api/courier/test', { provider, settings: formData });
    setTesting(false);
    setTestResult({ ok: Boolean(data.reached && data.carrierSaysOk), text: data.summary || data.message || 'Could not reach the courier.' });
  };

  const runCheck = async () => {
    setChecking(true);
    const { ok, data } = await postJson<{ check?: SandboxCheck; message?: string }>('/api/courier/sandbox-check', {});
    setChecking(false);
    if (ok && data.check) setCheck(data.check);
    else setLiveError(data.message || 'The Sandbox check could not run.');
  };

  const setLive = async (on: boolean, override?: string) => {
    if (on && !window.confirm('Turn on Jeebly Live mode? Bookings then create REAL shipments with Jeebly (they may charge), and customers see the tracking number.')) return;
    setLiveBusy(true);
    setLiveError('');
    const { ok, data } = await postJson<{ value?: CourierSettings; message?: string }>('/api/courier/live', { on, ...(override !== undefined ? { override } : {}) });
    setLiveBusy(false);
    if (!ok) return setLiveError(data.message || 'Not changed. Please try again.');
    setFormData((f) => ({ ...f, jeebly: { ...f.jeebly, isLive: on } }));
    setOverridePhrase('');
    onReload?.();
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    autosave.cancel();
    setSaving(true);
    setSaveError('');
    const error = await onUpdateSettings(formData);
    setSaving(false);
    if (error) {
      setSaveError(error);
      return;
    }
    setSavedSuccess(true);
    setTimeout(() => setSavedSuccess(false), 2500);
  };

  const modeBox =
    mode === 'live'
      ? { tone: 'bg-success-soft text-success border-success-line', title: 'Jeebly: Live mode', text: 'Bookings create real shipments with your live keys. Customers see the tracking number.' }
      : mode === 'sandbox'
      ? { tone: 'bg-warning-soft text-warning border-warning-line', title: 'Jeebly: Test mode (sandbox)', text: "Bookings are test shipments in Jeebly's sandbox, with Jeebly's own test AWB. Nobody collects the parcel and the customer sees no tracking." }
      : mode === 'practice'
      ? { tone: 'bg-warning-soft text-warning border-warning-line', title: 'Jeebly: Test mode (practice)', text: 'No keys are saved: a booking is an offline practice one. Nothing is sent to Jeebly.' }
      : { tone: 'bg-danger-soft text-danger border-danger-line', title: 'Jeebly: Test mode – nothing to test with', text: BLOCKED_MESSAGE };

  return (
    <div className="space-y-4">
      {/* Header Info */}
      <div className="bg-surface rounded-2xl p-4 border border-line shadow-sm space-y-2">
        <div className="flex items-center gap-2">
          <Truck className="w-5 h-5 text-gold" />
          <h3 className="font-serif font-bold text-base text-ink">Couriers (Jeebly & Eco Express)</h3>
        </div>
        <p className="text-xs text-ink-soft leading-relaxed">
          Jeebly books through its API: test in Jeebly&apos;s sandbox first, then run the Sandbox check and turn on Live mode. Eco Express live booking isn&apos;t connected yet: book in the Eco portal and use “Enter tracking number” on the order (that works for any courier).
        </p>
      </div>

      {/* Pickup: who sends the parcel, on every booking and label */}
      <div className="bg-surface rounded-2xl p-4 border border-line space-y-3 text-xs">
        <div className="flex items-center gap-2">
          <MapPin className="w-4 h-4 text-gold" aria-hidden="true" />
          <strong className="text-ink text-sm">Your pickup address</strong>
        </div>
        <p className="text-ink-muted">Where the courier collects parcels. It is sent with every booking and printed on the label as the sender.</p>
        {pickupMissing.length > 0 && (
          <p role="alert" data-testid="pickup-missing" className="rounded-xl border border-warning-line bg-warning-soft p-2.5 font-semibold text-warning">
            Jeebly needs your pickup {pickupMissing.join(', ')} before booking (and the Sandbox check). Labels show only what is filled in.
          </p>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-ink-soft font-semibold mb-1">Pickup name (optional)</span>
            <input type="text" value={j.pickupLocationName} onChange={(e) => setJ({ pickupLocationName: e.target.value })} maxLength={120} placeholder="Your shop name is used if empty" className={input} />
          </label>
          <label className="block">
            <span className="block text-ink-soft font-semibold mb-1">Pickup phone</span>
            <input type="tel" value={j.pickupPhone} onChange={(e) => setJ({ pickupPhone: e.target.value })} maxLength={32} placeholder="+971 5x xxx xxxx" className={input} />
          </label>
          <label className="block">
            <span className="block text-ink-soft font-semibold mb-1">Unit / shop / villa no.</span>
            <input type="text" value={j.pickupUnit ?? ''} onChange={(e) => setJ({ pickupUnit: e.target.value })} maxLength={40} className={input} />
          </label>
          <label className="block">
            <span className="block text-ink-soft font-semibold mb-1">Building or warehouse</span>
            <input type="text" value={j.pickupBuilding ?? ''} onChange={(e) => setJ({ pickupBuilding: e.target.value })} maxLength={120} className={input} />
          </label>
          <label className="block">
            <span className="block text-ink-soft font-semibold mb-1">Area</span>
            <input type="text" value={j.pickupArea ?? ''} onChange={(e) => setJ({ pickupArea: e.target.value })} maxLength={120} placeholder="e.g. Al Barsha 1" className={input} />
          </label>
          <label className="block">
            <span className="block text-ink-soft font-semibold mb-1">Landmark</span>
            <input type="text" value={j.pickupLandmark ?? ''} onChange={(e) => setJ({ pickupLandmark: e.target.value })} maxLength={120} placeholder="e.g. next to the metro station" className={input} />
          </label>
          <label className="block sm:col-span-2">
            <span className="block text-ink-soft font-semibold mb-1">Street (optional)</span>
            <input type="text" value={j.pickupAddress} onChange={(e) => setJ({ pickupAddress: e.target.value })} maxLength={200} className={input} />
          </label>
          <label className="block">
            <span className="block text-ink-soft font-semibold mb-1">Packaging weight per parcel (g)</span>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={5000}
              step={1}
              value={formData.packagingGrams ?? 200}
              onChange={(e) => setFormData({ ...formData, packagingGrams: Math.max(0, Math.min(5000, Math.round(Number(e.target.value) || 0))) })}
              className={input}
            />
            <span className="block text-ink-muted mt-1">Added to the sizes&apos; weights (Inventory → each size&apos;s Weight) to make the parcel&apos;s weight.</span>
          </label>
          <label className="block">
            <span className="block text-ink-soft font-semibold mb-1">Emirate</span>
            <select value={j.pickupEmirate} onChange={(e) => setJ({ pickupEmirate: e.target.value as Emirate })} className={input}>
              {EMIRATES.map((em) => (
                <option key={em} value={em}>{em}</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {/* AUTOMATION ROUTING RULES */}
      <div className="bg-surface rounded-2xl p-4 border border-line space-y-3 text-xs">
        <strong className="text-ink text-sm block">Which courier is suggested</strong>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-ink-soft font-semibold mb-1">Cash on delivery orders</span>
            <select value={formData.autoAssignRules.codCourier} onChange={(e) => setFormData({ ...formData, autoAssignRules: { ...formData.autoAssignRules, codCourier: e.target.value as CourierProvider } })} className={input}>
              <option value="jeebly">Jeebly</option>
              <option value="echo">Eco Express</option>
            </select>
          </label>
          <label className="block">
            <span className="block text-ink-soft font-semibold mb-1">Prepaid orders (card, bank transfer)</span>
            <select value={formData.autoAssignRules.prepaidCourier} onChange={(e) => setFormData({ ...formData, autoAssignRules: { ...formData.autoAssignRules, prepaidCourier: e.target.value as CourierProvider } })} className={input}>
              <option value="echo">Eco Express</option>
              <option value="jeebly">Jeebly</option>
            </select>
          </label>
        </div>
      </div>

      {/* CARRIER TABS */}
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2 border-b border-line pb-2" role="group" aria-label="Courier">
          {(['jeebly', 'echo'] as const).map((id) => (
            <button
              key={id}
              type="button"
              aria-pressed={activeCarrier === id}
              onClick={() => {
                setActiveCarrier(id);
                setTestResult(null);
              }}
              className={`${button} min-w-0 ${activeCarrier === id ? 'bg-ink text-paper shadow-sm' : 'bg-surface text-ink-soft hover:bg-sand border border-line'}`}
            >
              <span>{id === 'jeebly' ? 'Jeebly' : 'Eco Express'}</span>
              <span className={`text-[10px] px-1.5 rounded-full font-bold ${activeCarrier === id ? 'bg-gold text-ink' : 'bg-sand-deep text-ink-soft'}`}>
                {id === 'jeebly' ? (mode === 'live' ? 'Live' : 'Test') : formData.echo.isLive ? 'Not connected' : 'Test'}
              </span>
            </button>
          ))}
        </div>

        {activeCarrier === 'jeebly' && (
          <div className="bg-surface rounded-2xl p-4 border border-line space-y-4 text-xs">
            <div data-testid="jeebly-mode" role="status" className={`rounded-xl border p-3 space-y-1 ${modeBox.tone}`}>
              <div className="font-bold text-sm">{modeBox.title}</div>
              <p>{modeBox.text}</p>
              {mode !== 'live' && hasLiveKeys && <p className="font-semibold">{LIVE_OFF_WARNING}</p>}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <fieldset className="space-y-2 rounded-xl border border-line p-3">
                <legend className="px-1 font-bold text-ink">Sandbox keys (test bookings)</legend>
                <label className="block">
                  <span className="block text-ink-soft font-semibold mb-1">Sandbox API key</span>
                  <input type="password" autoComplete="off" placeholder={secretPlaceholder(secretsSet['jeebly.sandboxApiKey'])} value={j.sandboxApiKey ?? ''} onChange={(e) => setJ({ sandboxApiKey: e.target.value })} className={`${input} font-mono`} />
                </label>
                <label className="block">
                  <span className="block text-ink-soft font-semibold mb-1">Sandbox client key</span>
                  <input type="password" autoComplete="off" placeholder={secretPlaceholder(secretsSet['jeebly.sandboxClientKey'])} value={j.sandboxClientKey ?? ''} onChange={(e) => setJ({ sandboxClientKey: e.target.value })} className={`${input} font-mono`} />
                </label>
              </fieldset>
              <fieldset className="space-y-2 rounded-xl border border-line p-3">
                <legend className="px-1 font-bold text-ink">Live keys (real shipments)</legend>
                <label className="block">
                  <span className="block text-ink-soft font-semibold mb-1">Live API key</span>
                  <input type="password" autoComplete="off" placeholder={secretPlaceholder(secretsSet['jeebly.apiKey'])} value={j.apiKey} onChange={(e) => setJ({ apiKey: e.target.value })} className={`${input} font-mono`} />
                </label>
                <label className="block">
                  <span className="block text-ink-soft font-semibold mb-1">Live client key</span>
                  <input type="password" autoComplete="off" placeholder={secretPlaceholder(secretsSet['jeebly.clientKey'])} value={j.clientKey} onChange={(e) => setJ({ clientKey: e.target.value })} className={`${input} font-mono`} />
                </label>
                <label className="block">
                  <span className="block text-ink-soft font-semibold mb-1">Live address (from Jeebly)</span>
                  <input type="url" inputMode="url" autoComplete="off" value={j.liveBaseUrl ?? ''} onChange={(e) => setJ({ liveBaseUrl: e.target.value })} maxLength={200} placeholder="https://….jeebly.com" className={`${input} font-mono`} />
                  <span className="block text-ink-muted mt-1">Jeebly gives it with your production keys. Only an https address on jeebly.com is accepted.</span>
                </label>
              </fieldset>
              <label className="block">
                <span className="block text-ink-soft font-semibold mb-1">Default service</span>
                <select value={j.serviceType} onChange={(e) => setJ({ serviceType: e.target.value as 'Scheduled' | 'Express' })} className={input}>
                  <option value="Scheduled">Scheduled (next day)</option>
                  <option value="Express">Express (same day)</option>
                </select>
              </label>
            </div>
            <p className="text-ink-muted">Keys are saved with “Save Carrier Settings”, kept on the server and never shown again.</p>

            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => handleTestConnection('jeebly')} disabled={testing} className={`${button} border border-line-strong bg-surface text-ink hover:bg-sand`}>
                <RefreshCw className={`w-3.5 h-3.5 ${testing ? 'animate-spin' : ''}`} aria-hidden="true" />
                <span>{testing ? 'Testing…' : `Test connection (${j.isLive ? 'live' : 'sandbox'})`}</span>
              </button>
              <button type="button" onClick={runCheck} disabled={checking} className={`${button} bg-ink text-paper`}>
                <FlaskConical className="w-3.5 h-3.5 text-gold-light" aria-hidden="true" />
                <span>{checking ? 'Running the Sandbox check…' : 'Run the Sandbox check'}</span>
              </button>
            </div>

            {/* Sandbox check: the gate before Live mode */}
            <div data-testid="sandbox-check" className="rounded-xl border border-line p-3 space-y-2">
              <div className="font-bold text-ink">Sandbox check</div>
              <p className="text-ink-muted">
                Books one PREPAID dummy order marked TEST in Jeebly&apos;s demo system (saved sandbox keys, your pickup details), then fetches its label PDF, tracks it and cancels it. Live mode can be turned on after a passed check (valid 30 days).
              </p>
              {check ? (
                <>
                  <p className={`font-semibold ${check.passed ? 'text-success' : 'text-danger'}`}>
                    {check.passed ? 'Passed' : 'Failed'} on {new Date(check.at).toLocaleString()}
                    {check.passed && !check.fresh ? ' (older than 30 days: run it again)' : ''}
                  </p>
                  <ul className="space-y-1">
                    {check.steps.map((st) => (
                      <li key={st.step} className="flex items-start gap-1.5">
                        {st.result === 'pass' ? (
                          <CheckCircle2 className="w-4 h-4 shrink-0 text-success" aria-label="passed" />
                        ) : st.result === 'fail' ? (
                          <XCircle className="w-4 h-4 shrink-0 text-danger" aria-label="failed" />
                        ) : (
                          <MinusCircle className="w-4 h-4 shrink-0 text-ink-muted" aria-label="not checked" />
                        )}
                        <span className="min-w-0 break-anywhere">
                          <strong>{STEP_NAMES[st.step]}</strong>
                          {st.result === 'not_checked' ? ' – not checked' : ''}
                          {st.httpStatus ? ` (HTTP ${st.httpStatus})` : ''}: {st.said}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="text-ink-soft">Not run yet.</p>
              )}
            </div>

            {/* Live mode: on only after a passed check, or the owner's typed override */}
            <div className="rounded-xl border border-line p-3 space-y-2">
              <div className="font-bold text-ink">Live mode</div>
              {j.isLive ? (
                <button type="button" disabled={liveBusy} onClick={() => setLive(false)} className={`${button} border border-line-strong bg-surface text-ink hover:bg-sand`}>
                  <Power className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Turn off Live mode (back to Test)</span>
                </button>
              ) : (
                <>
                  <button type="button" disabled={liveBusy || !check?.fresh || !settings.jeebly.liveBaseUrl} onClick={() => setLive(true)} className={`${button} bg-success text-paper`}>
                    <Power className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Turn on Live mode</span>
                  </button>
                  {!settings.jeebly.liveBaseUrl && <p className="text-ink-muted">Add Jeebly&apos;s live address above and save it first.</p>}
                  {!check?.fresh && <p className="text-ink-muted">Run the Sandbox check first: Live mode turns on after a passed check.</p>}
                  {!check?.fresh && (
                    <details className="rounded-lg bg-ivory p-2">
                      <summary className="cursor-pointer font-semibold text-ink-soft">Turn on without a sandbox check</summary>
                      <div className="mt-2 space-y-2">
                        <p className="text-danger">Not recommended: bookings go straight to Jeebly for real, untested. Recorded in the audit log. Type {LIVE_OVERRIDE_PHRASE} to confirm.</p>
                        <input aria-label="Confirm phrase" value={overridePhrase} onChange={(e) => setOverridePhrase(e.target.value)} className={`${input} font-mono`} autoComplete="off" />
                        <button type="button" disabled={liveBusy || overridePhrase !== LIVE_OVERRIDE_PHRASE} onClick={() => setLive(true, overridePhrase)} className={`${button} bg-danger text-paper`}>
                          Turn on Live mode without a check
                        </button>
                      </div>
                    </details>
                  )}
                </>
              )}
              {liveError && <p role="alert" className="text-danger font-semibold">{liveError}</p>}
            </div>
          </div>
        )}

        {activeCarrier === 'echo' && (
          <div className="bg-surface rounded-2xl p-4 border border-line space-y-4 text-xs">
            <div role="status" className="rounded-xl border border-warning-line bg-warning-soft p-3 text-warning space-y-1">
              <div className="font-bold text-sm">Eco Express: test (practice) bookings only</div>
              <p>{ECO_LIVE_NOT_CONNECTED}</p>
              {formData.echo.isLive && (
                <button type="button" onClick={() => setFormData({ ...formData, echo: { ...formData.echo, isLive: false } })} className={`${button} border border-warning-line bg-surface text-warning`}>
                  Switch Eco Express back to Test mode
                </button>
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="block">
                <span className="block text-ink-soft font-semibold mb-1">API token (kept for when it is connected)</span>
                <input type="password" autoComplete="off" placeholder={secretPlaceholder(secretsSet['echo.apiKey'])} value={formData.echo.apiKey} onChange={(e) => setFormData({ ...formData, echo: { ...formData.echo, apiKey: e.target.value } })} className={`${input} font-mono`} />
              </label>
              <label className="block">
                <span className="block text-ink-soft font-semibold mb-1">Account number</span>
                <input type="text" value={formData.echo.accountId} onChange={(e) => setFormData({ ...formData, echo: { ...formData.echo, accountId: e.target.value } })} maxLength={80} className={`${input} font-mono`} />
              </label>
            </div>
          </div>
        )}

        {testResult && (
          <p role="status" className={`rounded-xl border p-3 text-xs font-semibold break-anywhere ${testResult.ok ? 'border-success-line bg-success-soft text-success' : 'border-line-strong bg-ivory text-ink'}`}>
            {testResult.text}
          </p>
        )}

        {/* SAVE CHANGES */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
          {savedSuccess && (
            <span className="text-success font-bold text-xs flex items-center gap-1">
              <CheckCircle2 className="w-4 h-4" />
              Saved on the server.
            </span>
          )}
          {saveError && (
            <span role="alert" className="text-danger font-semibold text-xs flex items-center gap-1">
              <AlertCircle className="w-4 h-4" />
              {saveError}
            </span>
          )}
          <button type="button" onClick={handleSave} disabled={saving} className={`${button} ml-auto bg-ink text-paper px-5 py-2.5 shadow`}>
            {saving ? 'Saving…' : 'Save Carrier Settings'}
          </button>
          {auto && autosave.bar}
        </div>
      </div>
    </div>
  );
};
