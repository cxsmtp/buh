'use client';

import React, { useState } from 'react';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { sendJson } from '@/lib/apiClient';

/**
 * "Set up Google Drive": the one-time setup in Google Cloud, in four short steps, each with a big
 * button to the exact console page (in the owner's project once its id is pasted), Copy buttons for
 * what to type, and a tick that the server remembers (kv, nothing secret). Google requires every app
 * that touches a Drive to be registered by the Drive's owner: the shop can't do this part for them.
 * If a page has moved, each step still says where to click.
 */

export type WizardStep = 'project' | 'api' | 'consent' | 'client';
export interface DriveWizard {
  done: WizardStep[];
  projectId: string;
}

export const APP_NAME = 'Beautiful UAE Home backups';
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const CLIENT_TYPE = 'TVs and Limited Input devices';
const CONSOLE = 'https://console.cloud.google.com';

/** A console page, in the owner's project when its id is known. */
export function consoleUrl(page: string, projectId: string): string {
  return `${CONSOLE}${page}${projectId ? `${page.includes('?') ? '&' : '?'}project=${encodeURIComponent(projectId)}` : ''}`;
}

/** The pages each step opens (checked against Google's own guides, October 2026). */
export function wizardLinks(projectId: string) {
  return {
    project: `${CONSOLE}/projectcreate`,
    api: consoleUrl('/apis/library/drive.googleapis.com', projectId),
    branding: consoleUrl('/auth/branding', projectId),
    audience: consoleUrl('/auth/audience', projectId),
    scopes: consoleUrl('/auth/scopes', projectId),
    client: consoleUrl('/auth/clients', projectId),
  };
}

const openButton = 'min-h-11 px-4 py-2 rounded-xl bg-ink text-paper text-xs font-bold inline-flex items-center justify-center gap-1.5';
const chip = 'min-h-9 px-2.5 py-1 rounded-lg border border-line-strong bg-surface text-ink text-[11px] font-semibold inline-flex items-center gap-1 hover:bg-ivory';
const field = 'w-full min-w-0 px-3 py-2 rounded-xl border border-line-strong bg-surface text-ink text-sm placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-gold';

function CopyChip({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={chip}
      aria-label={`Copy ${label}`}
      onClick={() =>
        void navigator.clipboard?.writeText(text).then(
          () => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          },
          () => setDone(false)
        )
      }
    >
      {done ? <Check className="w-3.5 h-3.5" aria-hidden="true" /> : <Copy className="w-3.5 h-3.5" aria-hidden="true" />}
      <span className="font-mono [overflow-wrap:anywhere]">{text}</span>
    </button>
  );
}

function OpenLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={openButton}>
      <ExternalLink className="w-4 h-4" aria-hidden="true" />
      {children}
    </a>
  );
}

export function DriveSetupWizard({ wizard, onChange }: { wizard: DriveWizard; onChange: (w: DriveWizard) => void }) {
  const [projectId, setProjectId] = useState(wizard.projectId);
  const [error, setError] = useState('');
  const links = wizardLinks(wizard.projectId);
  const doneCount = wizard.done.length;

  // Shown at once (a tick answers the tap), then saved; put back if the server refuses.
  const save = async (patch: Partial<DriveWizard>) => {
    setError('');
    const before = wizard;
    onChange({ ...wizard, ...patch });
    const { ok, data } = await sendJson<{ wizard?: DriveWizard; message?: string }>('PUT', '/api/admin/backup/drive/wizard', patch);
    if (!ok || !data.wizard) {
      onChange(before);
      setError(data.message || 'Could not save. Please try again.');
      return;
    }
    onChange(data.wizard);
  };
  const tick = (step: WizardStep, on: boolean) => void save({ done: on ? [...wizard.done, step] : wizard.done.filter((s) => s !== step) });

  const steps: Array<{ id: WizardStep; title: string; body: React.ReactNode }> = [
    {
      id: 'project',
      title: 'Make a Google Cloud project',
      body: (
        <>
          <p>Sign in with the Google account that should hold the backups. Name the project, for example <CopyChip text="Beautiful UAE Home" label="the project name" />, and press <strong>Create</strong>.</p>
          <OpenLink href={links.project}>Open this page</OpenLink>
          <div className="min-w-0 max-w-sm">
            <label htmlFor="drive-wizard-project" className="block text-xs font-semibold text-ink-soft mb-1">Project ID (optional: the next buttons then open in your project)</label>
            <div className="flex gap-2">
              <input id="drive-wizard-project" type="text" autoComplete="off" spellCheck={false} maxLength={30} value={projectId} onChange={(e) => setProjectId(e.target.value)} onBlur={() => projectId.trim().toLowerCase() !== wizard.projectId && void save({ projectId: projectId.trim().toLowerCase() })} placeholder="beautiful-uae-home-123456" className={`${field} font-mono text-xs`} />
            </div>
            <p className="text-[11px] text-ink-muted mt-1">Google shows it under the project name (Dashboard → Project info).</p>
          </div>
        </>
      ),
    },
    {
      id: 'api',
      title: 'Switch on the Google Drive API',
      body: (
        <>
          <p>Press <strong>Enable</strong>. If it says <em>Manage</em>, it is already on. (If the page has moved: menu ☰ → APIs &amp; Services → Library → search &ldquo;Google Drive API&rdquo;.)</p>
          <OpenLink href={links.api}>Open this page</OpenLink>
        </>
      ),
    },
    {
      id: 'consent',
      title: 'Name the app and publish it',
      body: (
        <>
          <ol className="list-decimal pl-5 space-y-2">
            <li>
              <strong>Branding</strong>: press <em>Get started</em>. App name <CopyChip text={APP_NAME} label="the app name" />, your Gmail as support email, Audience <CopyChip text="External" label="the audience" />, your Gmail as contact email, then <em>Create</em>.
              <div className="mt-1.5"><OpenLink href={links.branding}>Open Branding</OpenLink></div>
            </li>
            <li>
              <strong>Audience</strong>: press <em>Publish app</em> and confirm, so it says <em>In production</em> (while it says Testing, Google cuts the connection after 7 days).
              <div className="mt-1.5"><OpenLink href={links.audience}>Open Audience</OpenLink></div>
            </li>
            <li>
              <strong>Data access</strong> (optional): <em>Add or remove scopes</em> → under <em>Manually add scopes</em> paste <CopyChip text={DRIVE_FILE_SCOPE} label="the Drive scope" /> → <em>Add to table</em> → <em>Update</em> → <em>Save</em>. It lets the shop see only the files it makes.
              <div className="mt-1.5"><OpenLink href={links.scopes}>Open Data access</OpenLink></div>
            </li>
          </ol>
          <p className="text-ink-muted">(If a page has moved: menu ☰ → Google Auth Platform → Branding, Audience or Data access.)</p>
        </>
      ),
    },
    {
      id: 'client',
      title: 'Make the client and download its file',
      body: (
        <>
          <p>Press <em>Create client</em>. Application type <CopyChip text={CLIENT_TYPE} label="the application type" />, any name, then <em>Create</em>. Press <strong>Download JSON</strong> and upload that file below (or copy the Client ID and Client secret into the boxes).</p>
          <OpenLink href={links.client}>Open this page</OpenLink>
        </>
      ),
    },
  ];

  return (
    <div className="rounded-2xl border border-line bg-ivory/50 p-3.5 space-y-3 text-xs text-ink-soft" data-testid="drive-wizard">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="font-semibold text-ink text-sm">Set up Google Drive (once, about 10 minutes)</h4>
        <p data-testid="drive-wizard-progress" className="font-semibold text-ink">{doneCount} of {steps.length} done</p>
      </div>
      <p>Google lets an app use a Drive only once the Drive&rsquo;s owner has registered it, so this part happens in Google Cloud. Each button opens the right page in a new tab; tick each step when it is done.</p>
      <ol className="space-y-3">
        {steps.map((s, i) => {
          const done = wizard.done.includes(s.id);
          return (
            <li key={s.id} className={`rounded-xl border p-3 space-y-2 ${done ? 'border-success-line bg-success-soft/40' : 'border-line bg-surface'}`} data-testid={`drive-wizard-${s.id}`}>
              <div className="flex items-start justify-between gap-2">
                <h5 className="font-semibold text-ink text-sm">
                  <span className="text-ink-muted mr-1">{i + 1}.</span>
                  {s.title}
                </h5>
                <label className="flex items-center gap-1.5 shrink-0 min-h-9 font-semibold text-ink">
                  <input type="checkbox" className="w-5 h-5" checked={done} onChange={(e) => tick(s.id, e.target.checked)} aria-label={`Step ${i + 1} done`} />
                  Done
                </label>
              </div>
              <div className="space-y-2 leading-relaxed [overflow-wrap:anywhere]">{s.body}</div>
            </li>
          );
        })}
      </ol>
      {error && <p role="alert" className="text-danger">{error}</p>}
    </div>
  );
}
