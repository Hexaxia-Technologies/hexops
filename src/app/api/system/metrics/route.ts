import { NextResponse } from 'next/server';
import { getSystemMetrics } from '@/lib/system-metrics';

export async function GET() {
  try {
    const metrics = await getSystemMetrics();
    return NextResponse.json(metrics);
  } catch (error) {
    console.error('Error fetching system metrics:', error);
    return NextResponse.json(
      { error: 'Failed to fetch system metrics' },
      { status: 500 }
    );
  }
}
