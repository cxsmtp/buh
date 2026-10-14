import { NextResponse } from 'next/server';
import { Order, CourierSettings } from '@/types';
import { createJeeblyShipment } from '@/lib/jeebly';
import { createEchoShipment } from '@/lib/echo';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { order, provider, settings }: { order: Order; provider: 'jeebly' | 'echo'; settings: CourierSettings } = body;

    if (!order) {
      return NextResponse.json({ success: false, message: 'Order data is required' }, { status: 400 });
    }

    if (provider === 'jeebly') {
      const result = await createJeeblyShipment(order, settings.jeebly);
      return NextResponse.json(result);
    } else if (provider === 'echo') {
      const result = await createEchoShipment(order, settings.echo);
      return NextResponse.json(result);
    } else {
      return NextResponse.json({ success: false, message: `Unknown courier provider: ${provider}` }, { status: 400 });
    }
  } catch (error) {
    console.error('Courier dispatch API route error:', error);
    return NextResponse.json(
      { success: false, message: (error as Error).message || 'Failed to dispatch shipment' },
      { status: 500 }
    );
  }
}
