import { NextRequest, NextResponse } from 'next/server';
import { getProject, loadConfig } from '@/lib/config';
import { propagateBranch, DEFAULT_PROPAGATION_CONFIG } from '@/lib/branch-propagator';
import { parseGitHubRemote } from '@/lib/dependabot-detector';
import type { BranchSyncStatus, PropagationConfig } from '@/lib/types';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = getProject(id);

  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.branches) || body.branches.length === 0) {
    return NextResponse.json({ error: 'branches array required' }, { status: 400 });
  }

  const branches = body.branches as string[];
  const openPROverride: boolean | undefined =
    typeof body.openPR === 'boolean' ? body.openPR : undefined;

  const globalConfig = loadConfig();
  const token = globalConfig.settings?.integrations?.github?.token ?? null;

  const propagationConfig: PropagationConfig = {
    ...DEFAULT_PROPAGATION_CONFIG,
    ...project.propagation,
    ...(openPROverride !== undefined ? { openPR: openPROverride } : {}),
  };

  // Resolve owner/repo
  let owner = project.github?.owner ?? null;
  let repo = project.github?.repo ?? null;
  if (!owner || !repo) {
    const remote = await parseGitHubRemote(project.path);
    owner = remote.owner;
    repo = remote.repo;
  }

  if (propagationConfig.openPR && (!owner || !repo)) {
    return NextResponse.json(
      { error: 'Could not determine GitHub owner/repo — configure project.github or ensure git remote points to GitHub' },
      { status: 422 }
    );
  }

  const results: BranchSyncStatus[] = [];
  const skipped: string[] = [];

  for (const branch of branches) {
    const result = await propagateBranch(
      project.path,
      branch,
      propagationConfig,
      owner ?? '',
      repo ?? '',
      token
    );
    if (result.status === 'synced') {
      skipped.push(branch);
    } else {
      results.push(result);
    }
  }

  return NextResponse.json({ results, skipped });
}
