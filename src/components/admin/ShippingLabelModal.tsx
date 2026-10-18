'use client';

import React from 'react';
import { Order } from '@/types';
import { X, Printer, QrCode, Barcode, ShieldCheck, MapPin } from 'lucide-react';

interface ShippingLabelModalProps {
  order: Order | null;
  onClose: () => void;
}

export const ShippingLabelModal: React.FC<ShippingLabelModalProps> = ({ order, onClose }) => {
  if (!order) return null;

  const isJeebly = order.courier.provider === 'jeebly';
  const courierTitle = isJeebly ? 'JEEBLY LOGISTICS UAE' : 'ECO EXPRESS COURIER SERVICES';
  const isCod = order.paymentMethod === 'cod';

  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/45 p-3 sm:p-4 overscroll-contain" role="dialog" aria-modal="true" aria-labelledby="label-title">
      <div className="bg-surface rounded-3xl max-w-xl w-full min-w-0 max-h-[calc(100dvh-1.5rem)] overflow-y-auto overflow-x-hidden overscroll-contain p-4 sm:p-6 border border-line space-y-4">
        {/* Header Actions (stay in view) */}
        <div className="sticky top-0 z-10 -mx-4 -mt-4 px-4 pt-4 sm:-mx-6 sm:-mt-6 sm:px-6 sm:pt-6 pb-3 bg-surface flex items-start justify-between gap-2 border-b border-line">
          <div className="min-w-0">
            <h3 id="label-title" className="font-serif text-xl text-ink">
              Shipping label (AWB)
            </h3>
            <p className="text-xs text-ink-muted">
              Formatted for 4x6 Thermal Label Printer or Standard A4
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={handlePrint}
              className="flex items-center gap-1.5 bg-ink hover:bg-ink text-paper font-semibold text-xs px-3.5 py-2 rounded-xl shadow transition-all"
            >
              <Printer className="w-4 h-4 text-gold-light" />
              <span>Print Label</span>
            </button>
            <button
              onClick={onClose}
              aria-label="Close label"
              className="w-10 h-10 flex items-center justify-center text-ink rounded-full hover:bg-sand"
            >
              <X className="w-5 h-5" strokeWidth={1.5} />
            </button>
          </div>
        </div>

        {/* PRINTABLE AWB CONTAINER */}
        <div
          id="printable-shipping-label"
          className="look-paper border-2 border-black p-4 bg-surface text-black font-sans text-xs space-y-3 rounded-xl shadow-sm"
        >
          {/* Top Carrier Header */}
          <div className="flex items-center justify-between border-b-2 border-black pb-2.5">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-black text-white flex items-center justify-center font-bold font-serif text-sm">
                {isJeebly ? 'JB' : 'ECO'}
              </div>
              <div>
                <span className="font-black text-sm tracking-wide block">{courierTitle}</span>
                <span className="text-[10px] text-ink-soft font-semibold uppercase">
                  {isJeebly ? 'Next-Day Scheduled Delivery' : 'Priority Express Domestic'}
                </span>
              </div>
            </div>

            <div className="text-right">
              <span className="text-[10px] font-bold text-ink-muted block">AWB NUMBER</span>
              <span className="font-mono font-black text-sm">{order.courier.awbNumber}</span>
            </div>
          </div>

          {/* Barcode & Routing Section */}
          <div className="flex items-center justify-between py-2 border-b-2 border-black bg-ivory p-2 rounded">
            <div className="space-y-1">
              <div className="text-[10px] uppercase font-bold text-ink-soft">
                Tracking Barcode (Scan at Hub)
              </div>
              {/* Simulated High-Density Code-128 Barcode */}
              <div className="flex items-center gap-0.5 h-10 overflow-hidden">
                {Array.from({ length: 48 }).map((_, i) => (
                  <div
                    key={i}
                    className="h-full bg-black"
                    style={{
                      width: `${(i % 3) + 1.5}px`,
                      marginRight: `${(i % 4) * 0.8}px`,
                    }}
                  />
                ))}
              </div>
              <div className="font-mono text-center font-bold text-[11px] tracking-widest">
                *{order.courier.awbNumber}*
              </div>
            </div>

            {/* Destination Hub Badge */}
            <div className="text-right flex flex-col items-end">
              <div className="bg-black text-white font-black text-sm px-3 py-1.5 rounded uppercase tracking-wider">
                {order.customer.emirate.toUpperCase()}
              </div>
              <span className="text-[10px] font-bold mt-1 text-ink-soft">
                HUB: {order.customer.emirate.slice(0, 3).toUpperCase()}-CENTRAL
              </span>
            </div>
          </div>

          {/* Consignee (Receiver) Section */}
          <div className="border-b-2 border-black pb-2 space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-black uppercase text-ink-soft tracking-wider">
                DELIVER TO (CONSIGNEE):
              </span>
              <span className="text-[10px] font-bold text-ink-soft">
                Order Ref: {order.id}
              </span>
            </div>

            <div className="text-sm font-black text-black">
              {order.customer.fullName}
            </div>

            <div className="font-bold text-xs text-black">
              Tel: {order.customer.phone}
            </div>

            <div className="text-xs leading-tight font-medium text-ink">
              {order.customer.buildingVilla}, {order.customer.flatVillaNo}, {order.customer.streetAddress}
            </div>

            <div className="text-xs font-bold text-ink">
              Area: {order.customer.area}, Emirate: {order.customer.emirate}
            </div>

            {order.customer.landmark && (
              <div className="text-[11px] bg-warning-soft p-1 rounded font-semibold text-warning border border-warning-line">
                Landmark: {order.customer.landmark}
              </div>
            )}
          </div>

          {/* COD or PREPAID ALERT BOX (Huge & Prominent) */}
          <div
            className={`p-3 rounded-lg border-2 text-center ${
              isCod
                ? 'border-danger bg-danger-soft text-danger'
                : 'border-success bg-success-soft text-success'
            }`}
          >
            {isCod ? (
              <div className="space-y-0.5">
                <span className="text-xs font-black uppercase tracking-wider block">
                  ★ CASH ON DELIVERY (COD) ★
                </span>
                <div className="font-mono font-black text-xl text-danger">
                  COLLECT: AED {order.total}.00
                </div>
                <span className="text-[10px] font-bold block">
                  DRIVER: Collect exact cash payment before handing over goods.
                </span>
              </div>
            ) : (
              <div className="space-y-0.5">
                <span className="text-xs font-black uppercase tracking-wider block">
                  ✓ PREPAID ORDER - DO NOT COLLECT CASH ✓
                </span>
                <div className="font-mono font-black text-base text-success">
                  PAYMENT SETTLED ONLINE / BANK TRANSFER
                </div>
                <span className="text-[10px] font-bold block">
                  Hand over parcel directly to customer upon signature.
                </span>
              </div>
            )}
          </div>

          {/* Shipper & Parcel Info */}
          <div className="grid grid-cols-2 gap-2 text-[10px] pt-1 border-t border-line-strong">
            <div>
              <span className="font-black text-ink-muted uppercase block">FROM (SHIPPER):</span>
              <strong className="block text-black">BEAUTIFUL UAE HOME LLC</strong>
              <span>WH 14, Al Quoz 3, Sheikh Zayed Rd</span>
              <span className="block">Dubai, UAE • +971 50 829 4110</span>
            </div>

            <div className="text-right">
              <span className="font-black text-ink-muted uppercase block">SHIPMENT DETAILS:</span>
              <span>Weight: <strong>{order.courier.weightKg || 2.5} KG</strong></span>
              <span className="block">Pieces: <strong>{order.courier.pieces || 1} PKG</strong></span>
              <span>Contents: <strong>Luxury Bedding Set</strong></span>
            </div>
          </div>
        </div>

        {/* Footer print action */}
        <div className="flex items-center justify-between text-xs text-ink-muted pt-2">
          <span>Official Carrier Compliant Format</span>
          <button
            onClick={handlePrint}
            className="flex items-center gap-1.5 text-ink font-bold hover:underline"
          >
            <Printer className="w-4 h-4 text-gold" />
            <span>Send to Thermal / AirPrint</span>
          </button>
        </div>
      </div>
    </div>
  );
};
