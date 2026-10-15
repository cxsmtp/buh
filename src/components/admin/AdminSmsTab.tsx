'use client';

import React, { useState } from 'react';
import { SmsGatewaySettings, SmsProvider } from '@/types';
import { 
  Smartphone, 
  Send, 
  Check, 
  ShieldCheck, 
  Key, 
  ExternalLink, 
  CheckCircle2, 
  AlertCircle,
  HelpCircle,
  Server,
  Zap,
  RefreshCw
} from 'lucide-react';
import { INITIAL_SMS_SETTINGS } from '@/data/initialData';
import { postJson } from '@/lib/apiClient';
import { secretPlaceholder } from './AdminCouriersTab';

interface AdminSmsTabProps {
  smsSettings: SmsGatewaySettings;
  /** Which secret keys are saved on the server (their values never come back). */
  secretsSet: Record<string, boolean>;
  /** Saves on the server; resolves to an error message, or null when saved. */
  onUpdateSmsSettings: (updated: SmsGatewaySettings) => Promise<string | null>;
}

export const AdminSmsTab: React.FC<AdminSmsTabProps> = ({
  smsSettings,
  secretsSet,
  onUpdateSmsSettings,
}) => {
  const [saveError, setSaveError] = useState('');
  const [provider, setProvider] = useState<SmsProvider>(smsSettings.provider && smsSettings.provider !== 'unifonic' ? smsSettings.provider : 'twilio');
  const [senderId, setSenderId] = useState(smsSettings.senderId || 'BUHome');

  // Twilio
  const [twilioAccountSid, setTwilioAccountSid] = useState(smsSettings.twilio?.accountSid || '');
  const [twilioAuthToken, setTwilioAuthToken] = useState(smsSettings.twilio?.authToken || '');
  const [twilioFromNumber, setTwilioFromNumber] = useState(smsSettings.twilio?.fromNumber || '');

  // Infobip
  const [infobipApiKey, setInfobipApiKey] = useState(smsSettings.infobip?.apiKey || '');
  const [infobipBaseUrl, setInfobipBaseUrl] = useState(smsSettings.infobip?.baseUrl || 'https://api.infobip.com');


  // Webhook
  const [webhookUrl, setWebhookUrl] = useState(smsSettings.customWebhook?.endpointUrl || '');
  const [webhookBearer, setWebhookBearer] = useState(smsSettings.customWebhook?.bearerToken || '');

  // Firebase Phone Authentication (public web config, not secrets)
  const [fbApiKey, setFbApiKey] = useState(smsSettings.firebase?.apiKey || '');
  const [fbAuthDomain, setFbAuthDomain] = useState(smsSettings.firebase?.authDomain || '');
  const [fbProjectId, setFbProjectId] = useState(smsSettings.firebase?.projectId || '');
  const [fbAppId, setFbAppId] = useState(smsSettings.firebase?.appId || '');
  const firebaseConfig = { apiKey: fbApiKey.trim(), authDomain: fbAuthDomain.trim(), projectId: fbProjectId.trim(), appId: fbAppId.trim() };

  // Testing State
  const [testPhone, setTestPhone] = useState('+971 5');
  const [isSendingTest, setIsSendingTest] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message: string;
    provider?: string;
    devOtpCode?: string;
  } | null>(null);

  const [savedSuccess, setSavedSuccess] = useState(false);

  const handleSave = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const updated: SmsGatewaySettings = {
      provider,
      senderId: senderId.trim() || 'BUHome',
      twilio: {
        accountSid: twilioAccountSid.trim(),
        authToken: twilioAuthToken.trim(),
        fromNumber: twilioFromNumber.trim(),
      },
      infobip: {
        apiKey: infobipApiKey.trim(),
        baseUrl: infobipBaseUrl.trim(),
        fromSender: senderId.trim() || 'BUHome',
      },
      customWebhook: {
        endpointUrl: webhookUrl.trim(),
        bearerToken: webhookBearer.trim(),
      },
      firebase: firebaseConfig,
      isEnabled: true,
    };

    setSaveError('');
    const error = await onUpdateSmsSettings(updated);
    if (error) {
      setSaveError(error);
      return;
    }
    setSavedSuccess(true);
    setTimeout(() => setSavedSuccess(false), 3000);
  };

  const handleSendTestSms = async () => {
    if (testPhone.length < 8) {
      alert('Please enter a valid phone number (e.g. +971 50 123 4567)');
      return;
    }

    setIsSendingTest(true);
    setTestResult(null);

    const currentConfig: SmsGatewaySettings = {
      provider,
      senderId,
      twilio: {
        accountSid: twilioAccountSid.trim(),
        authToken: twilioAuthToken.trim(),
        fromNumber: twilioFromNumber.trim(),
      },
      infobip: {
        apiKey: infobipApiKey.trim(),
        baseUrl: infobipBaseUrl.trim(),
        fromSender: senderId.trim() || 'BUHome',
      },
      customWebhook: {
        endpointUrl: webhookUrl.trim(),
        bearerToken: webhookBearer.trim(),
      },
      firebase: firebaseConfig,
      isEnabled: true,
    };

    const { data } = await postJson<{ success: boolean; message: string; provider?: string; devOtpCode?: string }>(
      '/api/admin/sms-test',
      { phone: testPhone, settings: currentConfig }
    );
    setTestResult({ success: Boolean(data.success), message: data.message || 'Test failed.', provider: data.provider, devOtpCode: data.devOtpCode });
    setIsSendingTest(false);
  };

  // A key counts as present when typed now or already saved on the server.
  const isConfigured =
    (provider === 'twilio' && twilioAccountSid && (twilioAuthToken || secretsSet['twilio.authToken'])) ||
    (provider === 'infobip' && (infobipApiKey || secretsSet['infobip.apiKey'])) ||
    (provider === 'custom_webhook' && webhookUrl) ||
    (provider === 'firebase' && firebaseConfig.apiKey && firebaseConfig.authDomain && firebaseConfig.projectId && firebaseConfig.appId);

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white p-4 rounded-2xl border border-stone-200 shadow-xs">
        <div>
          <div className="flex items-center gap-2">
            <Smartphone className="w-5 h-5 text-[#c5a059]" />
            <h2 className="font-serif text-lg font-bold text-[#0f1c2e]">
              Real SMS & WhatsApp OTP Gateway
            </h2>
          </div>
          <p className="text-xs text-stone-500 mt-0.5">
            Connect a genuine telecommunications gateway to dispatch physical SMS verification codes to UAE mobile phones.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleSave}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-bold text-white bg-[#0f1c2e] hover:bg-stone-800 rounded-xl transition-colors shadow"
          >
            <Check className="w-4 h-4 text-amber-300" />
            <span>Save Gateway Credentials</span>
          </button>
        </div>
      </div>

      {saveError && (
        <div role="alert" className="bg-red-50 text-red-800 border border-red-200 p-3.5 rounded-2xl text-xs font-medium">
          {saveError}
        </div>
      )}

      {savedSuccess && (
        <div className="bg-emerald-50 text-emerald-900 border border-emerald-200 p-3.5 rounded-2xl text-xs flex items-center justify-between animate-in fade-in-50">
          <div className="flex items-center gap-2 font-medium">
            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
            <span>Saved on the server. Checkout now sends codes through this gateway (unless one is set in the server environment).</span>
          </div>
          <span className="text-[10px] bg-emerald-200 text-emerald-900 font-bold px-2 py-0.5 rounded-full">
            Active
          </span>
        </div>
      )}

      {/* Gateway Status Summary Card */}
      <div className={`p-4 rounded-2xl border text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
        isConfigured 
          ? 'bg-emerald-50/80 border-emerald-200 text-emerald-950' 
          : 'bg-amber-50/80 border-amber-200 text-amber-950'
      }`}>
        <div className="flex items-center gap-3">
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
            isConfigured ? 'bg-emerald-600 text-white' : 'bg-amber-500 text-stone-950'
          }`}>
            <Server className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <strong className="text-sm font-bold">
                {isConfigured ? `Real SMS Gateway Connected (${provider.toUpperCase()})` : 'Sandbox / Unconfigured Gateway'}
              </strong>
              <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full ${
                isConfigured ? 'bg-emerald-200 text-emerald-900' : 'bg-amber-200 text-amber-900'
              }`}>
                {isConfigured ? 'LIVE CARRIER DISPATCH' : 'SANDBOX MODE'}
              </span>
            </div>
            <p className="text-[11px] opacity-80 mt-0.5">
              {isConfigured
                ? `Physical SMS codes are being sent directly to customer phones via ${provider.toUpperCase()}.`
                : 'Enter your Twilio or Infobip API keys below to deliver real physical SMS to mobile carrier towers (Etisalat & du).'}
            </p>
          </div>
        </div>
      </div>

      {/* TWO COLUMN GRID: Configuration & Live Test */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* ================= COLUMN 1: GATEWAY CONFIGURATION ================= */}
        <div className="bg-white rounded-3xl p-5 border border-stone-200 shadow-xs space-y-4">
          <div className="border-b border-stone-100 pb-3">
            <h3 className="font-serif font-bold text-base text-[#0f1c2e] flex items-center gap-2">
              <Key className="w-4 h-4 text-[#c5a059]" />
              <span>1. Choose SMS Gateway Provider</span>
            </h3>
            <p className="text-xs text-stone-500">
              Select your telecommunications carrier provider.
            </p>
          </div>

          {/* Provider Selection Tabs */}
          <div className="grid grid-cols-2 gap-2 text-xs">
            {[
              { id: 'twilio', name: 'Twilio SMS', badge: 'Recommended' },
              { id: 'infobip', name: 'Infobip UAE', badge: 'Direct Etisalat' },
              { id: 'custom_webhook', name: 'Webhook', badge: 'Custom' },
              { id: 'firebase', name: 'Firebase Phone Auth', badge: 'Google, Blaze plan' },
            ].map((p) => (
              <button
                key={p.id}
                type="button"
                aria-pressed={provider === p.id}
                onClick={() => setProvider(p.id as SmsProvider)}
                className={`p-2.5 rounded-xl border text-center transition-all ${
                  provider === p.id
                    ? 'border-[#0f1c2e] bg-[#0f1c2e] text-white shadow-xs font-bold'
                    : 'border-stone-200 bg-white text-stone-700 hover:border-stone-300'
                }`}
              >
                <span className="block text-xs">{p.name}</span>
                <span className={`text-[9px] block opacity-80 mt-0.5`}>{p.badge}</span>
              </button>
            ))}
          </div>

          {/* SENDER ID (Firebase sends its own message, so it does not apply there) */}
          {provider !== 'firebase' && <div className="text-xs">
            <label className="block text-stone-800 font-semibold mb-1">
              Sender ID / Brand Alphanumeric Header
            </label>
            <input
              type="text"
              value={senderId}
              onChange={(e) => setSenderId(e.target.value)}
              placeholder="BUHome"
              maxLength={11}
              className="w-full px-3.5 py-2.5 rounded-xl border border-stone-300 bg-white text-stone-900 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-[#c5a059]"
            />
            <p className="text-[10px] text-stone-400 mt-1">
              Up to 11 characters. Displays as the sender name in the customer&apos;s SMS inbox.
            </p>
          </div>}

          {/* FIREBASE CONFIG */}
          {provider === 'firebase' && (
            <div className="space-y-3 p-3.5 bg-stone-50 rounded-2xl border border-stone-200 text-xs animate-in fade-in-50">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-bold text-stone-900">Firebase Phone Authentication</span>
                <a
                  href="https://console.firebase.google.com/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] text-[#c5a059] hover:underline flex items-center gap-1 font-semibold"
                >
                  <span>Firebase console</span>
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>

              <div role="note" className="p-2.5 rounded-xl bg-amber-50 border border-amber-200 text-amber-950 text-[11px] leading-relaxed">
                <strong>Costs money per SMS.</strong> Firebase only sends phone codes on the paid <strong>Blaze</strong> plan, and Google bills
                every SMS it sends (UAE numbers are among the pricier destinations). Set a budget alert in Google Cloud billing.
              </div>

              <ol className="list-decimal list-inside space-y-1 text-stone-600 text-[11px] leading-relaxed">
                <li>Create a Firebase project in the Firebase console.</li>
                <li>Authentication → Sign-in method: turn on <strong>Phone</strong>.</li>
                <li>Authentication → Settings → <strong>Authorized domains</strong>: add this shop&apos;s domain.</li>
                <li>Upgrade the project to the <strong>Blaze</strong> (pay as you go) plan.</li>
                <li>Project settings → Your apps → add a <strong>Web app</strong>, then copy its config values below.</li>
              </ol>

              {([
                ['fb-api-key', 'API key (apiKey)', 'AIza…', fbApiKey, setFbApiKey],
                ['fb-auth-domain', 'Auth domain (authDomain)', 'your-project.firebaseapp.com', fbAuthDomain, setFbAuthDomain],
                ['fb-project-id', 'Project ID (projectId)', 'your-project', fbProjectId, setFbProjectId],
                ['fb-app-id', 'App ID (appId)', '1:123456789012:web:abc123…', fbAppId, setFbAppId],
              ] as const).map(([id, label, placeholder, value, set]) => (
                <div key={id}>
                  <label htmlFor={id} className="block text-stone-700 font-semibold mb-1">
                    {label}:
                  </label>
                  <input
                    id={id}
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={placeholder}
                    value={value}
                    onChange={(e) => set(e.target.value)}
                    className="w-full px-3.5 py-2 rounded-xl border border-stone-300 bg-white text-stone-900 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-[#c5a059]"
                  />
                </div>
              ))}
              <p className="text-[10px] text-stone-500 leading-relaxed">
                These values are public (every shopper&apos;s browser receives them), not passwords. Keep the auth domain as
                <code className="mx-1 bg-stone-200 px-1 rounded font-mono">your-project.firebaseapp.com</code>: the shop&apos;s security policy allows that domain.
                A gateway set in the server environment (Twilio, Infobip, webhook) still takes precedence.
              </p>
            </div>
          )}

          {/* TWILIO CONFIG */}
          {provider === 'twilio' && (
            <div className="space-y-3 p-3.5 bg-stone-50 rounded-2xl border border-stone-200 text-xs animate-in fade-in-50">
              <div className="flex items-center justify-between">
                <span className="font-bold text-stone-900 flex items-center gap-1.5">
                  <span>Twilio Account Credentials</span>
                </span>
                <a
                  href="https://www.twilio.com/try-twilio"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] text-[#c5a059] hover:underline flex items-center gap-1 font-semibold"
                >
                  <span>Get Free Twilio Trial</span>
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>

              <div>
                <label className="block text-stone-700 font-semibold mb-1">
                  Twilio Account SID:
                </label>
                <input
                  type="text"
                  placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                  value={twilioAccountSid}
                  onChange={(e) => setTwilioAccountSid(e.target.value)}
                  className="w-full px-3.5 py-2 rounded-xl border border-stone-300 bg-white text-stone-900 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-[#c5a059]"
                />
              </div>

              <div>
                <label className="block text-stone-700 font-semibold mb-1">
                  Twilio Auth Token:
                </label>
                <input
                  type="password"
                  autoComplete="off"
                  placeholder={secretPlaceholder(secretsSet['twilio.authToken'])}
                  value={twilioAuthToken}
                  onChange={(e) => setTwilioAuthToken(e.target.value)}
                  className="w-full px-3.5 py-2 rounded-xl border border-stone-300 bg-white text-stone-900 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-[#c5a059]"
                />
              </div>

              <div>
                <label className="block text-stone-700 font-semibold mb-1">
                  Twilio Outbound Phone Number (E.164 format):
                </label>
                <input
                  type="text"
                  placeholder="+12025550143 or Twilio Messaging Service SID"
                  value={twilioFromNumber}
                  onChange={(e) => setTwilioFromNumber(e.target.value)}
                  className="w-full px-3.5 py-2 rounded-xl border border-stone-300 bg-white text-stone-900 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-[#c5a059]"
                />
              </div>
            </div>
          )}

          {/* INFOBIP CONFIG */}
          {provider === 'infobip' && (
            <div className="space-y-3 p-3.5 bg-stone-50 rounded-2xl border border-stone-200 text-xs animate-in fade-in-50">
              <div className="flex items-center justify-between">
                <span className="font-bold text-stone-900">Infobip UAE API Setup</span>
                <a
                  href="https://portal.infobip.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] text-[#c5a059] hover:underline flex items-center gap-1 font-semibold"
                >
                  <span>Infobip Portal</span>
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>

              <div>
                <label className="block text-stone-700 font-semibold mb-1">
                  API Key:
                </label>
                <input
                  type="password"
                  autoComplete="off"
                  placeholder={secretPlaceholder(secretsSet['infobip.apiKey'])}
                  value={infobipApiKey}
                  onChange={(e) => setInfobipApiKey(e.target.value)}
                  className="w-full px-3.5 py-2 rounded-xl border border-stone-300 bg-white text-stone-900 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-[#c5a059]"
                />
              </div>

              <div>
                <label className="block text-stone-700 font-semibold mb-1">
                  Infobip Base URL:
                </label>
                <input
                  type="text"
                  placeholder="https://xxxx.api.infobip.com"
                  value={infobipBaseUrl}
                  onChange={(e) => setInfobipBaseUrl(e.target.value)}
                  className="w-full px-3.5 py-2 rounded-xl border border-stone-300 bg-white text-stone-900 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-[#c5a059]"
                />
              </div>
            </div>
          )}

          {/* WEBHOOK CONFIG */}
          {provider === 'custom_webhook' && (
            <div className="space-y-3 p-3.5 bg-stone-50 rounded-2xl border border-stone-200 text-xs animate-in fade-in-50">
              <div>
                <label className="block text-stone-700 font-semibold mb-1">
                  Custom Endpoint URL:
                </label>
                <input
                  type="url"
                  placeholder="https://your-server.com/api/send-sms"
                  value={webhookUrl}
                  onChange={(e) => setWebhookUrl(e.target.value)}
                  className="w-full px-3.5 py-2 rounded-xl border border-stone-300 bg-white text-stone-900 text-xs focus:outline-none focus:ring-1 focus:ring-[#c5a059]"
                />
              </div>
              <div>
                <label className="block text-stone-700 font-semibold mb-1">
                  Bearer Token (Optional):
                </label>
                <input
                  type="password"
                  autoComplete="off"
                  placeholder={secretPlaceholder(secretsSet['customWebhook.bearerToken'])}
                  value={webhookBearer}
                  onChange={(e) => setWebhookBearer(e.target.value)}
                  className="w-full px-3.5 py-2 rounded-xl border border-stone-300 bg-white text-stone-900 text-xs focus:outline-none focus:ring-1 focus:ring-[#c5a059]"
                />
              </div>
            </div>
          )}

          <button
            type="button"
            onClick={handleSave}
            className="w-full py-3 bg-[#0f1c2e] hover:bg-stone-800 text-white font-bold text-xs rounded-xl shadow-md flex items-center justify-center gap-2 transition-all"
          >
            <Check className="w-4 h-4 text-amber-300" />
            <span>Save SMS Gateway Configuration</span>
          </button>
        </div>

        {/* ================= COLUMN 2: LIVE TEST SMS DISPATCHER ================= */}
        <div className="bg-white rounded-3xl p-5 border border-stone-200 shadow-xs space-y-5 flex flex-col justify-between">
          <div className="space-y-4">
            <div className="border-b border-stone-100 pb-3">
              <h3 className="font-serif font-bold text-base text-[#0f1c2e] flex items-center gap-2">
                <Send className="w-4 h-4 text-[#c5a059]" />
                <span>2. Send Live Test SMS to Your Mobile</span>
              </h3>
              <p className="text-xs text-stone-500">
                Verify immediate physical SMS delivery directly to your personal phone number.
              </p>
            </div>

            {provider === 'firebase' && (
              <div role="note" className="p-3.5 rounded-2xl bg-stone-50 border border-stone-200 text-[11px] text-stone-700 leading-relaxed">
                With Firebase, Google texts the code straight to the shopper&apos;s phone from their browser, so there is no test send
                from here. Save, then open the shop on your own phone, add something to the bag and verify your number at checkout.
                Each test is a billed SMS.
              </div>
            )}

            {/* Test Phone Input */}
            {provider !== 'firebase' && <div className="space-y-2 text-xs">
              <label className="block text-stone-800 font-semibold">
                Your Mobile Number (+971 or International):
              </label>
              <div className="flex gap-2">
                <input
                  type="tel"
                  value={testPhone}
                  onChange={(e) => setTestPhone(e.target.value)}
                  placeholder="+971 50 123 4567"
                  className="flex-1 min-w-0 px-3.5 py-2.5 rounded-xl border border-stone-300 bg-white text-stone-900 text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-[#c5a059]"
                />
                <button
                  type="button"
                  disabled={isSendingTest}
                  onClick={handleSendTestSms}
                  className="px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white font-bold text-xs rounded-xl shadow flex items-center gap-1.5 transition-all disabled:opacity-50 shrink-0"
                >
                  {isSendingTest ? (
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Send className="w-3.5 h-3.5" />
                  )}
                  <span>{isSendingTest ? 'Dispatching...' : 'Send Test SMS'}</span>
                </button>
              </div>
            </div>}

            {/* Test Result Display */}
            {testResult && (
              <div className={`p-4 rounded-2xl border text-xs space-y-2 animate-in fade-in-50 ${
                testResult.success
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-950'
                  : 'bg-red-50 border-red-200 text-red-950'
              }`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 font-bold">
                    {testResult.success ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                    ) : (
                      <AlertCircle className="w-4 h-4 text-red-600" />
                    )}
                    <span>{testResult.success ? 'SMS Dispatched' : 'Dispatch Failed'}</span>
                  </div>
                  {testResult.provider && (
                    <span className="text-[10px] bg-white px-2 py-0.5 rounded-full border border-emerald-300 font-semibold">
                      {testResult.provider}
                    </span>
                  )}
                </div>

                <p className="text-[11px] leading-relaxed">
                  {testResult.message}
                </p>

                {testResult.devOtpCode && (
                  <div className="bg-white p-2.5 rounded-xl border border-amber-200 text-[11px]">
                    <span className="text-stone-500 block">Generated Verification Code:</span>
                    <strong className="font-mono text-base text-[#0f1c2e] tracking-widest">{testResult.devOtpCode}</strong>
                  </div>
                )}
              </div>
            )}

            {/* Step-by-Step Instructions Card */}
            {provider !== 'firebase' && <div className="bg-stone-50 p-4 rounded-2xl border border-stone-200 text-xs space-y-2">
              <span className="font-bold text-stone-900 flex items-center gap-1.5">
                <HelpCircle className="w-3.5 h-3.5 text-[#c5a059]" />
                <span>How to Get Real SMS Delivery to UAE Mobiles:</span>
              </span>

              <ol className="list-decimal list-inside space-y-1 text-stone-600 text-[11px] leading-relaxed">
                <li>
                  Sign up for a free Twilio account at <a href="https://www.twilio.com/try-twilio" target="_blank" rel="noopener noreferrer" className="text-[#c5a059] underline font-medium">twilio.com/try-twilio</a> (includes trial balance).
                </li>
                <li>
                  Copy your <strong>Account SID</strong> and <strong>Auth Token</strong> from the Twilio Console.
                </li>
                <li>
                  Paste them in the fields on the left (or into <code className="bg-stone-200 px-1 py-0.5 rounded font-mono text-[10px]">.env.local</code>).
                </li>
                <li>
                  Enter your mobile number and tap <strong>&quot;Send Test SMS&quot;</strong> — the physical text message will arrive on your phone in 2-5 seconds!
                </li>
              </ol>
            </div>}
          </div>
        </div>

      </div>
    </div>
  );
};
