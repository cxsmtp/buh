/**
 * The product editor's "Room-style filter": a light colour and lighting filter drawn on this
 * device (canvas), for a photo added just now. Nothing leaves the phone and no AI is involved;
 * the real AI staging is "Style in a bedroom" (src/lib/server/stagePhoto.ts, on the server).
 */

export interface RoomFilter {
  id: string;
  name: string;
}

export const ROOM_FILTERS: RoomFilter[] = [
  { id: 'warm-evening', name: 'Warm evening' },
  { id: 'daylight', name: 'Soft daylight' },
  { id: 'studio', name: 'Clean studio' },
];

/** The photo (a data URL) with the filter drawn over it, as a JPEG data URL. Rejects when it can't be drawn. */
export function applyRoomFilter(dataUrl: string, filterId: string): Promise<string> {
  const filter = ROOM_FILTERS.find((f) => f.id === filterId) ?? ROOM_FILTERS[0];
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !dataUrl.startsWith('data:image/')) return reject(new Error('no photo'));
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) return reject(new Error('no canvas'));
      canvas.width = 1200;
      canvas.height = 900;

      const bg = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
      if (filter.id === 'warm-evening') {
        bg.addColorStop(0, '#1c1b18');
        bg.addColorStop(0.5, '#2b2720');
        bg.addColorStop(1, '#161411');
      } else if (filter.id === 'daylight') {
        bg.addColorStop(0, '#f2ede4');
        bg.addColorStop(1, '#e3d7c5');
      } else {
        bg.addColorStop(0, '#f8fafc');
        bg.addColorStop(1, '#e2e8f0');
      }
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.save();
      ctx.filter = 'contrast(108%) saturate(105%) brightness(102%)';
      const scale = Math.max(canvas.width / img.width, canvas.height / img.height) * 0.92;
      const x = (canvas.width - img.width * scale) / 2;
      const y = (canvas.height - img.height * scale) / 2 + 15;
      ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
      ctx.shadowBlur = 40;
      ctx.shadowOffsetY = 25;
      ctx.drawImage(img, x, y, img.width * scale, img.height * scale);
      ctx.restore();

      ctx.save();
      ctx.fillStyle = 'rgba(197, 160, 89, 0.08)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.restore();

      resolve(canvas.toDataURL('image/jpeg', 0.92));
    };
    img.onerror = () => reject(new Error('unreadable photo'));
    img.src = dataUrl;
  });
}
