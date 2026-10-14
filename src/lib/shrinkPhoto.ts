'use client';

/**
 * Phone photos are often 3–8 MB. Shrink to at most 1600 px on the long side,
 * as JPEG, before upload, so saving a product is quick and stays under the
 * server's 3 MB per-image limit. Orientation from the camera is applied.
 */
export async function shrinkPhoto(file: File, maxSide = 1600): Promise<string> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('This photo format cannot be read here. Please use a JPEG or PNG photo.');
  }
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not prepare the photo.');
  ctx.fillStyle = '#ffffff'; // transparent PNGs become white, not black, as JPEG
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  for (const quality of [0.85, 0.75, 0.6]) {
    const url = canvas.toDataURL('image/jpeg', quality);
    if (url.length < 2.5 * 1024 * 1024) return url;
  }
  return canvas.toDataURL('image/jpeg', 0.5);
}
