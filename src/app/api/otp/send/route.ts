import { NextRequest, NextResponse } from 'next/server';
import { sendRealSmsOtp, normalizePhoneNumber } from '@/lib/otpService';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { phone, settings } = body;

    if (!phone || typeof phone !== 'string' || phone.trim().length < 8) {
      return NextResponse.json(
        { success: false, message: 'Please provide a valid phone number (e.g. +971 50 123 4567)' },
        { status: 400 }
      );
    }

    const result = await sendRealSmsOtp(phone, settings);
    return NextResponse.json(result);
  } catch (error) {
    console.error('Error in /api/otp/send:', error);
    return NextResponse.json(
      {
        success: false,
        message: 'Failed to dispatch OTP: ' + (error instanceof Error ? error.message : 'Internal server error'),
      },
      { status: 500 }
    );
  }
}
