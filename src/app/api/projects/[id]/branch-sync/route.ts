import { NextResponse } from 'next/server';
import { getProject } from '@/lib/config';
import {
  getActiveBranches,
  getBranchSyncStatuses,
  DEFAULT_PROPAGATION_CONFIG,
} from '@/lib/branch-propagator';
import type { PropagationConfig } from '@/lib/types';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = getProject(id);

  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const config: PropagationConfig = {
    ...DEFAULT_PROPAGATION_CONFIG,
    ...project.propagation,
  };

  try {
    const activeBranches = await getActiveBranches(project.path, config.activeBranchDays);

    if (activeBranches.length === 0) {
      return NextResponse.json({ branches: [], config });
    }

    const branches = await getBranchSyncStatuses(project.path, activeBranches);
    return NextResponse.json({ branches, config });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Branch sync check failed' },
      { status: 500 }
    );
  }
}
