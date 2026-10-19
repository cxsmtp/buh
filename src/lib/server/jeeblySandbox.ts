import { sandboxSteps, type SandboxStep } from '@/lib/jeeblySandboxFlow';
import { auditOrThrow } from './audit';
import { kvGet, kvSet } from './kv';
import { contactEmail, getSettings, SANDBOX_CHECK_DAYS, SANDBOX_CHECK_KV, sandboxCheckFresh } from './settings';

export type { SandboxStep, StepResult } from '@/lib/jeeblySandboxFlow';

/**
 * Couriers → "Sandbox check": before Live mode, book one PREPAID dummy order clearly marked TEST in
 * Jeebly's demo system with the saved sandbox keys, then fetch its label PDF, track it and cancel
 * it (src/lib/jeeblySandboxFlow.ts). Each
 * step reports Jeebly's own reply. The last result is kept (kv, so it is in backups) and audited;
 * Live mode needs one that passed within 30 days.
 */

export interface SandboxCheck {
  at: string;
  by: string;
  passed: boolean;
  awb?: string;
  steps: SandboxStep[];
}

export function lastSandboxCheck(): (SandboxCheck & { fresh: boolean; validDays: number }) | null {
  const last = kvGet<SandboxCheck>(SANDBOX_CHECK_KV)?.data;
  return last ? { ...last, fresh: sandboxCheckFresh(), validDays: SANDBOX_CHECK_DAYS } : null;
}

export async function runSandboxCheck(actor: string): Promise<SandboxCheck> {
  const s = getSettings('courier').jeebly;
  const result = await sandboxSteps({
    keys: { apiKey: s.sandboxApiKey, clientKey: s.sandboxClientKey },
    pickup: s,
    sender: { shopName: getSettings('brand').storeName, email: contactEmail() },
  });
  const check: SandboxCheck = {
    at: new Date().toISOString(),
    by: actor,
    passed: result.steps.every((x) => x.result !== 'fail') && result.steps.some((x) => x.step === 'create' && x.result === 'pass'),
    ...(result.awb ? { awb: result.awb } : {}),
    steps: result.steps,
  };
  // Audited before it counts (Live mode is gated on it).
  auditOrThrow('courier.sandbox_check', { by: actor, result: check.passed ? 'passed' : 'failed', awb: check.awb ?? '', steps: check.steps.map((x) => `${x.step}:${x.result}${x.httpStatus ? `:${x.httpStatus}` : ''}`).join(' ') });
  kvSet(SANDBOX_CHECK_KV, check);
  return check;
}
