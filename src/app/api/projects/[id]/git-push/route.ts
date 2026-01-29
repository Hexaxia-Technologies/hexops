import { NextRequest, NextResponse } from 'next/server';
import { getProject } from '@/lib/config';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { logger } from '@/lib/logger';

const execFileAsync = promisify(execFile);

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const project = getProject(id);

    if (!project) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      );
    }

    const cwd = project.path;

    // Execute git push
    const { stdout, stderr } = await execFileAsync('git', ['push'], {
      cwd,
      timeout: 60000, // 60 second timeout for push
    });

    // Log success
    logger.info('git', 'push_completed', 'Pushed changes to remote', {
      projectId: id,
    });

    return NextResponse.json({
      success: true,
      output: stdout || stderr || 'Push completed',
    });
  } catch (error) {
    console.error('Git push failed:', error);
    const errorMessage = error instanceof Error ? error.message : 'Git push failed';

    // Log failure
    logger.error('git', 'push_failed', `Push failed: ${errorMessage}`, {
      projectId: id,
      meta: { error: errorMessage },
    });

    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
  }
}
