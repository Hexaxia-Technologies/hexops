import { NextRequest, NextResponse } from 'next/server';
import { getProject } from '@/lib/config';
import { exec } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import { auditCache } from '../package-health/route';
import { detectPackageManager } from '@/lib/patch-scanner';

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

    const pm = detectPackageManager(cwd);

    if (!pm) {
      const rawOutput = `No lockfile found in ${cwd}

To run a security audit, run one of these commands in the project directory:
  pnpm install   (creates pnpm-lock.yaml)
  npm install    (creates package-lock.json)
  yarn install   (creates yarn.lock)`;

      return NextResponse.json({
        success: true,
        vulnerabilities: [],
        count: 0,
        rawOutput,
      });
    }

    try {
      // Use the appropriate package manager based on lockfile
      let auditOutput: string;
      const auditCmd = pm === 'pnpm'
        ? 'pnpm audit --json'
        : pm === 'npm'
        ? 'npm audit --json'
        : 'yarn audit --json';

      try {
        const { stdout } = await execAsync(auditCmd, { cwd });
        auditOutput = stdout;
      } catch (err: unknown) {
        // These commands return non-zero exit code if vulnerabilities found
        const execErr = err as { stdout?: string };
        auditOutput = execErr.stdout || '{}';
      }

      // Parse audit output - strip any warnings before JSON
      const jsonStart = auditOutput.search(/[\[{]/);
      const jsonOutput = jsonStart >= 0 ? auditOutput.slice(jsonStart) : '{}';
      const auditData = JSON.parse(jsonOutput);

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

    // Get human-readable output for display
    let rawOutput = '';
    const cmd = pm === 'pnpm' ? 'pnpm audit' : pm === 'npm' ? 'npm audit' : 'yarn audit';
    try {
      const { stdout, stderr } = await execAsync(`${cmd} 2>&1 || true`, { cwd });
      rawOutput = stdout || stderr || 'No output';
    } catch {
      rawOutput = 'Failed to get raw audit output';
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
      rawOutput,
    });
  } catch (error) {
    console.error('Error running audit:', error);
    return NextResponse.json(
      { error: 'Failed to run audit' },
      { status: 500 }
    );
  }
}
