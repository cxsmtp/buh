'use client';

import React, { useState } from 'react';
import { CourierSettings, CourierProvider } from '@/types';
import { Truck, ShieldCheck, CheckCircle2, AlertCircle, RefreshCw, ExternalLink, Settings, Key, Globe, Layers } from 'lucide-react';
import { useAutoSave, type AutoSaveHooks } from './settings/useAutoSave';
import { postJson } from '@/lib/apiClient';

interface AdminCouriersTabProps {
  settings: CourierSettings;
  /** Which secret keys are saved on the server (their values never come back). */
  secretsSet: Record<string, boolean>;
  /** Saves on the server; resolves to an error message, or null when saved. */
  onUpdateSettings: (newSettings: CourierSettings) => Promise<string | null>;
  auto?: AutoSaveHooks;
}

/** Placeholder for a write-only key field. */
export function secretPlaceholder(saved: boolean | undefined) {
  return saved ? '•••• saved — leave blank to keep' : 'Not set';
}

export const AdminCouriersTab: React.FC<AdminCouriersTabProps> = ({
  settings,
  secretsSet,
  onUpdateSettings,
  auto,
}) => {
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);
  const [activeCarrier, setActiveCarrier] = useState<'jeebly' | 'echo'>('jeebly');
  const [testResult, setTestResult] = useState<Record<string, unknown> | null>(null);
  const [testing, setTesting] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);

  // Local form state
  const [formData, setFormData] = useState<CourierSettings>(settings);
  // Keys are never autosaved (half-typed ones would replace working ones): Save sends them.
  const autosave = useAutoSave({
    settingsKey: 'courier',
    value: { ...formData, jeebly: { ...formData.jeebly, apiKey: '', clientKey: '' }, echo: { ...formData.echo, apiKey: '' } },
    enabled: Boolean(auto),
    ...auto,
  });

  const handleTestConnection = async (provider: 'jeebly' | 'echo') => {
    setTesting(true);
    setTestResult(null);

    const { data } = await postJson('/api/courier/test', { provider, settings: formData });
    setTestResult(data);
    setTesting(false);
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

  return (
    <div className="space-y-4">
      {/* Header Info */}
      <div className="bg-surface rounded-2xl p-4 border border-line shadow-sm space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Truck className="w-5 h-5 text-gold" />
            <h3 className="font-serif font-bold text-base text-ink">
              Courier Integration Hub (Jeebly & Eco Express)
            </h3>
          </div>
          <span className="text-[10px] bg-success-soft text-success font-bold px-2.5 py-0.5 rounded-full border border-success-line">
            Dual Seamless Carrier Active
          </span>
        </div>
        <p className="text-xs text-ink-soft leading-relaxed">
          Both logistics platforms are integrated. Orders are automatically assigned based on payment method, generating compliant Airway Bills (AWB) and printable shipping labels upon confirmation.
        </p>
      </div>

      {/* AUTOMATION ROUTING RULES */}
      <div className="bg-gradient-to-br from-warning-soft/60 via-ivory to-warning-soft/30 rounded-2xl p-4 border border-warning-line/80 space-y-3">
        <span className="text-xs font-black uppercase tracking-wider text-ink block border-b border-warning-line/60 pb-1.5">
          Automatic Carrier Routing Rules
        </span>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
          {/* Rule 1: COD Routing */}
          <div className="bg-surface p-3 rounded-xl border border-line space-y-1.5 shadow-sm">
            <div className="flex items-center justify-between">
              <span className="font-bold text-ink">1. Cash On Delivery (COD)</span>
              <span className="text-[10px] bg-danger-soft text-danger font-bold px-2 py-0.5 rounded">
                COD
              </span>
            </div>
            <p className="text-[11px] text-ink-muted">
              When a customer places a COD order, route by default to:
            </p>
            <select
              value={formData.autoAssignRules.codCourier}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  autoAssignRules: {
                    ...formData.autoAssignRules,
                    codCourier: e.target.value as CourierProvider,
                  },
                })
              }
              className="w-full px-2.5 py-1.5 rounded-lg border border-line-strong font-semibold bg-ivory text-xs"
            >
              <option value="jeebly">Jeebly Logistics (Recommended for UAE COD)</option>
              <option value="echo">Eco Express Courier</option>
            </select>
          </div>

          {/* Rule 2: Prepaid Routing */}
          <div className="bg-surface p-3 rounded-xl border border-line space-y-1.5 shadow-sm">
            <div className="flex items-center justify-between">
              <span className="font-bold text-ink">2. Prepaid / Bank Transfer</span>
              <span className="text-[10px] bg-success-soft text-success font-bold px-2 py-0.5 rounded">
                Prepaid
              </span>
            </div>
            <p className="text-[11px] text-ink-muted">
              When payment is transferred or settled in advance, route to:
            </p>
            <select
              value={formData.autoAssignRules.prepaidCourier}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  autoAssignRules: {
                    ...formData.autoAssignRules,
                    prepaidCourier: e.target.value as CourierProvider,
                  },
                })
              }
              className="w-full px-2.5 py-1.5 rounded-lg border border-line-strong font-semibold bg-ivory text-xs"
            >
              <option value="echo">Eco Express Courier (Recommended for Prepaid)</option>
              <option value="jeebly">Jeebly Logistics</option>
            </select>
          </div>
        </div>
      </div>

      {/* CARRIER TABS: JEEBLY VS ECO EXPRESS */}
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2 border-b border-line pb-2">
          <button
            onClick={() => {
              setActiveCarrier('jeebly');
              setTestResult(null);
            }}
            className={`flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-xs font-bold transition-all min-w-0 ${
              activeCarrier === 'jeebly'
                ? 'bg-ink text-paper shadow-sm'
                : 'bg-surface text-ink-soft hover:bg-sand border border-line'
            }`}
          >
            <span>Jeebly Logistics (UAE)</span>
            <span className="hidden md:inline text-[10px] px-1.5 py-0.2 rounded-full bg-gold text-ink font-bold">
              integration.jeebly.com
            </span>
          </button>

          <button
            onClick={() => {
              setActiveCarrier('echo');
              setTestResult(null);
            }}
            className={`flex items-center justify-center gap-2 px-3 py-2 rounded-xl text-xs font-bold transition-all min-w-0 ${
              activeCarrier === 'echo'
                ? 'bg-ink text-paper shadow-sm'
                : 'bg-surface text-ink-soft hover:bg-sand border border-line'
            }`}
          >
            <span>Eco Express Courier</span>
            <span className="hidden md:inline text-[10px] px-1.5 py-0.2 rounded-full bg-ink-soft text-paper font-bold">
              Apiary / ecofreight.ae
            </span>
          </button>
        </div>

        {/* JEEBLY DETAILS & CONFIG */}
        {activeCarrier === 'jeebly' && (
          <div className="bg-surface rounded-2xl p-4 border border-line space-y-4 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-line">
              <div className="min-w-0">
                <strong className="text-ink text-sm block">Jeebly Logistics Configuration</strong>
                <span className="text-ink-muted text-[11px]">
                  Official API Documentation: <a href="https://integration.jeebly.com/v1/api-reference.html" target="_blank" rel="noopener noreferrer" className="text-gold-deep underline font-medium">integration.jeebly.com/v1</a>
                </span>
              </div>
              <button
                type="button"
                onClick={() => handleTestConnection('jeebly')}
                disabled={testing}
                className="flex items-center gap-1.5 bg-ink hover:bg-ink text-paper px-3 py-1.5 rounded-xl font-semibold transition-all disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 text-gold-light ${testing ? 'animate-spin' : ''}`} />
                <span>{testing ? 'Testing...' : 'Test Jeebly API'}</span>
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-ink-soft font-semibold mb-1">
                  XApiKey Header:
                </label>
                <input
                  type="password"
                  autoComplete="off"
                  placeholder={secretPlaceholder(secretsSet['jeebly.apiKey'])}
                  value={formData.jeebly.apiKey}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      jeebly: { ...formData.jeebly, apiKey: e.target.value },
                    })
                  }
                  className="w-full px-3 py-2 rounded-xl border border-line-strong font-mono text-xs"
                />
              </div>

              <div>
                <label className="block text-ink-soft font-semibold mb-1">
                  ClientKey Header:
                </label>
                <input
                  type="password"
                  autoComplete="off"
                  placeholder={secretPlaceholder(secretsSet['jeebly.clientKey'])}
                  value={formData.jeebly.clientKey}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      jeebly: { ...formData.jeebly, clientKey: e.target.value },
                    })
                  }
                  className="w-full px-3 py-2 rounded-xl border border-line-strong font-mono text-xs"
                />
              </div>

              <div>
                <label className="block text-ink-soft font-semibold mb-1">
                  Default Service Type:
                </label>
                <select
                  value={formData.jeebly.serviceType}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      jeebly: { ...formData.jeebly, serviceType: e.target.value as 'Scheduled' | 'Express' },
                    })
                  }
                  className="w-full px-3 py-2 rounded-xl border border-line-strong bg-surface"
                >
                  <option value="Scheduled">Scheduled Delivery (Next-Day Forward)</option>
                  <option value="Express">Express Same-Day Intra-Emirate</option>
                </select>
              </div>

              <div>
                <label className="block text-ink-soft font-semibold mb-1">
                  Warehouse Pickup Location:
                </label>
                <input
                  type="text"
                  value={formData.jeebly.pickupLocationName}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      jeebly: { ...formData.jeebly, pickupLocationName: e.target.value },
                    })
                  }
                  className="w-full px-3 py-2 rounded-xl border border-line-strong"
                />
              </div>
            </div>
          </div>
        )}

        {/* ECO EXPRESS DETAILS & CONFIG */}
        {activeCarrier === 'echo' && (
          <div className="bg-surface rounded-2xl p-4 border border-line space-y-4 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-line">
              <div className="min-w-0">
                <strong className="text-ink text-sm block">Eco Express Courier Configuration</strong>
                <span className="text-ink-muted text-[11px]">
                  Official Apiary Spec: <a href="https://ecoexpress.docs.apiary.io/#" target="_blank" rel="noopener noreferrer" className="text-gold-deep underline font-medium">ecoexpress.docs.apiary.io</a>
                </span>
              </div>
              <button
                type="button"
                onClick={() => handleTestConnection('echo')}
                disabled={testing}
                className="flex items-center gap-1.5 bg-ink hover:bg-ink text-paper px-3 py-1.5 rounded-xl font-semibold transition-all disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 text-gold-light ${testing ? 'animate-spin' : ''}`} />
                <span>{testing ? 'Testing...' : 'Test Eco Express API'}</span>
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-ink-soft font-semibold mb-1">
                  Authorization Bearer Token:
                </label>
                <input
                  type="password"
                  autoComplete="off"
                  placeholder={secretPlaceholder(secretsSet['echo.apiKey'])}
                  value={formData.echo.apiKey}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      echo: { ...formData.echo, apiKey: e.target.value },
                    })
                  }
                  className="w-full px-3 py-2 rounded-xl border border-line-strong font-mono text-xs"
                />
              </div>

              <div>
                <label className="block text-ink-soft font-semibold mb-1">
                  Account Number (account_No):
                </label>
                <input
                  type="text"
                  value={formData.echo.accountId}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      echo: { ...formData.echo, accountId: e.target.value },
                    })
                  }
                  className="w-full px-3 py-2 rounded-xl border border-line-strong font-mono text-xs"
                />
              </div>

              <div>
                <label className="block text-ink-soft font-semibold mb-1">
                  Service Tier:
                </label>
                <input
                  type="text"
                  value={formData.echo.serviceTier}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      echo: { ...formData.echo, serviceTier: e.target.value },
                    })
                  }
                  className="w-full px-3 py-2 rounded-xl border border-line-strong"
                />
              </div>

              <div>
                <label className="block text-ink-soft font-semibold mb-1">
                  Origin Dispatch Hub Code:
                </label>
                <input
                  type="text"
                  value={formData.echo.hubCode}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      echo: { ...formData.echo, hubCode: e.target.value },
                    })
                  }
                  className="w-full px-3 py-2 rounded-xl border border-line-strong"
                />
              </div>
            </div>
          </div>
        )}

        {/* TEST RESULTS VIEWER */}
        {testResult && (
          <div className="bg-ink text-sand p-4 rounded-2xl border border-ink text-xs space-y-2 animate-in fade-in-50">
            <div className="flex items-center justify-between text-gold-light font-bold border-b border-ink pb-1.5">
              <span className="flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 text-success" />
                <span>API Connection Diagnostics Result:</span>
              </span>
              <span className="text-[10px] text-ink-muted">Response 200 OK</span>
            </div>
            <pre className="font-mono text-[11px] overflow-x-auto text-success p-2 bg-black/50 rounded-lg">
              {JSON.stringify(testResult, null, 2)}
            </pre>
          </div>
        )}

        {/* SAVE CHANGES */}
        <div className="flex items-center justify-between pt-2">
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
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="ml-auto bg-ink hover:bg-ink disabled:opacity-60 text-paper font-bold text-xs px-5 py-2.5 rounded-xl shadow transition-all"
          >
            {saving ? 'Saving…' : 'Save Carrier Settings'}
          </button>
          {auto && autosave.bar}
        </div>
      </div>
    </div>
  );
};
