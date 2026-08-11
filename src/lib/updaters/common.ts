import { exec } from 'child_process';
import { promisify } from 'util';

export const execAsync = promisify(exec);

export const NPM_INSTALL_TIMEOUT = 120000; // 2 minutes per package

export interface UpdatePackage {
  name: string;
  fromVersion?: string;
  targetVersion: string;
  fixViaOverride?: boolean;
  fixByParent?: { name: string; version: string };
}

export interface UpdateResult {
  package: string;
  success: boolean;
  output: string;
  error?: string;
  /**
   * The version actually found installed on disk after an override was
   * applied, when it could be determined. Distinct from the target version
   * a caller requested: with a `>=` floor (no upper bound), the resolver is
   * free to pick anything at or above the target, so `resolvedVersion` can
   * — and often will — differ from the target that drove the override.
   * Left undefined when it couldn't be determined (verification was
   * inconclusive), not defaulted to the target — callers that care about
   * the distinction should check for undefined rather than assume this
   * always matches what was requested.
   */
  resolvedVersion?: string;
}

export async function verifyAuditClear(
  cwd: string,
  packageManager: string,
  patchedPackageNames: string[],
): Promise<string[]> {
  if (patchedPackageNames.length === 0) return [];
  try {
    const auditCmd =
      packageManager === 'pnpm'
        ? 'pnpm audit --json 2>/dev/null || true'
        : packageManager === 'yarn'
        ? 'yarn audit --json 2>/dev/null || true'
        : 'npm audit --json 2>/dev/null || true';

    const { stdout } = await execAsync(auditCmd, { cwd, timeout: 60000 });

    const jsonStart = stdout.lastIndexOf('{');
    if (jsonStart === -1) return [];
    const auditData = JSON.parse(stdout.slice(jsonStart));

    const vulnerabilities: Record<string, unknown> = auditData?.vulnerabilities ?? {};
    return patchedPackageNames.filter(name => name in vulnerabilities);
  } catch {
    return [];
  }
}
