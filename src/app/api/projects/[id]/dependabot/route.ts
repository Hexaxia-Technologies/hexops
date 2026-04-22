import { NextResponse } from 'next/server';
import { getProject, loadConfig } from '@/lib/config';
import { detectDependabot } from '@/lib/dependabot-detector';
import { fetchDependabotPRs } from '@/lib/github-client';
import type { DependabotConfig, DependabotPR } from '@/lib/types';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = getProject(id);

  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const detection = await detectDependabot(project.path);

  if (!detection.managed) {
    const result: DependabotConfig = {
      managed: false,
      owner: null,
      repo: null,
      prs: [],
      fetchedAt: null,
      error: null,
    };
    return NextResponse.json(result);
  }

  const config = loadConfig();
  const token = config.settings?.integrations?.github?.token ?? null;

  const owner = project.github?.owner ?? detection.owner;
  const repo = project.github?.repo ?? detection.repo;

  let prs: DependabotPR[] = [];
  let error: string | null = null;

  if (owner && repo) {
    try {
      prs = await fetchDependabotPRs(owner, repo, token);
    } catch (err) {
      error = err instanceof Error ? err.message : 'Unknown error fetching PRs';
    }
  } else {
    error = 'Could not determine GitHub owner/repo from git remote';
  }

  const result: DependabotConfig = {
    managed: true,
    owner,
    repo,
    prs,
    fetchedAt: new Date().toISOString(),
    error,
  };

  return NextResponse.json(result);
}
