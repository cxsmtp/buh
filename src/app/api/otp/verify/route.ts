import { NextRequest, NextResponse } from 'next/server';
import { verifyRealSmsOtp } from '@/lib/otpService';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { phone, code, otp } = body;
    const token = code || otp;

    if (!phone || !token) {
      return NextResponse.json(
        { valid: false, message: 'Both phone and 4-digit OTP code are required.' },
        { status: 400 }
      );
    }

    const result = verifyRealSmsOtp(phone, token);
    return NextResponse.json(result);
  } catch (error) {
    console.error('Error in /api/otp/verify:', error);
    return NextResponse.json(
      {
        valid: false,
        message: 'Verification failed: ' + (error instanceof Error ? error.message : 'Internal error'),
      },
      { status: 500 }
    );
  }
}
