import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/config';
import { getGlobalSettings } from '@/lib/settings';

export async function GET() {
  try {
    const config = loadConfig();
    const settings = getGlobalSettings();
    return NextResponse.json({
      projectsRoot: settings.paths.projectsRoot,
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
