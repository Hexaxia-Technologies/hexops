import { NextResponse } from 'next/server';
import { getGlobalSettings, updateGlobalSettings } from '@/lib/settings';
import type { GlobalSettings } from '@/lib/types';

export async function GET() {
  try {
    const settings = getGlobalSettings();
    return NextResponse.json(settings);
  } catch (error) {
    console.error('Failed to get settings:', error);
    return NextResponse.json(
      { error: 'Failed to get settings' },
      { status: 500 }
    );
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json() as Partial<GlobalSettings>;
    const updated = updateGlobalSettings(body);
    return NextResponse.json(updated);
  } catch (error) {
    console.error('Failed to update settings:', error);
    return NextResponse.json(
      { error: 'Failed to update settings' },
      { status: 500 }
    );
  }
}
