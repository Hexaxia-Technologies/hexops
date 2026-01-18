import { NextRequest, NextResponse } from 'next/server';
import { getProject } from '@/lib/config';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const project = getProject(id);

    if (!project) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      );
    }

    const cwd = project.path;

    // Execute git pull
    const { stdout, stderr } = await execFileAsync('git', ['pull'], {
      cwd,
      timeout: 30000, // 30 second timeout
    });

    return NextResponse.json({
      success: true,
      output: stdout || stderr || 'Pull completed',
    });
  } catch (error) {
    console.error('Git pull failed:', error);
    const message = error instanceof Error ? error.message : 'Git pull failed';
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}
