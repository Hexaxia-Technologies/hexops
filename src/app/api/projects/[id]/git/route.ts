import { NextRequest, NextResponse } from 'next/server';
import { getProject } from '@/lib/config';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export async function GET(
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

    // Check if it's a git repo
    try {
      await execAsync('git rev-parse --git-dir', { cwd });
    } catch {
      return NextResponse.json(
        { error: 'Not a git repository' },
        { status: 400 }
      );
    }

    // Get current branch
    const { stdout: branch } = await execAsync('git branch --show-current', { cwd });

    // Get last commit info
    const { stdout: commitInfo } = await execAsync(
      'git log -1 --format="%H|%s|%an|%aI"',
      { cwd }
    );
    const [hash, message, author, date] = commitInfo.trim().split('|');

    // Check for uncommitted changes
    const { stdout: statusOutput } = await execAsync('git status --porcelain', { cwd });
    const statusLines = statusOutput.trim().split('\n').filter(Boolean);

    const uncommittedCount = statusLines.filter(line =>
      line.startsWith(' M') || line.startsWith('M ') || line.startsWith('MM') ||
      line.startsWith(' D') || line.startsWith('D ') || line.startsWith('A ')
    ).length;

    const untrackedCount = statusLines.filter(line => line.startsWith('??')).length;
    const isDirty = statusLines.length > 0;

    return NextResponse.json({
      branch: branch.trim(),
      lastCommit: {
        hash: hash.substring(0, 7),
        message,
        author,
        date,
      },
      isDirty,
      uncommittedCount,
      untrackedCount,
    });
  } catch (error) {
    console.error('Error fetching git info:', error);
    return NextResponse.json(
      { error: 'Failed to fetch git info' },
      { status: 500 }
    );
  }
}
