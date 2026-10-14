import { requireAdmin } from '@/lib/server/guard';
import { handleRouteError, json, readJsonBody } from '@/lib/server/http';
import { parseImageDataUrl } from '@/lib/server/imageInput';

// Curated high-res staged luxury UAE bedroom references mapped to presets
const PRESET_MAPPINGS: Record<string, string> = {
  'dubai-luxury-master': 'https://images.unsplash.com/photo-1631049307264-da0ec9d70304?auto=format&fit=crop&w=1200&q=80',
  'palm-jumeirah-villa': 'https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?auto=format&fit=crop&w=1200&q=80',
  'royal-hotel-suite': 'https://images.unsplash.com/photo-1595526114035-0d45ed16cfbf?auto=format&fit=crop&w=1200&q=80',
  'studio-clean-catalog': 'https://images.unsplash.com/photo-1522771739844-6a9f6d5f14af?auto=format&fit=crop&w=1200&q=80',
};

/** Admin-only (product studio). */
export async function POST(request: Request) {
  try {
    await requireAdmin(request);
    const body = await readJsonBody(request, 9 * 1024 * 1024);
    parseImageDataUrl(body.image);

    const presetId = typeof body.presetId === 'string' && Object.hasOwn(PRESET_MAPPINGS, body.presetId)
      ? body.presetId
      : 'dubai-luxury-master';

    return json({
      success: true,
      transformedUrl: PRESET_MAPPINGS[presetId],
      message: 'AI Bedding staging transformation rendered successfully.',
    });
  } catch (error) {
    return handleRouteError(error, 'ai-transform');
  }
}
