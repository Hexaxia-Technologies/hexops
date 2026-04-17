import type { DependabotPR } from './types';

const GITHUB_API = 'https://api.github.com';

/**
 * Fetches open PRs authored by dependabot[bot] for a given repo.
 * Returns an empty array (not an error) if token is missing.
 * Throws on non-401/403/404 HTTP errors.
 */
export async function fetchDependabotPRs(
  owner: string,
  repo: string,
  token: string | null
): Promise<DependabotPR[]> {
  if (!token) return [];

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    Authorization: `Bearer ${token}`,
  };

  const url = `${GITHUB_API}/repos/${owner}/${repo}/pulls?state=open&per_page=100`;
  const response = await fetch(url, { headers });

  if (response.status === 401 || response.status === 403) {
    throw new Error(`GitHub API auth failed (${response.status}) — check token`);
  }
  if (response.status === 404) {
    throw new Error(`Repo ${owner}/${repo} not found or token lacks access`);
  }
  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status}`);
  }

  const prs = (await response.json()) as GitHubPR[];

  return prs
    .filter((pr) => pr.user.login === 'dependabot[bot]')
    .map(mapPR);
}

interface GitHubPR {
  number: number;
  title: string;
  html_url: string;
  state: string;
  mergeable: boolean | null;
  draft: boolean;
  created_at: string;
  updated_at: string;
  labels: Array<{ name: string }>;
  user: { login: string };
}

function mapPR(pr: GitHubPR): DependabotPR {
  const labels = pr.labels.map((l) => l.name);
  const updateType =
    labels.find((l) => l.startsWith('version-update:')) ?? '';
  const dependencyGroup =
    labels.find((l) => l.startsWith('group:'))?.replace('group:', '') ?? null;

  return {
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    state: pr.state as DependabotPR['state'],
    mergeable: pr.mergeable,
    draft: pr.draft,
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    labels,
    updateType,
    dependencyGroup,
  };
}
