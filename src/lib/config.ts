import { readFileSync } from 'fs';
import { join } from 'path';
import type { HexOpsConfig, ProjectConfig } from './types';

const CONFIG_PATH = join(process.cwd(), 'hexops.config.json');

let cachedConfig: HexOpsConfig | null = null;

export function loadConfig(): HexOpsConfig {
  // In development, always reload config to pick up changes
  const isDev = process.env.NODE_ENV === 'development';

  if (cachedConfig && !isDev) {
    return cachedConfig;
  }

  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    cachedConfig = JSON.parse(raw) as HexOpsConfig;
    return cachedConfig;
  } catch (error) {
    console.error('Failed to load hexops.config.json:', error);
    return {
      projects: [],
      categories: [],
    };
  }
}

export function getProject(id: string): ProjectConfig | undefined {
  const config = loadConfig();
  return config.projects.find((p) => p.id === id);
}

export function getProjects(): ProjectConfig[] {
  return loadConfig().projects;
}

export function getCategories(): string[] {
  return loadConfig().categories;
}

export function reloadConfig(): HexOpsConfig {
  cachedConfig = null;
  return loadConfig();
}
