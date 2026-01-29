import { NextRequest, NextResponse } from 'next/server';
import { readLogs, getLogStats, getLoggedProjects } from '@/lib/log-reader';
import type { LogLevel, LogCategory } from '@/lib/logger';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);

    // Check for stats request
    if (searchParams.get('stats') === 'true') {
      const stats = getLogStats();
      return NextResponse.json(stats);
    }

    // Check for projects list request
    if (searchParams.get('projects') === 'true') {
      const projects = getLoggedProjects();
      return NextResponse.json({ projects });
    }

    // Parse query parameters
    const level = searchParams.get('level') as LogLevel | null;
    const category = searchParams.get('category') as LogCategory | null;
    const projectId = searchParams.get('projectId');
    const search = searchParams.get('search');
    const limit = parseInt(searchParams.get('limit') || '100');
    const before = searchParams.get('before');

    // Read logs with filters
    const logs = readLogs({
      ...(level && { level }),
      ...(category && { category }),
      ...(projectId && { projectId }),
      ...(search && { search }),
      limit: Math.min(limit, 500), // Cap at 500
      ...(before && { before }),
    });

    // Get stats for total count
    const stats = getLogStats();

    return NextResponse.json({
      logs,
      total: stats.totalEntries,
      returned: logs.length,
      hasMore: logs.length === Math.min(limit, 500),
    });
  } catch (error) {
    console.error('Error reading logs:', error);
    return NextResponse.json(
      { error: 'Failed to read logs' },
      { status: 500 }
    );
  }
}
