/**
 * Generate commit messages for patch updates
 */

export interface UpdatedPackage {
  name: string;
  fromVersion: string;
  toVersion: string;
  isSecurityFix?: boolean;
  vulnCount?: number;  // Number of vulnerabilities fixed
}

export interface CommitMessageResult {
  title: string;
  body: string;
  full: string;  // title + body combined
}

/**
 * Generate a commit message for a batch of package updates
 */
export function generatePatchCommitMessage(
  packages: UpdatedPackage[]
): CommitMessageResult {
  if (packages.length === 0) {
    return { title: '', body: '', full: '' };
  }

  // Separate security fixes from regular updates
  const securityFixes = packages.filter(p => p.isSecurityFix);
  const regularUpdates = packages.filter(p => !p.isSecurityFix);

  // Build title
  const securitySuffix = securityFixes.length > 0
    ? ` (${securityFixes.length} security fix${securityFixes.length !== 1 ? 'es' : ''})`
    : '';
  const title = `chore(deps): update ${packages.length} package${packages.length !== 1 ? 's' : ''}${securitySuffix}`;

  // Build body sections
  const bodyParts: string[] = [];

  // Security section (listed first for visibility)
  if (securityFixes.length > 0) {
    bodyParts.push('Security:');
    for (const pkg of securityFixes) {
      const vulnInfo = pkg.vulnCount && pkg.vulnCount > 0
        ? ` (fixes ${pkg.vulnCount} vulnerabilit${pkg.vulnCount !== 1 ? 'ies' : 'y'})`
        : '';
      bodyParts.push(`- ${pkg.name} ${pkg.fromVersion} → ${pkg.toVersion}${vulnInfo}`);
    }
  }

  // Regular dependencies section
  if (regularUpdates.length > 0) {
    if (bodyParts.length > 0) bodyParts.push('');  // Empty line between sections
    bodyParts.push('Dependencies:');
    for (const pkg of regularUpdates) {
      bodyParts.push(`- ${pkg.name} ${pkg.fromVersion} → ${pkg.toVersion}`);
    }
  }

  const body = bodyParts.join('\n');
  const full = body ? `${title}\n\n${body}` : title;

  return { title, body, full };
}

/**
 * Generate a short summary for UI display
 */
export function generatePatchSummary(packages: UpdatedPackage[]): string {
  if (packages.length === 0) return '';

  const securityCount = packages.filter(p => p.isSecurityFix).length;

  if (securityCount > 0) {
    return `Updated ${packages.length} packages (${securityCount} security fix${securityCount !== 1 ? 'es' : ''})`;
  }

  return `Updated ${packages.length} package${packages.length !== 1 ? 's' : ''}`;
}
