/**
 * A stand-in for Jeebly's Scheduled API with the exact replies seen from demo.jeebly.com on
 * 2026-10-19 (create, label PDF, track, cancel, and the error replies). Used by the unit tests
 * (installJeeblyMock) and, as a preload (`node --import ./test/fixtures/jeebly-mock.mjs`, with
 * JEEBLY_MOCK=1), by end-to-end tests: only *.jeebly.com requests are answered, all else passes.
 */

export const REPLIES = {
  created: (awb = 'JB115105') => ({ status: 200, body: { success: 'true', message: 'Created Successfully. ', 'AWB No': awb } }),
  invalidToken: { status: 400, body: { success: 'false', message: 'Invalid API Token' } },
  missingHeaders: { status: 400, body: { success: 'false', message: 'X-API-KEY and client_key headers are required.' } },
  codBank: { status: 400, body: { success: 'false', message: 'For settlement of COD amount, we will require your bank details' } },
  unknownAwb: { status: 400, body: { success: 'false', message: 'Invalid Customer Key Or Shipment Number' } },
  cancelled: { status: 200, body: { success: 'true', message: 'Shipment cancelled successfully' } },
  cancelAgain: { status: 400, body: { success: 'false1', message: 'Shipment can not be Cancel' } },
  tracking: (awb = 'JB115105', last = 'Pickup Scheduled') => ({
    status: 200,
    body: {
      success: 'true',
      Tracking: {
        reference_no: awb,
        customer_reference_number: 'BUH-TEST',
        last_status: last,
        pickup_date: '2026-10-20',
        booking_date: '2026-10-19',
        booking_time: '07:59 ',
        events: [
          ...(last === 'Pickup Scheduled' ? [] : [{ status: last, desc: `Consignment ${last.toLowerCase()}`, hub_name: 'DXB', event_date_time: '2026-10-20T09:12:00Z', cod_amount: '0', shipper_phone: '971501234567', recipient_phone: '971509998877', rider_code: 'R42', rider_name: 'Rider Name', pod_image: 'https://pod.example/x.jpg', signature_image: 'https://sig.example/x.png', failure_reason: '' }]),
          { status: 'Pickup Scheduled', desc: 'Consignment pickup_scheduled', hub_name: 'DXB', event_date_time: '2026-10-19T07:59:46Z', cod_amount: '0', shipper_phone: '971501234567', recipient_phone: '971509998877', rider_code: '', rider_name: '', pod_image: null, signature_image: null, failure_reason: '' },
        ],
      },
    },
  }),
};

/** A small real PDF (what generate_shipment_label returns, in miniature). */
export const LABEL_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 288 432]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
  'latin1'
);

const json = (r) => new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });

/**
 * A Jeebly with state: create gives JB<n>, track knows created AWBs, cancel works once.
 * `script` overrides a path's reply ({ create, label, track, cancel }: a function of the request).
 */
export function createJeeblyMock(script = {}) {
  const calls = [];
  const shipments = new Map();
  let n = 115105;
  const handler = async (url, init = {}) => {
    const u = new URL(String(url));
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    const body = init.body ? JSON.parse(String(init.body)) : {};
    const path = u.pathname.replace('/customer/', '');
    const call = { host: u.host, path, headers, body };
    calls.push(call);
    if (!headers['x-api-key'] || !headers['client_key']) return json(REPLIES.missingHeaders);
    if (headers['x-api-key'] === 'bad-key') return json(REPLIES.invalidToken);
    const scripted = { create_shipment: script.create, generate_shipment_label: script.label, track_shipment: script.track, cancel_shipment: script.cancel }[path];
    if (scripted) {
      const r = await scripted(call);
      if (r) return r instanceof Response ? r : json(r);
    }
    if (path === 'create_shipment') {
      if (body.payment_type === 'COD' && script.codNeedsBank) return json(REPLIES.codBank);
      const awb = `JB${++n}`;
      shipments.set(awb, { status: 'Pickup Scheduled' });
      return json(REPLIES.created(awb));
    }
    const s = shipments.get(body.reference_number);
    if (!s) return json(REPLIES.unknownAwb);
    if (path === 'generate_shipment_label') return new Response(LABEL_PDF, { status: 200, headers: { 'content-type': 'application/pdf', 'content-disposition': `inline; filename=${body.reference_number}.pdf` } });
    if (path === 'track_shipment') return json(REPLIES.tracking(body.reference_number, s.status));
    if (path === 'cancel_shipment') {
      if (s.status === 'Cancelled') return json(REPLIES.cancelAgain);
      s.status = 'Cancelled';
      return json(REPLIES.cancelled);
    }
    return json(REPLIES.unknownAwb);
  };
  return { calls, shipments, handler, setStatus: (awb, status) => shipments.get(awb) && (shipments.get(awb).status = status) };
}

/** Answer *.jeebly.com requests from the mock; everything else goes to the real fetch. */
export function installJeeblyMock(script) {
  const real = globalThis.__realFetch ?? globalThis.fetch;
  globalThis.__realFetch = real;
  const mock = createJeeblyMock(script);
  globalThis.fetch = async (url, init) => {
    const host = (() => {
      try {
        return new URL(String(url)).hostname;
      } catch {
        return '';
      }
    })();
    return host === 'jeebly.com' || host.endsWith('.jeebly.com') ? mock.handler(url, init) : real(url, init);
  };
  return { ...mock, restore: () => (globalThis.fetch = real) };
}

// As a preload for the e2e server: on only with JEEBLY_MOCK=1.
if (process.env.JEEBLY_MOCK === '1') installJeeblyMock();
