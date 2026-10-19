#!/usr/bin/env node
/**
 * Opt-in developer check against Jeebly's demo (sandbox) environment, from a checkout of the code
 * (it uses the dev dependency tsx; it is not part of the shop's image). It runs the same Sandbox
 * check as Couriers → "Run the Sandbox check" (src/lib/jeeblySandboxFlow.ts): one dummy order
 * marked TEST (PREPAID), then its label PDF, its tracking, and cancelling it.
 * It creates and cancels one shipment in Jeebly's demo system.
 * From this sandbox, Node reaches Jeebly only through the proxy: NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=…
 *
 * Keys come from the environment only and are never printed (Jeebly's replies are masked too):
 *   JEEBLY_SANDBOX_API_KEY, JEEBLY_SANDBOX_CLIENT_KEY (required)
 *   JEEBLY_PICKUP_PHONE, JEEBLY_PICKUP_UNIT, JEEBLY_PICKUP_BUILDING, JEEBLY_PICKUP_AREA,
 *   JEEBLY_PICKUP_LANDMARK, JEEBLY_PICKUP_EMIRATE (optional; TEST values otherwise)
 *
 * Usage (from the repository folder): node scripts/jeebly-sandbox-check.mjs
 * Prints each step's result, HTTP status and Jeebly's message text. Exit code 0: passed.
 */
import { tsImport } from 'tsx/esm/api';

const apiKey = process.env.JEEBLY_SANDBOX_API_KEY || '';
const clientKey = process.env.JEEBLY_SANDBOX_CLIENT_KEY || '';
if (!apiKey || !clientKey) {
  console.error('Set JEEBLY_SANDBOX_API_KEY and JEEBLY_SANDBOX_CLIENT_KEY first.');
  process.exit(2);
}

const { sandboxSteps } = await tsImport('../src/lib/jeeblySandboxFlow.ts', import.meta.url);
const { JEEBLY_API } = await tsImport('../src/lib/jeeblyApi.ts', import.meta.url);

const pickup = {
  apiKey: '',
  clientKey: '',
  sandboxApiKey: apiKey,
  sandboxClientKey: clientKey,
  serviceType: 'Scheduled',
  isLive: false,
  pickupLocationName: 'TEST PICKUP - sandbox check',
  pickupPhone: process.env.JEEBLY_PICKUP_PHONE || '+971501234567',
  pickupAddress: '',
  pickupUnit: process.env.JEEBLY_PICKUP_UNIT || 'TEST UNIT',
  pickupBuilding: process.env.JEEBLY_PICKUP_BUILDING || 'TEST BUILDING',
  pickupArea: process.env.JEEBLY_PICKUP_AREA || 'Al Barsha',
  pickupLandmark: process.env.JEEBLY_PICKUP_LANDMARK || 'TEST PICKUP - sandbox check, do not collect',
  pickupEmirate: process.env.JEEBLY_PICKUP_EMIRATE || 'Dubai',
};

console.log(`Jeebly sandbox: ${JEEBLY_API.sandboxBase} (headers ${JEEBLY_API.headers.apiKey}, ${JEEBLY_API.headers.clientKey}; values not shown)`);
const { steps, awb } = await sandboxSteps({
  keys: { apiKey, clientKey },
  pickup,
  sender: { shopName: 'TEST SHOP - sandbox check' },
});
const mask = (text) => [apiKey, clientKey].reduce((t, k) => (k.length >= 4 ? t.split(k).join('[redacted]') : t), String(text));
for (const s of steps) {
  console.log(`${s.step.padEnd(8)} ${s.result.padEnd(11)} ${s.httpStatus ? `HTTP ${s.httpStatus}` : '-'.padEnd(8)}  ${mask(s.said)}`);
}
const passed = steps.every((s) => s.result !== 'fail') && steps.some((s) => s.step === 'create' && s.result === 'pass');
console.log(passed ? `PASSED${awb ? ` (TEST AWB ${awb})` : ''}` : 'FAILED');
process.exit(passed ? 0 : 1);
