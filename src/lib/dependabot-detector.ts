import { exec } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export interface DetectorResult {
  managed: boolean;
  owner: string | null;
  repo: string | null;
}

/**
 * Returns true if .github/dependabot.yml exists in the project root.
 */
export function hasDependabotConfig(projectPath: string): boolean {
  return existsSync(path.join(projectPath, '.github', 'dependabot.yml'));
}

/**
 * Parses GitHub owner and repo from the git remote URL.
 * Handles both SSH (git@github.com:owner/repo.git) and HTTPS formats.
 * Returns null for both if the remote is not a GitHub URL.
 */
export async function parseGitHubRemote(
  projectPath: string
): Promise<{ owner: string | null; repo: string | null }> {
  try {
    const { stdout } = await execAsync('git remote get-url origin', {
      cwd: projectPath,
      timeout: 5000,
    });
    const url = stdout.trim();

    // SSH format: git@github.com:owner/repo.git
    const sshMatch = url.match(/git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
    if (sshMatch) {
      return { owner: sshMatch[1], repo: sshMatch[2] };
    }

    // HTTPS format: https://github.com/owner/repo.git
    const httpsMatch = url.match(/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
    if (httpsMatch) {
      return { owner: httpsMatch[1], repo: httpsMatch[2] };
    }

    return { owner: null, repo: null };
  } catch {
    return { owner: null, repo: null };
  }
}

/**
 * Full detection: checks for dependabot.yml and parses the git remote.
 * Returns managed=false immediately if dependabot.yml is absent.
 */
export async function detectDependabot(projectPath: string): Promise<DetectorResult> {
  if (!hasDependabotConfig(projectPath)) {
    return { managed: false, owner: null, repo: null };
  }

  const { owner, repo } = await parseGitHubRemote(projectPath);
  return { managed: true, owner, repo };
}
