import { NextRequest, NextResponse } from 'next/server';
import { readPatchHistory } from '@/lib/patch-storage';

const MAX_LIMIT = 500;

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const projectId = searchParams.get('projectId');
    const rawLimit = parseInt(searchParams.get('limit') || '50', 10);
    
    // Validate and clamp limit
    const limit = Math.min(Math.max(isNaN(rawLimit) ? 50 : rawLimit, 1), MAX_LIMIT);

    const history = readPatchHistory();
    let updates = history.updates;

    // Filter by project if specified
    if (projectId) {
      updates = updates.filter(u => u.projectId === projectId);
    }

    // Get total before slicing
    const total = updates.length;

    // Apply limit
    updates = updates.slice(0, limit);

    return NextResponse.json({
      updates,
      total,
    });
  } catch (error) {
    console.error('Error fetching patch history:', error);
    return NextResponse.json(
      { error: 'Failed to fetch patch history' },
      { status: 500 }
    );
  }
}
