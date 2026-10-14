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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="bg-white rounded-3xl max-w-xl w-full p-4 sm:p-6 shadow-2xl space-y-4">
        {/* Header Actions */}
        <div className="flex items-center justify-between pb-3 border-b border-stone-200">
          <div>
            <h3 className="font-serif font-bold text-base text-[#0f1c2e]">
              Courier Shipping Label / Airway Bill (AWB)
            </h3>
            <p className="text-xs text-stone-500">
              Formatted for 4x6 Thermal Label Printer or Standard A4
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handlePrint}
              className="flex items-center gap-1.5 bg-[#0f1c2e] hover:bg-stone-800 text-white font-semibold text-xs px-3.5 py-2 rounded-xl shadow transition-all"
            >
              <Printer className="w-4 h-4 text-amber-300" />
              <span>Print Label</span>
            </button>
            <button
              onClick={onClose}
              aria-label="Close label"
              className="p-1.5 text-stone-400 hover:text-stone-700 rounded-full hover:bg-stone-100"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* PRINTABLE AWB CONTAINER */}
        <div
          id="printable-shipping-label"
          className="border-2 border-black p-4 bg-white text-black font-sans text-xs space-y-3 rounded-xl shadow-sm"
        >
          {/* Top Carrier Header */}
          <div className="flex items-center justify-between border-b-2 border-black pb-2.5">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-black text-white flex items-center justify-center font-bold font-serif text-sm">
                {isJeebly ? 'JB' : 'ECO'}
              </div>
              <div>
                <span className="font-black text-sm tracking-wide block">{courierTitle}</span>
                <span className="text-[10px] text-stone-600 font-semibold uppercase">
                  {isJeebly ? 'Next-Day Scheduled Delivery' : 'Priority Express Domestic'}
                </span>
              </div>
            </div>

            <div className="text-right">
              <span className="text-[10px] font-bold text-stone-500 block">AWB NUMBER</span>
              <span className="font-mono font-black text-sm">{order.courier.awbNumber}</span>
            </div>
          </div>

          {/* Barcode & Routing Section */}
          <div className="flex items-center justify-between py-2 border-b-2 border-black bg-stone-50 p-2 rounded">
            <div className="space-y-1">
              <div className="text-[10px] uppercase font-bold text-stone-600">
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
              <span className="text-[10px] font-bold mt-1 text-stone-700">
                HUB: {order.customer.emirate.slice(0, 3).toUpperCase()}-CENTRAL
              </span>
            </div>
          </div>

          {/* Consignee (Receiver) Section */}
          <div className="border-b-2 border-black pb-2 space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-black uppercase text-stone-600 tracking-wider">
                DELIVER TO (CONSIGNEE):
              </span>
              <span className="text-[10px] font-bold text-stone-700">
                Order Ref: {order.id}
              </span>
            </div>

            <div className="text-sm font-black text-black">
              {order.customer.fullName}
            </div>

            <div className="font-bold text-xs text-black">
              Tel: {order.customer.phone}
            </div>

            <div className="text-xs leading-tight font-medium text-stone-800">
              {order.customer.buildingVilla}, {order.customer.flatVillaNo}, {order.customer.streetAddress}
            </div>

            <div className="text-xs font-bold text-stone-900">
              Area: {order.customer.area}, Emirate: {order.customer.emirate}
            </div>

            {order.customer.landmark && (
              <div className="text-[11px] bg-amber-50 p-1 rounded font-semibold text-amber-950 border border-amber-200">
                📍 Landmark: {order.customer.landmark}
              </div>
            )}
          </div>

          {/* COD or PREPAID ALERT BOX (Huge & Prominent) */}
          <div
            className={`p-3 rounded-lg border-2 text-center ${
              isCod
                ? 'border-red-600 bg-red-50 text-red-950'
                : 'border-emerald-700 bg-emerald-50 text-emerald-950'
            }`}
          >
            {isCod ? (
              <div className="space-y-0.5">
                <span className="text-xs font-black uppercase tracking-wider block">
                  ★ CASH ON DELIVERY (COD) ★
                </span>
                <div className="font-mono font-black text-xl text-red-600">
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
                <div className="font-mono font-black text-base text-emerald-700">
                  PAYMENT SETTLED ONLINE / BANK TRANSFER
                </div>
                <span className="text-[10px] font-bold block">
                  Hand over parcel directly to customer upon signature.
                </span>
              </div>
            )}
          </div>

          {/* Shipper & Parcel Info */}
          <div className="grid grid-cols-2 gap-2 text-[10px] pt-1 border-t border-stone-300">
            <div>
              <span className="font-black text-stone-500 uppercase block">FROM (SHIPPER):</span>
              <strong className="block text-black">BEAUTIFUL UAE HOME LLC</strong>
              <span>WH 14, Al Quoz 3, Sheikh Zayed Rd</span>
              <span className="block">Dubai, UAE • +971 50 829 4110</span>
            </div>

            <div className="text-right">
              <span className="font-black text-stone-500 uppercase block">SHIPMENT DETAILS:</span>
              <span>Weight: <strong>{order.courier.weightKg || 2.5} KG</strong></span>
              <span className="block">Pieces: <strong>{order.courier.pieces || 1} PKG</strong></span>
              <span>Contents: <strong>Luxury Bedding Set</strong></span>
            </div>
          </div>
        </div>

        {/* Footer print action */}
        <div className="flex items-center justify-between text-xs text-stone-500 pt-2">
          <span>Official Carrier Compliant Format</span>
          <button
            onClick={handlePrint}
            className="flex items-center gap-1.5 text-stone-900 font-bold hover:underline"
          >
            <Printer className="w-4 h-4 text-[#c5a059]" />
            <span>Send to Thermal / AirPrint</span>
          </button>
        </div>
      </div>
    </div>
  );
};
