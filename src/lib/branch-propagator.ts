import { execFile } from 'child_process';
import { promisify } from 'util';
import { detectPackageManager } from './patch-scanner';
import { openPropagationPR } from './github-client';
import type { BranchSyncStatus, PropagationConfig } from './types';

const execFileAsync = promisify(execFile);

export const DEFAULT_PROPAGATION_CONFIG: PropagationConfig = {
  activeBranchDays: 30,
  openPR: true,
  autoPush: false,
};

const LOCK_FILES: Record<string, string> = {
  pnpm: 'pnpm-lock.yaml',
  npm: 'package-lock.json',
  yarn: 'yarn.lock',
};

const INSTALL_CMD: Record<string, string[]> = {
  pnpm: ['pnpm', 'install', '--no-frozen-lockfile'],
  npm: ['npm', 'install', '--legacy-peer-deps'],
  yarn: ['yarn', 'install'],
};

/**
 * Lists active remote branches (excluding main/master/HEAD) with a commit
 * within the last `days` days. Runs `git fetch` first to ensure current data.
 */
export async function getActiveBranches(
  projectPath: string,
  days: number
): Promise<string[]> {
  await execFileAsync('git', ['fetch', 'origin', '--prune'], {
    cwd: projectPath,
    timeout: 30000,
  });

  const { stdout } = await execFileAsync(
    'git',
    [
      'for-each-ref',
      '--sort=-committerdate',
      '--format=%(refname:short) %(committerdate:iso-strict)',
      'refs/remotes/origin/',
    ],
    { cwd: projectPath, timeout: 10000 }
  );

  const SKIP = new Set(['origin/main', 'origin/master', 'origin/HEAD']);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const branches: string[] = [];

  for (const line of stdout.trim().split('\n')) {
    if (!line.trim()) continue;
    const spaceIdx = line.indexOf(' ');
    const refname = line.slice(0, spaceIdx);
    const date = line.slice(spaceIdx + 1).trim();
    if (SKIP.has(refname)) continue;
    if (date >= cutoff) {
      branches.push(refname.replace('origin/', ''));
    }
  }

  return branches;
}

interface DepSnapshot {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  overrides: Record<string, string>;
  pnpmOverrides: Record<string, string>;
  resolutions: Record<string, string>;
}

function extractDeps(pkg: Record<string, unknown>): DepSnapshot {
  const pnpm = (pkg.pnpm ?? {}) as Record<string, unknown>;
  return {
    dependencies: (pkg.dependencies ?? {}) as Record<string, string>,
    devDependencies: (pkg.devDependencies ?? {}) as Record<string, string>,
    overrides: (pkg.overrides ?? {}) as Record<string, string>,
    pnpmOverrides: (pnpm.overrides ?? {}) as Record<string, string>,
    resolutions: (pkg.resolutions ?? {}) as Record<string, string>,
  };
}

function depsEqual(a: DepSnapshot, b: DepSnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Compares package.json dep sections on each branch against origin/main.
 * Runs comparisons in parallel. Branches that can't be read are treated as synced.
 */
export async function getBranchSyncStatuses(
  projectPath: string,
  branches: string[]
): Promise<BranchSyncStatus[]> {
  const { stdout: mainPkgRaw } = await execFileAsync(
    'git',
    ['show', 'origin/main:package.json'],
    { cwd: projectPath, timeout: 10000 }
  );
  const mainDeps = extractDeps(JSON.parse(mainPkgRaw) as Record<string, unknown>);

  return Promise.all(
    branches.map(async (branch): Promise<BranchSyncStatus> => {
      try {
        const { stdout: branchPkgRaw } = await execFileAsync(
          'git',
          ['show', `origin/${branch}:package.json`],
          { cwd: projectPath, timeout: 10000 }
        );
        const branchDeps = extractDeps(JSON.parse(branchPkgRaw) as Record<string, unknown>);
        return {
          branch,
          status: depsEqual(mainDeps, branchDeps) ? 'synced' : 'out_of_sync',
        };
      } catch {
        return { branch, status: 'synced' };
      }
    })
  );
}

/**
 * Syncs package.json from origin/main onto `branch`, regenerates the lockfile,
 * then either opens a GitHub PR or pushes directly per `config`.
 *
 * Uses a git worktree so the project's working tree is not disturbed.
 * Always removes the worktree in a finally block.
 */
export async function propagateBranch(
  projectPath: string,
  branch: string,
  config: PropagationConfig,
  owner: string,
  repo: string,
  token: string | null
): Promise<BranchSyncStatus> {
  const safeBranch = branch.replace(/[^a-zA-Z0-9-_]/g, '-');
  const worktreePath = `/tmp/hexops-prop-${safeBranch}-${Date.now()}`;

  try {
    // Create worktree on target branch
    await execFileAsync(
      'git',
      ['worktree', 'add', worktreePath, `origin/${branch}`],
      { cwd: projectPath, timeout: 15000 }
    );

    // Apply package.json from main
    try {
      await execFileAsync(
        'git',
        ['checkout', 'origin/main', '--', 'package.json'],
        { cwd: worktreePath, timeout: 10000 }
      );
    } catch (err) {
      return {
        branch,
        status: 'conflict',
        error: `Failed to apply package.json from main: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Check if anything actually changed
    const { stdout: diffOut } = await execFileAsync(
      'git',
      ['diff', '--name-only'],
      { cwd: worktreePath }
    );
    if (!diffOut.trim()) {
      return { branch, status: 'synced' };
    }

    // Regenerate lockfile
    const pm = detectPackageManager(worktreePath);
    const [cmd, ...args] = INSTALL_CMD[pm];
    try {
      await execFileAsync(cmd, args, { cwd: worktreePath, timeout: 120000 });
    } catch (err) {
      // Revert package.json on lockfile failure
      await execFileAsync('git', ['checkout', '--', 'package.json'], { cwd: worktreePath }).catch(() => {});
      return {
        branch,
        status: 'conflict',
        error: `Lockfile regen failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const lockFile = LOCK_FILES[pm];

    if (config.openPR) {
      if (!token) {
        return { branch, status: 'conflict', error: 'GitHub token required for PR mode' };
      }
      const syncBranch = `hexops/sync-${safeBranch}-${Date.now()}`;
      await execFileAsync('git', ['checkout', '-b', syncBranch], { cwd: worktreePath, timeout: 5000 });
      await execFileAsync('git', ['add', 'package.json', lockFile], { cwd: worktreePath });
      await execFileAsync(
        'git',
        ['commit', '-m', `chore: sync package.json from main → ${branch}`],
        { cwd: worktreePath, timeout: 10000 }
      );
      await execFileAsync('git', ['push', 'origin', syncBranch], { cwd: worktreePath, timeout: 30000 });
      try {
        const prUrl = await openPropagationPR(owner, repo, syncBranch, branch, token);
        return { branch, status: 'propagated', prUrl };
      } catch (err) {
        return {
          branch,
          status: 'conflict',
          error: `Branch pushed but PR creation failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    } else {
      await execFileAsync('git', ['add', 'package.json', lockFile], { cwd: worktreePath });
      await execFileAsync(
        'git',
        ['commit', '-m', `chore: sync package.json from main → ${branch}`],
        { cwd: worktreePath, timeout: 10000 }
      );
      await execFileAsync(
        'git',
        ['push', 'origin', `HEAD:${branch}`],
        { cwd: worktreePath, timeout: 30000 }
      );
      return { branch, status: 'propagated' };
    }
  } finally {
    await execFileAsync(
      'git',
      ['worktree', 'remove', '--force', worktreePath],
      { cwd: projectPath, timeout: 10000 }
    ).catch(() => {});
  }
}
