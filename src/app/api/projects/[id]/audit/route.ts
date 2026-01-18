import { NextRequest, NextResponse } from 'next/server';
import { getProject } from '@/lib/config';
import { exec } from 'child_process';
import { promisify } from 'util';
import { auditCache } from '../package-health/route';

const execAsync = promisify(exec);

interface Vulnerability {
  name: string;
  severity: 'info' | 'low' | 'moderate' | 'high' | 'critical';
  title: string;
  path: string;
  fixAvailable: boolean;
}

export async function POST(
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

    const cwd = project.path;
    const vulnerabilities: Vulnerability[] = [];

    try {
      // Try pnpm first, fall back to npm
      let auditOutput: string;
      try {
        const { stdout } = await execAsync('pnpm audit --json', { cwd });
        auditOutput = stdout;
      } catch (pnpmError: unknown) {
        // pnpm audit returns non-zero exit code if vulnerabilities found
        const pnpmErr = pnpmError as { stdout?: string };
        if (pnpmErr.stdout) {
          auditOutput = pnpmErr.stdout;
        } else {
          // Try npm
          try {
            const { stdout } = await execAsync('npm audit --json', { cwd });
            auditOutput = stdout;
          } catch (npmError: unknown) {
            const npmErr = npmError as { stdout?: string };
            auditOutput = npmErr.stdout || '{}';
          }
        }
      }

      // Parse audit output
      const auditData = JSON.parse(auditOutput || '{}');

      // pnpm format
      if (auditData.advisories) {
        Object.values(auditData.advisories).forEach((advisory: unknown) => {
          const adv = advisory as {
            module_name: string;
            severity: string;
            title: string;
            findings: Array<{ paths: string[] }>;
            patched_versions: string;
          };
          vulnerabilities.push({
            name: adv.module_name,
            severity: adv.severity as Vulnerability['severity'],
            title: adv.title,
            path: adv.findings?.[0]?.paths?.[0] || adv.module_name,
            fixAvailable: adv.patched_versions !== '<0.0.0',
          });
        });
      }

      // npm format (v7+)
      if (auditData.vulnerabilities) {
        Object.entries(auditData.vulnerabilities).forEach(([name, data]: [string, unknown]) => {
          const vuln = data as {
            severity: string;
            via: Array<{ title?: string }>;
            fixAvailable: boolean;
          };
          vulnerabilities.push({
            name,
            severity: vuln.severity as Vulnerability['severity'],
            title: vuln.via?.[0]?.title || 'Vulnerability',
            path: name,
            fixAvailable: vuln.fixAvailable,
          });
        });
      }
    } catch (error) {
      console.error('Audit command failed:', error);
      // Continue with empty vulnerabilities
    }

    // Cache the results
    auditCache.set(id, {
      data: vulnerabilities,
      timestamp: Date.now(),
    });

    return NextResponse.json({
      success: true,
      vulnerabilities,
      count: vulnerabilities.length,
    });
  } catch (error) {
    console.error('Error running audit:', error);
    return NextResponse.json(
      { error: 'Failed to run audit' },
      { status: 500 }
    );
  }
}
