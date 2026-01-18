import { NextRequest, NextResponse } from 'next/server';
import { getProject } from '@/lib/config';
import { readFile } from 'fs/promises';
import { join } from 'path';

// In-memory cache for audit results (in production, use a proper cache/db)
const auditCache = new Map<string, { data: unknown; timestamp: number }>();
const outdatedCache = new Map<string, { data: unknown; timestamp: number }>();

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

interface Dependency {
  name: string;
  current: string;
  wanted?: string;
  latest?: string;
  isOutdated: boolean;
}

interface Vulnerability {
  name: string;
  severity: 'info' | 'low' | 'moderate' | 'high' | 'critical';
  title: string;
  path: string;
  fixAvailable: boolean;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const project = getProject(id);

    if (!project) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      );
    }

    // Read package.json
    const packageJsonPath = join(project.path, 'package.json');
    const packageJsonContent = await readFile(packageJsonPath, 'utf-8');
    const packageJson = JSON.parse(packageJsonContent);

    // Get outdated info from cache
    const outdatedData = outdatedCache.get(id);
    const outdatedInfo: Record<string, { current: string; wanted: string; latest: string }> =
      outdatedData && Date.now() - outdatedData.timestamp < CACHE_TTL
        ? (outdatedData.data as Record<string, { current: string; wanted: string; latest: string }>)
        : {};

    // Parse dependencies
    const parseDeps = (deps: Record<string, string> | undefined): Dependency[] => {
      if (!deps) return [];
      return Object.entries(deps).map(([name, version]) => {
        const outdated = outdatedInfo[name];
        return {
          name,
          current: version.replace(/^[\^~]/, ''),
          wanted: outdated?.wanted,
          latest: outdated?.latest,
          isOutdated: !!outdated,
        };
      });
    };

    const dependencies = parseDeps(packageJson.dependencies);
    const devDependencies = parseDeps(packageJson.devDependencies);

    // Get audit info from cache
    const auditData = auditCache.get(id);
    const vulnerabilities: Vulnerability[] =
      auditData && Date.now() - auditData.timestamp < CACHE_TTL
        ? (auditData.data as Vulnerability[])
        : [];

    return NextResponse.json({
      dependencies,
      devDependencies,
      vulnerabilities,
      lastAuditDate: auditData?.timestamp ? new Date(auditData.timestamp).toISOString() : undefined,
    });
  } catch (error) {
    console.error('Error fetching package health:', error);
    return NextResponse.json(
      { error: 'Failed to fetch package health' },
      { status: 500 }
    );
  }
}

// Export cache for use by audit and outdated routes
export { auditCache, outdatedCache };
