import type { CourierSettings, Order } from '@/types';
import { buildJeeblyPayload, missingPickup, type JeeblySender } from './jeebly';
import { callJeebly, fetchJeeblyLabel, JEEBLY_API, jeeblyAwb, jeeblyHint, jeeblyOk, jeeblySaid, mapJeeblyTracking } from './jeeblyApi';

/**
 * The Sandbox check against Jeebly's demo system, shared by Couriers → "Run the Sandbox check"
 * (src/lib/server/jeeblySandbox.ts) and scripts/jeebly-sandbox-check.mjs: create one PREPAID
 * shipment marked TEST (the owner's pickup, a dummy consignee), fetch its label PDF, track it,
 * cancel it. Each step keeps Jeebly's own reply (HTTP status and message, keys masked).
 */

export type StepResult = 'pass' | 'fail' | 'not_checked';
export interface SandboxStep {
  step: 'create' | 'label' | 'tracking' | 'cancel';
  result: StepResult;
  httpStatus?: number;
  /** Jeebly's reply, or why the step was not run (text, at most 200 characters, keys masked). */
  said: string;
}

/** The dummy order: PREPAID, every name says TEST, delivered to a dummy consignee in the pickup's emirate. */
export function sandboxTestOrder(pickup: { phone: string; emirate: Order['customer']['emirate'] }): Order {
  return {
    id: `TEST-SANDBOX-${Date.now().toString(36).toUpperCase()}`,
    createdAt: new Date().toISOString(),
    customer: {
      fullName: 'TEST ORDER - DO NOT DELIVER',
      phone: pickup.phone,
      emirate: pickup.emirate,
      area: 'TEST AREA',
      streetAddress: 'TEST STREET',
      buildingVilla: 'TEST BUILDING',
      flatVillaNo: 'TEST 1',
      landmark: 'Sandbox check - not a real shipment',
    },
    items: [{ productId: 'test', title: 'TEST ITEM - sandbox check', image: '', profileId: 'test' as never, profileName: 'TEST', mattressSize: '', fittedSheet: '', flatSheet: '', pillowcases: '', unitPrice: 1, quantity: 1, totalPrice: 1 }],
    subtotal: 1,
    deliveryFee: 0,
    codFee: 0,
    discount: 0,
    total: 1,
    paymentMethod: 'bank_transfer',
    paymentStatus: 'paid',
    status: 'confirmed',
    courier: { provider: 'jeebly', serviceType: 'Scheduled', awbNumber: '', trackingUrl: '', status: '', pickupDate: '', weightKg: 1, pieces: 1, labelGenerated: false },
  };
}

export async function sandboxSteps(input: {
  keys: { apiKey: string; clientKey: string };
  pickup: CourierSettings['jeebly'];
  sender: JeeblySender;
}): Promise<{ steps: SandboxStep[]; awb?: string }> {
  const { keys, pickup, sender } = input;
  const out: SandboxStep[] = [];
  const skipRest = (why: string) => {
    for (const step of ['label', 'tracking', 'cancel'] as const) out.push({ step, result: 'not_checked', said: why });
  };
  if (!keys.apiKey || !keys.clientKey) {
    out.push({ step: 'create', result: 'fail', said: 'Add both Jeebly sandbox keys in Couriers and save them first.' });
    skipRest('The test shipment was not created.');
    return { steps: out };
  }
  const missing = missingPickup(pickup);
  if (missing.length) {
    out.push({ step: 'create', result: 'fail', said: `Add your pickup ${missing.join(', ')} in Couriers first.` });
    skipRest('The test shipment was not created.');
    return { steps: out };
  }
  const secrets = [keys.apiKey, keys.clientKey];
  const base = JEEBLY_API.sandboxBase;

  // 1. Create the TEST shipment (PREPAID: nothing to collect).
  const order = sandboxTestOrder({ phone: pickup.pickupPhone, emirate: pickup.pickupEmirate });
  const created = await callJeebly(base, JEEBLY_API.paths.create, keys, buildJeeblyPayload(order, pickup, sender));
  if (!created.reached) {
    out.push({ step: 'create', result: 'fail', said: `Could not reach Jeebly's sandbox (${created.error}).` });
    skipRest('The test shipment was not created.');
    return { steps: out };
  }
  const said = jeeblySaid(created.data, secrets);
  const awb = jeeblyAwb(created.data);
  const createdOk = created.status! >= 200 && created.status! < 300 && jeeblyOk(created.data) && Boolean(awb);
  out.push({
    step: 'create',
    result: createdOk ? 'pass' : 'fail',
    httpStatus: created.status,
    said: createdOk ? `AWB ${awb}${said ? ` · ${said}` : ''}` : `${said || (jeeblyOk(created.data) ? 'Jeebly answered success but gave no AWB number.' : '(no message)')}${jeeblyHint(said)}`,
  });
  if (!createdOk) {
    skipRest('The test shipment was not created.');
    return { steps: out };
  }

  // 2. The label PDF.
  const label = await fetchJeeblyLabel(base, keys, awb);
  out.push('pdf' in label ? { step: 'label', result: 'pass', httpStatus: 200, said: `Label PDF, ${label.pdf.length < 1024 ? `${label.pdf.length} bytes` : `${Math.round(label.pdf.length / 1024)} KB`}.` } : { step: 'label', result: 'fail', httpStatus: label.status, said: label.error });

  // 3. Tracking.
  const track = await callJeebly(base, JEEBLY_API.paths.track, keys, { reference_number: awb });
  const t = track.reached ? mapJeeblyTracking(track.data) : null;
  out.push(
    t
      ? { step: 'tracking', result: 'pass', httpStatus: track.status, said: `Last status: ${t.lastStatus || '(none)'} · ${t.events.length} event${t.events.length === 1 ? '' : 's'}.` }
      : { step: 'tracking', result: 'fail', httpStatus: track.status, said: track.reached ? jeeblySaid(track.data, secrets) || 'No tracking in the reply.' : `No answer (${track.error}).` }
  );

  // 4. Cancel the TEST shipment (so nobody comes to collect it).
  const cancel = await callJeebly(base, JEEBLY_API.paths.cancel, keys, { reference_number: awb });
  const cancelled = Boolean(cancel.reached && cancel.status! >= 200 && cancel.status! < 300 && jeeblyOk(cancel.data));
  out.push({
    step: 'cancel',
    result: cancelled ? 'pass' : 'fail',
    httpStatus: cancel.status,
    said: cancel.reached ? jeeblySaid(cancel.data, secrets) || (cancelled ? 'Cancelled.' : '(no message)') : `No answer (${cancel.error}): cancel the TEST shipment ${awb} in Jeebly's portal.`,
  });
  return { steps: out, awb };
}
