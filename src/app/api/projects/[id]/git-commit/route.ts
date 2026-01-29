import { NextRequest, NextResponse } from 'next/server';
import { getProject } from '@/lib/config';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { logger } from '@/lib/logger';

const execFileAsync = promisify(execFile);

export async function POST(
  request: NextRequest,
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

    const body = await request.json();
    const message = body.message?.trim();

    if (!message) {
      return NextResponse.json(
        { error: 'Commit message is required' },
        { status: 400 }
      );
    }

    const cwd = project.path;

    // Stage all changes (including untracked files)
    await execFileAsync('git', ['add', '-A'], { cwd });

    // Check if there are changes to commit
    try {
      const { stdout: statusOutput } = await execFileAsync(
        'git',
        ['status', '--porcelain'],
        { cwd }
      );

      if (!statusOutput.trim()) {
        return NextResponse.json({
          success: false,
          error: 'No changes to commit',
        });
      }
    } catch {
      // Continue with commit attempt
    }

    // Execute git commit
    const { stdout, stderr } = await execFileAsync(
      'git',
      ['commit', '-m', message],
      { cwd, timeout: 30000 }
    );

    // Log success
    logger.info('git', 'commit_created', `Committed changes: ${message.split('\n')[0]}`, {
      projectId: id,
      meta: { message: message.split('\n')[0] },
    });

    return NextResponse.json({
      success: true,
      output: stdout || stderr || 'Commit successful',
    });
  } catch (error) {
    console.error('Git commit failed:', error);
    const errorMessage = error instanceof Error ? error.message : 'Git commit failed';

    // Log failure
    logger.error('git', 'commit_failed', `Commit failed: ${errorMessage}`, {
      projectId: id,
      meta: { error: errorMessage },
    });

    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
  }
}
