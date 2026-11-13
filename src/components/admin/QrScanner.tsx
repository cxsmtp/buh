'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Camera, X } from 'lucide-react';

/**
 * The phone's camera reading the shop's QR stickers (Inventory → Scan, and "Scan to check" on an
 * order). The browser's own reader where it has one (Android Chrome), else jsQR on the camera's
 * frames (iPhone Safari). The same code is not reported twice in a row within 2 s. A box to type
 * the stock code is always there (no camera, or a torn sticker).
 */

type Detector = { detect: (src: CanvasImageSource) => Promise<Array<{ rawValue: string }>> };
type DetectorCtor = new (opts: { formats: string[] }) => Detector;

export function QrScanner({ onScan, onClose, title = 'Scan a sticker' }: { onScan: (text: string) => void; onClose: () => void; title?: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const last = useRef<{ text: string; at: number }>({ text: '', at: 0 });
  const [problem, setProblem] = useState('');
  const [typed, setTyped] = useState('');
  const report = useRef(onScan);
  useEffect(() => {
    report.current = onScan;
  }, [onScan]);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const found = (text: string) => {
      const now = Date.now();
      if (text === last.current.text && now - last.current.at < 2000) return;
      last.current = { text, at: now };
      if (typeof navigator.vibrate === 'function') navigator.vibrate(60);
      report.current(text);
    };
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setProblem('The camera is not available here: type the stock code below.');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      } catch {
        setProblem('The camera was not allowed: allow it in the browser, or type the stock code below.');
        return;
      }
      if (stop || !video.current) return;
      video.current.srcObject = stream;
      await video.current.play().catch(() => undefined);
      const Native = (globalThis as unknown as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;
      const detector = Native ? new Native({ formats: ['qr_code'] }) : null;
      const jsQR = detector ? null : (await import('jsqr')).default;
      const tick = async () => {
        if (stop || !video.current || !canvas.current) return;
        const v = video.current;
        if (v.readyState >= 2 && v.videoWidth) {
          try {
            if (detector) {
              const codes = await detector.detect(v);
              if (codes[0]?.rawValue) found(codes[0].rawValue);
            } else if (jsQR) {
              const c = canvas.current;
              const scale = Math.min(1, 640 / v.videoWidth);
              c.width = Math.round(v.videoWidth * scale);
              c.height = Math.round(v.videoHeight * scale);
              const ctx = c.getContext('2d', { willReadFrequently: true });
              if (ctx) {
                ctx.drawImage(v, 0, 0, c.width, c.height);
                const img = ctx.getImageData(0, 0, c.width, c.height);
                const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
                if (code?.data) found(code.data);
              }
            }
          } catch {
            // a frame that could not be read: try the next one
          }
        }
        timer = setTimeout(() => void tick(), 180);
      };
      void tick();
    })();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <div className="rounded-2xl border border-line bg-surface p-3 space-y-2 text-xs" data-testid="qr-scanner">
      <div className="flex items-center justify-between gap-2">
        <strong className="text-ink text-sm flex items-center gap-1.5">
          <Camera className="w-4 h-4 text-gold-deep" aria-hidden="true" /> {title}
        </strong>
        <button type="button" onClick={onClose} aria-label="Close the scanner" className="w-10 h-10 rounded-full flex items-center justify-center hover:bg-sand focus:outline-none focus-visible:ring-2 focus-visible:ring-gold">
          <X className="w-5 h-5" aria-hidden="true" />
        </button>
      </div>
      {!problem && (
        <div className="relative mx-auto w-full max-w-xs aspect-square overflow-hidden rounded-xl bg-ink">
          <video ref={video} muted playsInline className="w-full h-full object-cover" aria-label="Camera: point it at a sticker's QR code" />
          <div className="pointer-events-none absolute inset-[18%] rounded-lg border-2 border-gold" aria-hidden="true" />
        </div>
      )}
      <canvas ref={canvas} className="hidden" aria-hidden="true" />
      {problem && <p role="status" className="text-warning font-semibold">{problem}</p>}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (typed.trim()) {
            report.current(typed.trim());
            setTyped('');
          }
        }}
      >
        <label className="sr-only" htmlFor="qr-typed">Stock code</label>
        <input id="qr-typed" value={typed} onChange={(e) => setTyped(e.target.value)} maxLength={60} placeholder="Or type the stock code, e.g. BUH-HBS-INDCHV-007-KING" className="flex-1 min-w-0 min-h-10 px-3 rounded-xl border border-line-strong bg-surface text-ink text-xs focus:outline-none focus:ring-2 focus:ring-gold" />
        <button type="submit" className="min-h-10 px-3 rounded-xl bg-ink text-paper font-semibold">Find</button>
      </form>
    </div>
  );
}
