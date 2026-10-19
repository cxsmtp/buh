'use client';

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CourierSettings, Order } from '@/types';
import { X, Printer, AlertTriangle, FileText } from 'lucide-react';
import { aed2, carrierLabel } from '@/lib/courierMode';
import { Barcode128 } from './Barcode128';
import { labelContents as contentsOf } from '@/lib/labelContents';

interface ShippingLabelModalProps {
  order: Order | null;
  onClose: () => void;
  /** The shop's name (Settings → Branding): the shipper on the label. */
  shopName?: string;
  /** Couriers → pickup details: where the courier collects the parcel. */
  pickup?: Partial<CourierSettings['jeebly']>;
}

/** 4 × 6 in at 96 CSS px per inch: the label is laid out at its printed size. */
const W = 384;
const H = 576;

export const TEST_WATERMARK = 'TEST BOOKING – NOT A REAL SHIPMENT – DO NOT SEND';


function dateOf(iso?: string): string {
  const d = iso ? new Date(iso) : new Date();
  return (Number.isNaN(d.getTime()) ? new Date() : d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Dubai' });
}

/** The label itself: black on white, only what is on the order and in the owner's settings. */
function Label({ order, shopName, pickup }: { order: Order; shopName: string; pickup: Partial<CourierSettings['jeebly']> }) {
  const c = order.courier;
  const test = Boolean(c.simulated);
  const cod = order.paymentMethod === 'cod';
  const carrier = carrierLabel(c.provider, c.carrierName);
  const pieces = c.pieces || order.items.reduce((n, i) => n + i.quantity, 0);
  const shipperLines = [
    pickup.pickupLocationName && pickup.pickupLocationName !== shopName ? pickup.pickupLocationName : '',
    [pickup.pickupUnit, pickup.pickupBuilding].filter(Boolean).join(', '),
    [pickup.pickupAddress, pickup.pickupArea].filter(Boolean).join(', '),
    pickup.pickupLandmark ? `Landmark: ${pickup.pickupLandmark}` : '',
    [pickup.pickupEmirate, 'UAE'].filter(Boolean).join(', '),
  ].filter(Boolean);
  return (
    <div className="relative overflow-hidden bg-white text-black font-sans" style={{ width: W, height: H, padding: 12, boxSizing: 'border-box', border: '2px solid #000' }}>
      {test && (
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-center justify-center z-10">
          <div className="text-center font-black uppercase leading-tight whitespace-nowrap" style={{ transform: 'rotate(-56deg)', fontSize: 34, color: 'rgba(0,0,0,0.26)', letterSpacing: 1 }}>
            {/* Three lines that fit the label's diagonal; the text reads as one sentence. */}
            {TEST_WATERMARK.split(/(?<=–) /).map((line, i) => (
              <span key={line} className="block">{i ? ` ${line}` : line}</span>
            ))}
          </div>
        </div>
      )}
      {test && (
        <div className="text-center font-black uppercase text-white bg-black" style={{ fontSize: 11, padding: '2px 0', margin: '-12px -12px 6px' }}>
          Test booking – not a real shipment – do not send
        </div>
      )}

      {/* Carrier, order and date */}
      <div className="flex items-start justify-between gap-2" style={{ fontSize: 10, borderBottom: '2px solid #000', paddingBottom: 4 }}>
        <div>
          <div className="font-bold uppercase">{carrier}{c.serviceType ? ` · ${c.serviceType}` : ''}</div>
          <div>Dispatch {dateOf(c.dispatchedAt)}</div>
        </div>
        <div className="text-right">
          <div className="font-bold">Order {order.id}</div>
          <div>{pieces} piece{pieces === 1 ? '' : 's'} · {c.weightKg ? `${c.weightKg} kg` : 'weight –'}</div>
        </div>
      </div>

      {/* AWB barcode */}
      <div style={{ padding: '6px 0', borderBottom: '2px solid #000' }}>
        <div className="font-bold uppercase" style={{ fontSize: 9 }}>AWB / tracking number</div>
        <Barcode128 value={c.awbNumber} height={64} label={`AWB barcode ${c.awbNumber}`} />
        <div className="text-center font-mono font-black" style={{ fontSize: 16, letterSpacing: 1 }}>{c.awbNumber}</div>
      </div>

      {/* Consignee */}
      <div style={{ padding: '6px 0', borderBottom: '2px solid #000' }}>
        <div className="font-bold uppercase" style={{ fontSize: 9 }}>Deliver to</div>
        <div className="font-black break-words" style={{ fontSize: 17, lineHeight: 1.15 }}>{order.customer.fullName}</div>
        <div className="font-bold" style={{ fontSize: 13 }}>{order.customer.phone}</div>
        <div className="break-words" style={{ fontSize: 11, lineHeight: 1.25 }}>
          {[order.customer.flatVillaNo, order.customer.buildingVilla, order.customer.streetAddress].filter(Boolean).join(', ')}
        </div>
        <div className="font-black uppercase" style={{ fontSize: 14 }}>{order.customer.area}, {order.customer.emirate}</div>
        {order.customer.landmark && <div className="break-words" style={{ fontSize: 10 }}>Landmark: {order.customer.landmark}</div>}
      </div>

      {/* Payment */}
      <div className="text-center" style={{ margin: '6px 0', padding: '4px 0', border: '2px solid #000', background: cod ? '#000' : '#fff', color: cod ? '#fff' : '#000' }}>
        {cod ? (
          <>
            <div className="font-bold uppercase" style={{ fontSize: 10 }}>Cash on delivery – collect</div>
            <div className="font-mono font-black" style={{ fontSize: 20 }}>AED {aed2(order.total)}</div>
          </>
        ) : (
          <div className="font-black uppercase" style={{ fontSize: 16 }}>Prepaid – do not collect cash</div>
        )}
      </div>

      {/* Shipper and parcel */}
      <div className="grid grid-cols-2 gap-2" style={{ fontSize: 9, lineHeight: 1.25 }}>
        <div className="min-w-0 break-words">
          <div className="font-bold uppercase">From</div>
          <div className="font-bold">{shopName}</div>
          {shipperLines.map((l) => <div key={l}>{l}</div>)}
          {pickup.pickupPhone && <div>{pickup.pickupPhone}</div>}
        </div>
        <div className="min-w-0 break-words">
          <div className="font-bold uppercase">Contents</div>
          <div>{contentsOf(order)}</div>
        </div>
      </div>

      {/* Order barcode */}
      <div className="absolute" style={{ left: 12, right: 12, bottom: 8 }}>
        <Barcode128 value={order.id} height={30} label={`Order barcode ${order.id}`} />
        <div className="text-center font-mono" style={{ fontSize: 10 }}>{order.id}</div>
      </div>
    </div>
  );
}

export const ShippingLabelModal: React.FC<ShippingLabelModalProps> = ({ order, onClose, shopName = 'Beautiful UAE Home', pickup = {} }) => {
  const frame = useRef<HTMLDivElement>(null);
  const printButton = useRef<HTMLElement>(null);
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    const el = frame.current;
    if (!el) return;
    const fit = () => setScale(Math.min(1, el.clientWidth / W));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [order]);

  useEffect(() => {
    printButton.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!order) return null;
  const c = order.courier;
  const test = Boolean(c.simulated);
  const pickupMissing = !pickup.pickupPhone || !(pickup.pickupArea || pickup.pickupAddress);
  // Jeebly makes its own label for an API booking (or one typed in from its portal): the main action.
  const jeeblyLabel = c.provider === 'jeebly' && Boolean(c.awbNumber) && c.testKind !== 'practice' && (c.bookingState === 'booked' || c.testKind === 'sandbox');
  const carrierPdf = jeeblyLabel ? `/api/admin/orders/${encodeURIComponent(order.id)}/carrier-label` : undefined;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/45 p-3 sm:p-4 overscroll-contain" role="dialog" aria-modal="true" aria-labelledby="label-title">
      <div className="bg-surface rounded-3xl max-w-xl w-full min-w-0 max-h-[calc(100dvh-1.5rem)] overflow-y-auto overflow-x-hidden overscroll-contain p-4 sm:p-6 border border-line space-y-4">
        <div className="sticky top-0 z-20 -mx-4 -mt-4 px-4 pt-4 sm:-mx-6 sm:-mt-6 sm:px-6 sm:pt-6 pb-3 bg-surface flex items-start justify-between gap-2 border-b border-line">
          <div className="min-w-0">
            <h3 id="label-title" className="font-serif text-xl text-ink">
              {test ? 'Test label (not a shipment)' : 'Shipping label'}
            </h3>
            <p className="text-xs text-ink-muted">
              AWB {c.awbNumber} · {carrierPdf ? "print Jeebly's own label; ours below is the packing slip" : '4 × 6 in label'}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close label" className="shrink-0 w-10 h-10 flex items-center justify-center text-ink rounded-full hover:bg-sand focus:outline-none focus-visible:ring-2 focus-visible:ring-gold">
            <X className="w-5 h-5" strokeWidth={1.5} />
          </button>
        </div>

        {test && (
          <p role="alert" className="flex items-start gap-2 rounded-xl border border-danger-line bg-danger-soft p-2.5 text-xs font-semibold text-danger">
            <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>
              {c.testKind === 'sandbox' ? "A test booking in Jeebly's sandbox" : 'A practice booking'}: it was not sent to the courier, nobody will collect this parcel, and the customer sees no tracking. Do not stick this label on a parcel.
            </span>
          </p>
        )}
        {pickupMissing && (
          <p role="alert" className="flex items-start gap-2 rounded-xl border border-warning-line bg-warning-soft p-2.5 text-xs font-semibold text-warning">
            <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>Add your pickup address in Couriers (Admin Hub → Settings → Couriers): the label shows only the shop name as the sender until then.</span>
          </p>
        )}

        {/* On-screen preview, scaled to fit; the printed copy below is full size. */}
        <div ref={frame} className="w-full max-w-[384px] mx-auto" style={{ height: H * scale }}>
          <div style={{ width: W, height: H, transform: `scale(${scale})`, transformOrigin: 'top left' }}>
            <Label order={order} shopName={shopName} pickup={pickup} />
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            ref={carrierPdf ? undefined : (printButton as React.Ref<HTMLButtonElement>)}
            type="button"
            onClick={() => window.print()}
            className={`flex items-center gap-1.5 font-semibold text-xs px-3.5 py-2 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2 ${
              carrierPdf ? 'border border-line-strong bg-surface hover:bg-sand text-ink' : test ? 'bg-danger text-paper shadow' : 'bg-ink text-paper shadow'
            }`}
          >
            <Printer className="w-4 h-4" aria-hidden="true" />
            <span>{carrierPdf ? (test ? 'Print TEST packing slip' : 'Print packing slip (4 × 6 in)') : test ? 'Print TEST label (not a shipment)' : 'Print label (4 × 6 in)'}</span>
          </button>
          {carrierPdf && (
            <a
              ref={printButton as unknown as React.Ref<HTMLAnchorElement>}
              href={carrierPdf}
              target="_blank"
              rel="noopener"
              className={`flex items-center gap-1.5 font-semibold text-xs px-3.5 py-2 rounded-xl shadow text-paper focus:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2 ${test ? 'bg-danger' : 'bg-ink'}`}
            >
              <FileText className="w-4 h-4 text-gold-light" aria-hidden="true" />
              <span>{test ? "Print Jeebly's sandbox label (PDF, TEST)" : 'Print Jeebly label (PDF)'}</span>
            </a>
          )}
        </div>
      </div>

      {/* What the printer gets: only this, at 4 × 6 in (src/app/globals.css). Opened from a click, so always in the browser. */}
      {createPortal(
          <div id="shipping-label-print" aria-hidden="true">
            <style>{'@media print { @page { size: 4in 6in; margin: 0; } }'}</style>
            <div id="printable-shipping-label">
              <Label order={order} shopName={shopName} pickup={pickup} />
            </div>
          </div>,
          document.body
        )}
    </div>
  );
};
