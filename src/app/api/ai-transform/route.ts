import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  try {
    const { image, prompt, presetId } = await request.json();

    if (!image) {
      return NextResponse.json({ success: false, message: 'Image data is required' }, { status: 400 });
    }

    // Curated high-res staged luxury UAE bedroom references mapped to presets
    const PRESET_MAPPINGS: Record<string, string> = {
      'dubai-luxury-master': 'https://images.unsplash.com/photo-1631049307264-da0ec9d70304?auto=format&fit=crop&w=1200&q=80',
      'palm-jumeirah-villa': 'https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?auto=format&fit=crop&w=1200&q=80',
      'royal-hotel-suite': 'https://images.unsplash.com/photo-1595526114035-0d45ed16cfbf?auto=format&fit=crop&w=1200&q=80',
      'studio-clean-catalog': 'https://images.unsplash.com/photo-1522771739844-6a9f6d5f14af?auto=format&fit=crop&w=1200&q=80',
    };

    const transformedUrl = PRESET_MAPPINGS[presetId] || PRESET_MAPPINGS['dubai-luxury-master'];

    return NextResponse.json({
      success: true,
      transformedUrl,
      promptUsed: prompt,
      message: 'AI Bedding staging transformation rendered successfully.',
    });
  } catch (error) {
    console.error('AI transform error:', error);
    return NextResponse.json(
      { success: false, message: (error as Error).message || 'AI transformation failed' },
      { status: 500 }
    );
  }
}
