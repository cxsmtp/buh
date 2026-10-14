import { NextRequest, NextResponse } from 'next/server';
import { checkJeeblyServiceability } from '@/lib/jeeblyServiceability';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { emirate, area, lat, lng } = body;

    const result = checkJeeblyServiceability({
      emirate,
      area,
      lat: typeof lat === 'number' ? lat : undefined,
      lng: typeof lng === 'number' ? lng : undefined,
    });

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      {
        serviceable: false,
        error: 'Unable to verify serviceability: ' + (error instanceof Error ? error.message : 'Unknown error'),
      },
      { status: 500 }
    );
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const emirate = searchParams.get('emirate') || 'Dubai';
  const area = searchParams.get('area') || undefined;
  const latStr = searchParams.get('lat');
  const lngStr = searchParams.get('lng');

  const lat = latStr ? parseFloat(latStr) : undefined;
  const lng = lngStr ? parseFloat(lngStr) : undefined;

  const result = checkJeeblyServiceability({ emirate, area, lat, lng });
  return NextResponse.json(result);
}
