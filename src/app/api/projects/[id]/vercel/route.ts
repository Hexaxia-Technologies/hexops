import { NextRequest, NextResponse } from 'next/server';
import { getProject } from '@/lib/config';
import { readFile, access } from 'fs/promises';
import { join } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface VercelProject {
  projectId: string;
  orgId: string;
}

interface VercelDeployment {
  url: string;
  state: string;
  created: string;
  target?: string;
}

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

    // Check if this is a Vercel project
    const vercelDir = join(cwd, '.vercel');
    const vercelJson = join(cwd, 'vercel.json');
    const projectJson = join(vercelDir, 'project.json');

    let isVercelProject = false;
    let vercelProjectInfo: VercelProject | null = null;

    // Check for .vercel/project.json (linked project)
    try {
      await access(projectJson);
      const content = await readFile(projectJson, 'utf-8');
      vercelProjectInfo = JSON.parse(content);
      isVercelProject = true;
    } catch {
      // Not linked yet, check for vercel.json
      try {
        await access(vercelJson);
        isVercelProject = true;
      } catch {
        // No Vercel config found
      }
    }

    if (!isVercelProject) {
      return NextResponse.json({
        isVercelProject: false,
        isLinked: false,
        projectInfo: null,
        latestDeployment: null,
      });
    }

    // Try to get latest deployment info using vercel CLI
    let latestDeployment: VercelDeployment | null = null;
    try {
      const { stdout } = await execAsync('vercel ls --json 2>/dev/null | head -1', {
        cwd,
        timeout: 10000,
      });

      if (stdout.trim()) {
        // Strip any warnings before JSON
        const jsonStart = stdout.search(/[\[{]/);
        const jsonOutput = jsonStart >= 0 ? stdout.slice(jsonStart) : '[]';
        const deployments = JSON.parse(jsonOutput);
        if (Array.isArray(deployments) && deployments.length > 0) {
          const latest = deployments[0];
          latestDeployment = {
            url: latest.url || latest.alias?.[0],
            state: latest.state || latest.readyState,
            created: latest.created || latest.createdAt,
            target: latest.target,
          };
        }
      }
    } catch {
      // Vercel CLI not available or not authenticated
    }

    return NextResponse.json({
      isVercelProject: true,
      isLinked: vercelProjectInfo !== null,
      projectInfo: vercelProjectInfo,
      latestDeployment,
    });
  } catch (error) {
    console.error('Error checking Vercel status:', error);
    return NextResponse.json(
      { error: 'Failed to check Vercel status' },
      { status: 500 }
    );
  }
}

// Deploy to Vercel
export async function POST(
  request: NextRequest,
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

    const body = await request.json().catch(() => ({}));
    const isProd = body.production === true;

    const cwd = project.path;

    // Run vercel deploy
    const command = isProd ? 'vercel --prod --yes' : 'vercel --yes';

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        timeout: 300000, // 5 minute timeout for deploys
      });

      // Extract deployment URL from output
      const urlMatch = (stdout + stderr).match(/https:\/\/[^\s]+\.vercel\.app/);
      const deploymentUrl = urlMatch ? urlMatch[0] : null;

      return NextResponse.json({
        success: true,
        output: stdout || stderr,
        deploymentUrl,
        production: isProd,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Deploy failed';
      return NextResponse.json(
        { error: message, success: false },
        { status: 500 }
      );
    }
  } catch (error) {
    console.error('Error deploying to Vercel:', error);
    return NextResponse.json(
      { error: 'Failed to deploy' },
      { status: 500 }
    );
  }
}
