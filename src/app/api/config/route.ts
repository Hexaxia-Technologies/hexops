import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/config';

export async function GET() {
  try {
    const config = loadConfig();
    return NextResponse.json({
      projectsRoot: config.projectsRoot || process.cwd(),
      categories: config.categories,
    });
  } catch (error) {
    console.error('Error loading config:', error);
    return NextResponse.json(
      { error: 'Failed to load config' },
      { status: 500 }
    );
  }
}
