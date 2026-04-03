import { NextRequest, NextResponse } from 'next/server';
import { getProject } from '@/lib/config';
import { resolveLockfile } from '@/lib/lockfile-resolver';
import { getGlobalSettings, getProjectSettings } from '@/lib/settings';
import type { LockfileResolutionMode } from '@/lib/types';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const project = getProject(id);
  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  const body = await request.json().catch(() => ({}));

  // Determine mode
  const projectSettings = getProjectSettings(id);
  const globalSettings = getGlobalSettings();
  const mode: LockfileResolutionMode =
    body.mode ??
    (projectSettings.patching?.lockfileResolution === 'global'
      ? globalSettings.patching?.defaultLockfileResolution
      : projectSettings.patching?.lockfileResolution as LockfileResolutionMode) ??
    'clean-slate';

  const result = await resolveLockfile(project.path, mode);

  return NextResponse.json({
    projectId: id,
    projectName: project.name,
    ...result,
  });
}
