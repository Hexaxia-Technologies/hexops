import { NextRequest, NextResponse } from 'next/server';
import { getProject } from '@/lib/config';
import { exec } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { auditCache } from '../package-health/route';
import { detectPackageManager } from '@/lib/patch-scanner';
import { scanSpecVulnerabilities } from '@/lib/spec-scanner';
import { checkLockFileFreshness } from '@/lib/lockfile-checker';

const execAsync = promisify(exec);

interface Vulnerability {
  name: string;
  severity: 'info' | 'low' | 'moderate' | 'high' | 'critical';
  title: string;
  path: string;
  fixAvailable: boolean;
  fixViaOverride?: boolean;
  isDirect: boolean;
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

    // Read direct dependencies to distinguish direct vs transitive vulns
    let directDeps: Set<string> = new Set();
    try {
      const pkgJsonPath = join(cwd, 'package.json');
      if (existsSync(pkgJsonPath)) {
        const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
        const deps = Object.keys(pkgJson.dependencies || {});
        const devDeps = Object.keys(pkgJson.devDependencies || {});
        directDeps = new Set([...deps, ...devDeps]);
      }
    } catch {
      // If we can't read package.json, assume all are direct (fail open)
    }

    const pm = detectPackageManager(cwd);

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
          const isDirect = directDeps.size === 0 || directDeps.has(adv.module_name);
          const hasPatch = adv.patched_versions !== '<0.0.0';
          vulnerabilities.push({
            name: adv.module_name,
            severity: adv.severity as Vulnerability['severity'],
            title: adv.title,
            path: adv.findings?.[0]?.paths?.[0] || adv.module_name,
            // All vulns are actionable — transitive deps are fixed via override
            fixAvailable: isDirect ? hasPatch : true,
            fixViaOverride: !isDirect || undefined,
            isDirect,
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
          const isDirect = directDeps.size === 0 || directDeps.has(name);
          vulnerabilities.push({
            name,
            severity: vuln.severity as Vulnerability['severity'],
            title: vuln.via?.[0]?.title || 'Vulnerability',
            path: name,
            // All vulns are actionable — transitive deps are fixed via override
            fixAvailable: isDirect ? !!vuln.fixAvailable : true,
            fixViaOverride: !isDirect || undefined,
            isDirect,
          });
        });
      }
    } catch (error) {
      console.error('Audit command failed:', error);
      // Continue with empty vulnerabilities
    }

    // Run spec scanner (catches pinned vulnerable versions without lock files)
    try {
      const specVulns = await scanSpecVulnerabilities(cwd);
      const auditNames = new Set(vulnerabilities.map(v => v.name));
      for (const sv of specVulns) {
        if (!auditNames.has(sv.name)) {
          vulnerabilities.push({
            name: sv.name,
            severity: sv.severity,
            title: sv.title,
            path: sv.path,
            fixAvailable: sv.fixAvailable,
            isDirect: true,
          });
        }
      }
    } catch (error) {
      console.error('Spec scanner failed:', error);
    }

    // Check for stale lock files
    const lockCheck = checkLockFileFreshness(cwd);
    if (!lockCheck.fresh) {
      for (const mismatch of lockCheck.mismatches) {
        vulnerabilities.push({
          name: mismatch.package,
          severity: 'info',
          title: `Stale lockfile: spec ${mismatch.packageJsonSpec} but lock has ${mismatch.lockfileSpec}`,
          path: mismatch.package,
          fixAvailable: true,
          isDirect: true,
        });
      }
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
