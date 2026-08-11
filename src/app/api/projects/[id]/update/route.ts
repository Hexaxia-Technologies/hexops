import { NextRequest, NextResponse } from 'next/server';
import { getProject } from '@/lib/config';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { invalidateProjectCache } from '@/lib/patch-storage';
import { detectPackageManager } from '@/lib/patch-scanner';
import { resolveLockfile } from '@/lib/lockfile-resolver';
import { getGlobalSettings, getProjectSettings } from '@/lib/settings';
import { invalidatePackageStatusCache } from '@/lib/extended-status';
import { clearInMemoryCache } from '@/app/api/projects/[id]/package-health/route';
import { logger } from '@/lib/logger';
import type { LockfileResolutionMode } from '@/lib/types';

import { verifyAuditClear, type UpdatePackage } from '@/lib/updaters/common';
import { checkNodeModulesHealth, cleanNodeModules } from '@/lib/updaters/npm';
import { checkPnpmLockfileHealth, repairPnpmLockfile, buildPnpmUpdateCmd } from '@/lib/updaters/pnpm';
import { buildNpmUpdateCmd } from '@/lib/updaters/npm';
import { buildYarnUpdateCmd } from '@/lib/updaters/yarn';
import { applyOverrides, removeOverrideConflicts, cleanStaleOverrides } from '@/lib/updaters/override';
import { installPackages } from '@/lib/updaters/install';
import { execAsync } from '@/lib/updaters/common';
import { SECURITY_PLUGINS } from '@/lib/security/plugins';
import { isPluginEnabledForProject } from '@/lib/security/plugins/config';
import { AUTO_APPLY_ENABLED } from '@/lib/auto-apply-flag';
import { runWithDevServerGuard } from '@/lib/process-manager';

const NPM_INSTALL_TIMEOUT = 120000;

interface UpdateRequestBody {
  packages?: Array<{
    name: string;
    fromVersion?: string;
    toVersion: string;
    fixViaOverride?: boolean;
    fixByParent?: { name: string; version: string };
  }>;
  lockfileResolution?: LockfileResolutionMode;
  auditContext?: {
    source?: string;
    advisories?: string[];
    severity?: string;
    attemptId?: string;       // change-control tracking id
  };
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    if (!AUTO_APPLY_ENABLED) {
      return NextResponse.json(
        { success: false, error: 'Auto-apply is disabled in HexOps. Re-enable AUTO_APPLY_ENABLED to apply updates.' },
        { status: 409 },
      );
    }

    const { id } = await params;
    const body: UpdateRequestBody = await request.json().catch(() => ({}));
    const packages = body.packages || [];

    // Change-control: extract attemptId up-front so it's available to all log sites
    const attemptId = body.auditContext?.attemptId;

    const project = getProject(id);
    if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });

    // #109: if this project's dev server is live, stop it before churning
    // node_modules and restart it after; refuse outright if the target is
    // hexops itself (we'd kill the server serving this request mid-apply).
    const runApply = async (): Promise<{ status?: number; body: Record<string, unknown> }> => {
    const cwd = project.path;

    const projectSettings = getProjectSettings(id);
    const globalSettings = getGlobalSettings();
    const resolutionMode: LockfileResolutionMode =
      body.lockfileResolution ??
      (projectSettings.patching?.lockfileResolution === 'global'
        ? globalSettings.patching?.defaultLockfileResolution
        : projectSettings.patching?.lockfileResolution as LockfileResolutionMode) ??
      'clean-slate';

    const resolution = await resolveLockfile(cwd, resolutionMode);
    if (!resolution.success) {
      return { status: 500, body: { success: false, error: `Lockfile resolution (${resolutionMode}) failed`, resolution } };
    }

    // Change-control: log intent before the install runs so failure cases still have a record
    if (attemptId && body.auditContext?.source) {
      logger.info('security', 'remediation_initiated', `Apply attempt ${attemptId} initiated for ${id}`, {
        projectId: id,
        meta: {
          attemptId,
          source: body.auditContext.source,
          parameters: {
            packages: body.packages?.map(p => ({
              name: p.name,
              fromVersion: p.fromVersion,
              toVersion: p.toVersion,
              fixViaOverride: p.fixViaOverride ?? false,
            })) ?? [],
            advisoryIds: body.auditContext.advisories ?? [],
            severity: body.auditContext.severity,
            lockfileResolution: body.lockfileResolution,
          },
        },
      });
    }

    const packageManager = resolution.packageManager;

    let isWorkspaceProject = false;
    try {
      const pkgJsonPath = join(cwd, 'package.json');
      if (existsSync(pkgJsonPath)) {
        const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
        isWorkspaceProject = Array.isArray(pkgJson.workspaces) && pkgJson.workspaces.length > 0;
      }
    } catch { /* ignore */ }

    const results: Array<{ package: string; success: boolean; output: string; error?: string }> = [];

    // Install-gate state — set when an installGate plugin rewrites the binary;
    // carried to the audit-trail log at the bottom of the closure.
    let installBinOverride: string | undefined;
    let activeGatePlugin: string | undefined;

    // Pre-flight health checks
    if (packageManager === 'npm' && packages.length > 1) {
      const health = await checkNodeModulesHealth(cwd);
      if (!health.healthy) {
        logger.warn('patches', 'preflight_unhealthy', `${health.reason} in ${id}, running clean reinstall`, { projectId: id });
        await cleanNodeModules(cwd);
      }
    } else if (packageManager === 'pnpm') {
      const health = await checkPnpmLockfileHealth(cwd);
      if (!health.healthy) {
        logger.warn('patches', 'preflight_lockfile_broken', `${health.reason} in ${id}, regenerating lockfile`, { projectId: id });
        const repaired = await repairPnpmLockfile(cwd);
        if (repaired) {
          logger.info('patches', 'lockfile_repaired', `pnpm lockfile regenerated for ${id}`, { projectId: id });
        } else {
          logger.error('patches', 'lockfile_repair_failed', `Failed to regenerate pnpm lockfile for ${id}`, { projectId: id });
        }
      }
    }

    if (packages.length > 0) {
      // Validate all packages
      const validPackages: UpdatePackage[] = [];
      for (const pkg of packages) {
        if (!/^[@a-z0-9][\w\-./@]*$/i.test(pkg.name)) {
          results.push({ package: pkg.name, success: false, output: '', error: 'Invalid package name' });
          continue;
        }
        const targetVersion = pkg.toVersion || 'latest';
        if (!/^(latest|next|canary|[\w\-.^~<>=|@]+)$/i.test(targetVersion)) {
          results.push({ package: pkg.name, success: false, output: '', error: 'Invalid version specifier' });
          continue;
        }

        let effectiveFromVersion = pkg.fromVersion || '';
        if (!effectiveFromVersion && !/^(latest|next|canary|resolve-latest)$/.test(targetVersion)) {
          try {
            const nmPath = join(cwd, 'node_modules', pkg.name, 'package.json');
            if (existsSync(nmPath)) {
              effectiveFromVersion = JSON.parse(readFileSync(nmPath, 'utf-8')).version || '';
            }
          } catch { /* fall through */ }
        }
        if (effectiveFromVersion && !/^(latest|next|canary|resolve-latest)$/.test(targetVersion)) {
          const fv = effectiveFromVersion.replace(/^[\^~]/, '').split('.').map(n => parseInt(n, 10) || 0);
          const tv = targetVersion.replace(/^[\^~]/, '').split('.').map(n => parseInt(n, 10) || 0);
          const isDowngrade = fv[0] > tv[0] || (fv[0] === tv[0] && fv[1] > tv[1]) || (fv[0] === tv[0] && fv[1] === tv[1] && (fv[2] ?? 0) > (tv[2] ?? 0));
          if (isDowngrade) {
            results.push({ package: pkg.name, success: false, output: '', error: `Refused: ${targetVersion} is older than installed ${effectiveFromVersion} — package is already past this fix` });
            continue;
          }
        }
        // Use effectiveFromVersion (falls back to reading node_modules when the
        // request omitted fromVersion), not the raw request field. applyOverrides'
        // stale-tree guard (override.ts) compares node_modules against fromVersion
        // to tell "the install genuinely ran" apart from "node_modules was already
        // in this state before we started" — if the raw (often-absent) request
        // field is threaded through instead, that guard silently never fires for
        // any request that omits fromVersion, which is the common case.
        validPackages.push({ name: pkg.name, fromVersion: effectiveFromVersion || undefined, targetVersion, fixViaOverride: pkg.fixViaOverride, fixByParent: pkg.fixByParent });
      }

      // Separate transitive / override / direct packages
      let directDeps: Set<string> = new Set();
      try {
        const pkgJsonPath = join(cwd, 'package.json');
        if (existsSync(pkgJsonPath)) {
          const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
          directDeps = new Set([
            ...Object.keys(pkgJson.dependencies || {}),
            ...Object.keys(pkgJson.devDependencies || {}),
          ]);
        }
      } catch { /* fail open */ }

      const overridePkgs: UpdatePackage[] = [];
      const directPkgs: UpdatePackage[] = [];

      if (directDeps.size > 0) {
        for (const pkg of validPackages) {
          if (directDeps.has(pkg.name)) {
            directPkgs.push(pkg);
          } else if (pkg.fixByParent && directDeps.has(pkg.fixByParent.name)) {
            const alreadyQueued = directPkgs.some(p => p.name === pkg.fixByParent!.name);
            if (!alreadyQueued) {
              directPkgs.push({ name: pkg.fixByParent.name, fromVersion: undefined, targetVersion: pkg.fixByParent.version });
            }
            logger.info('patches', 'fix_via_parent', `Fixing ${pkg.name} by updating parent ${pkg.fixByParent.name}@${pkg.fixByParent.version}`, {
              projectId: id,
              meta: { transitiveDep: pkg.name, parent: pkg.fixByParent.name, parentVersion: pkg.fixByParent.version },
            });
          } else if (pkg.fixViaOverride) {
            overridePkgs.push(pkg);
          } else {
            results.push({
              package: pkg.name,
              success: false,
              output: '',
              error: `Skipped: ${pkg.name} is a transitive dependency and cannot be updated directly. Update the parent package that depends on it, or add a package manager override.`,
            });
            logger.warn('patches', 'transitive_dep_skipped', `Skipped transitive dep ${pkg.name} in ${id}`, {
              projectId: id,
              meta: { package: pkg.name, targetVersion: pkg.targetVersion },
            });
          }
        }
      } else {
        directPkgs.push(...validPackages);
      }

      if (overridePkgs.length > 0) {
        const overrideResults = await applyOverrides(overridePkgs, packageManager, cwd, id);
        results.push(...overrideResults);
      }

      if (directPkgs.length > 0) {
        removeOverrideConflicts(join(cwd, 'package.json'), directPkgs, packageManager, id);

        // Install-gate: Safe Chain (and any future installGate plugins) can rewrite
        // the install binary to interpose between us and the package manager.
        for (const plugin of SECURITY_PLUGINS) {
          if (plugin.kind !== 'installGate') continue;
          if (!isPluginEnabledForProject(project, plugin.id)) continue;
          const wrapped = await plugin.wrapInstall({
            project,
            command: [packageManager],
            env: process.env,
          });
          if (wrapped.command[0] && wrapped.command[0] !== packageManager) {
            installBinOverride = wrapped.command[0];
            activeGatePlugin = plugin.id;
            break; // first enabled plugin wins; chaining is a future story
          }
        }

        const installResults = await installPackages(directPkgs, packageManager, isWorkspaceProject, cwd, id, installBinOverride);
        results.push(...installResults);
      }
    } else {
      // No packages — run standard semver update
      const cmd = packageManager === 'pnpm'
        ? buildPnpmUpdateCmd(isWorkspaceProject)
        : packageManager === 'npm'
        ? buildNpmUpdateCmd(isWorkspaceProject)
        : buildYarnUpdateCmd(isWorkspaceProject);

      try {
        const { stdout, stderr } = await execAsync(cmd, { cwd, timeout: 180000 });
        results.push({ package: '*', success: true, output: stdout + (stderr ? `\n${stderr}` : '') });
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; message?: string };
        results.push({ package: '*', success: false, output: e.stdout || '', error: e.message || 'Update failed' });
      }
    }

    const anySucceeded = results.some(r => r.success);

    if (anySucceeded) {
      // Reconcile lockfile
      try {
        const reconcileCmd = packageManager === 'pnpm'
          ? 'pnpm install --no-frozen-lockfile'
          : packageManager === 'npm'
          ? 'npm install --legacy-peer-deps'
          : 'yarn install';
        await execAsync(reconcileCmd, { cwd, timeout: NPM_INSTALL_TIMEOUT });
      } catch { /* non-fatal */ }

      cleanStaleOverrides(cwd, packageManager, id);
    }

    // Post-patch audit verification — check ALL attempted packages, not just ones verifyInstalled
    // reported as success, because reconcile can alter installed versions after our checks.
    if (anySucceeded && packages.length > 0) {
      const allAttempted = results.map(r => r.package).filter(n => n !== '*');
      const stillVulnerable = await verifyAuditClear(cwd, packageManager, allAttempted);
      for (const name of stillVulnerable) {
        const idx = results.findIndex(r => r.package === name);
        if (idx !== -1) {
          results[idx].success = false;
          results[idx].error =
            'Advisory still present after patch — nested copy may survive the override. ' +
            'Try a lockfile reset (delete lockfile + reinstall) or escalate to force-override.';
        }
        logger.warn('patches', 'audit_still_vulnerable', `${name} still in audit output after patch`, { projectId: id, meta: { package: name } });
      }
    }

    invalidateProjectCache(id);
    invalidatePackageStatusCache(cwd);
    clearInMemoryCache(id);

    // Cross-project integrity check: if a package was successfully patched, verify no other
    // project has the same package installed at a version OLDER than what we just applied.
    // Catches collateral downgrades caused by stale advisory data (see #79).
    if (anySucceeded && packages.length > 0) {
      try {
        const { getProjects: getAllProjects } = await import('@/lib/config');
        const { existsSync: fsExists, readFileSync: fsRead } = await import('fs');
        const { join: pathJoin } = await import('path');
        const successPatched = results.filter(r => r.success).map(r => r.package);
        const allProjects = getAllProjects().filter(p => p.id !== id);
        const collatDamage: Array<{ projectId: string; projectName: string; package: string; found: string; expected: string }> = [];
        for (const otherProject of allProjects) {
          for (const result of results.filter(r => r.success)) {
            const pkg = result.package;
            const targetVer = packages.find(p => p.name === pkg)?.toVersion;
            if (!targetVer || /^(latest|next|canary)$/.test(targetVer)) continue;
            const nmPath = pathJoin(otherProject.path, 'node_modules', pkg, 'package.json');
            if (!fsExists(nmPath)) continue;
            try {
              const installedVer = JSON.parse(fsRead(nmPath, 'utf-8')).version;
              if (!installedVer) continue;
              const iv = installedVer.split('.').map((n: string) => parseInt(n, 10) || 0);
              const tv = targetVer.replace(/^[\^~]/, '').split('.').map((n: string) => parseInt(n, 10) || 0);
              const isOlder = iv[0] < tv[0] || (iv[0] === tv[0] && iv[1] < tv[1]) || (iv[0] === tv[0] && iv[1] === tv[1] && (iv[2] ?? 0) < (tv[2] ?? 0));
              if (isOlder) {
                collatDamage.push({ projectId: otherProject.id, projectName: otherProject.name, package: pkg, found: installedVer, expected: targetVer });
                logger.warn('patches', 'collateral_downgrade_detected', `${otherProject.name} has ${pkg}@${installedVer} which is older than patched ${targetVer}`, {
                  projectId: otherProject.id,
                  meta: { package: pkg, installed: installedVer, expected: targetVer, affectedBy: id },
                });
              }
            } catch { /* skip */ }
          }
        }
        if (collatDamage.length > 0) {
          const { addNotification } = await import('@/lib/notifications');
          addNotification({
            severity: 'error',
            category: 'security',
            title: 'Possible collateral downgrade detected',
            message: `${collatDamage.length} project(s) may have older versions of recently-patched packages: ${[...new Set(collatDamage.map(d => d.projectName))].join(', ')}`,
            actionUrl: '/patches',
            meta: { collatDamage },
          });
        }
        void successPatched; // suppress unused warning
      } catch { /* non-fatal */ }
    }

    let auditSummary: { vulnCount: number; criticalCount: number; remainingAdvisories: string[] } | undefined;
    if (anySucceeded) {
      try {
        const { scanProject } = await import('@/lib/patch-scanner');
        const { getProject: getProjectConfig } = await import('@/lib/config');
        const projectConfig = getProjectConfig(id);
        if (projectConfig) {
          const freshCache = await scanProject(projectConfig, true);
          if (freshCache) {
            const remaining = (freshCache.vulnerabilities ?? []).map((v: { name: string }) => v.name);
            auditSummary = {
              vulnCount: freshCache.vulnerabilities?.length ?? 0,
              criticalCount: (freshCache.vulnerabilities ?? []).filter(
                (v: { severity: string }) => v.severity === 'critical' || v.severity === 'high'
              ).length,
              remainingAdvisories: [...new Set(remaining)],
            };
          }
        }
      } catch { /* non-fatal */ }
    }

    // Origin-tagged remediation audit trail (e.g. applied from the CVE Lite dashboard or grype panel).
    if (anySucceeded && body.auditContext?.source) {
      const successfulNames = results.filter(r => r.success).map(r => r.package).filter(n => n !== '*');
      logger.info('security', 'remediation_install_complete',
        `Applied security fix in ${id}: ${successfulNames.join(', ') || '(reconcile)'}`,
        {
          projectId: id,
          meta: {
            attemptId,                                       // may be undefined for non-change-control calls
            source: body.auditContext.source,
            advisories: body.auditContext.advisories ?? [],
            severity: body.auditContext.severity,
            packages: successfulNames,
            installGate: activeGatePlugin
              ? { plugin: activeGatePlugin, binOverride: installBinOverride }
              : undefined,
          },
        });
    } else if (!anySucceeded && body.auditContext?.source) {
      // Change-control: log failure so the audit trail captures intent even when install fails
      logger.info('security', 'remediation_install_failed',
        `Apply attempt ${attemptId ?? '(no-id)'} failed for ${id}`,
        {
          projectId: id,
          meta: {
            attemptId,
            source: body.auditContext.source,
            advisories: body.auditContext.advisories ?? [],
            severity: body.auditContext.severity,
            attemptedPackages: body.packages?.map(p => p.name) ?? [],
          },
        });
    }

    const allSucceeded = results.every(r => r.success);
    const output = results.map(r => r.output).join('\n\n');

    return { body: {
      success: allSucceeded,
      packageManager,
      results,
      output: output || 'Packages updated successfully.',
      ...(auditSummary !== undefined && { auditSummary }),
    } };
    };

    const outcome = await runWithDevServerGuard(project, runApply, { clearBuildDir: true });
    if (outcome.blocked) {
      return NextResponse.json(
        { success: false, error: outcome.reason, devServerGuard: { action: outcome.decision, reason: outcome.reason } },
        { status: 409 },
      );
    }
    const devServerGuard = {
      action: outcome.decision,
      stopped: outcome.stopped,
      restarted: outcome.restarted,
      ...(outcome.restartError ? { restartError: outcome.restartError } : {}),
    };
    const applied = outcome.result!;
    return NextResponse.json(
      { ...applied.body, devServerGuard },
      applied.status ? { status: applied.status } : undefined,
    );
  } catch (error) {
    console.error('Error updating packages:', error);
    const execError = error as { stdout?: string; stderr?: string; message?: string };
    return NextResponse.json({
      success: false,
      error: 'Update command failed',
      output: execError.stdout || execError.stderr || execError.message || 'Unknown error',
    });
  }
}
