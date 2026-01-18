import { NextRequest, NextResponse } from 'next/server';
import { readPatchHistory } from '@/lib/patch-storage';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const projectId = searchParams.get('projectId');
    const limit = parseInt(searchParams.get('limit') || '50', 10);

    const history = readPatchHistory();
    let updates = history.updates;

    // Filter by project if specified
    if (projectId) {
      updates = updates.filter(u => u.projectId === projectId);
    }

    // Apply limit
    updates = updates.slice(0, limit);

    return NextResponse.json({
      updates,
      total: history.updates.length,
    });
  } catch (error) {
    console.error('Error fetching patch history:', error);
    return NextResponse.json(
      { error: 'Failed to fetch patch history' },
      { status: 500 }
    );
  }
}
