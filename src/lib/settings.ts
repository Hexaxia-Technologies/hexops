import { loadConfig, saveConfig } from './config';
import type { GlobalSettings, ProjectSettings } from './types';

// Default global settings
const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
  paths: {
    projectsRoot: process.cwd(),
    logsDir: '.hexops/logs',
    cacheDir: '.hexops/cache',
  },
  integrations: {
    vercel: {
      token: null,
      teamId: null,
    },
    git: {
      defaultBranch: 'main',
      commitPrefix: '',
      pushAfterCommit: false,
    },
  },
};

// Default project settings
const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  env: {},
  nodeVersion: null,
  shell: null,
  git: {
    autoPull: false,
    commitTemplate: null,
    branch: null,
  },
  deploy: {
    vercelProjectId: null,
    autoDeployBranch: null,
    environment: 'preview',
  },
  monitoring: {
    healthCheckUrl: null,
    restartOnCrash: false,
    logRetentionDays: 7,
  },
};

/**
 * Deep merge two objects, with source taking precedence
 */
function deepMerge<T extends object>(target: T, source: Partial<T>): T {
  const result = { ...target };

  for (const key in source) {
    const sourceValue = source[key];
    const targetValue = target[key];

    if (
      sourceValue !== null &&
      typeof sourceValue === 'object' &&
      !Array.isArray(sourceValue) &&
      targetValue !== null &&
      typeof targetValue === 'object' &&
      !Array.isArray(targetValue)
    ) {
      // Recursively merge objects
      (result as Record<string, unknown>)[key] = deepMerge(
        targetValue as object,
        sourceValue as object
      );
    } else if (sourceValue !== undefined) {
      // Use source value (including null)
      (result as Record<string, unknown>)[key] = sourceValue;
    }
  }

  return result;
}

/**
 * Get global settings with defaults applied
 */
export function getGlobalSettings(): GlobalSettings {
  const config = loadConfig();
  const stored = config.settings || {};

  // Merge stored settings with defaults
  return deepMerge(DEFAULT_GLOBAL_SETTINGS, stored);
}

/**
 * Update global settings (partial update supported)
 */
export function updateGlobalSettings(partial: Partial<GlobalSettings>): GlobalSettings {
  const config = loadConfig();
  const current = getGlobalSettings();

  // Merge partial updates into current settings
  const updated = deepMerge(current, partial);

  // Save to config
  config.settings = updated;
  saveConfig(config);

  return updated;
}

/**
 * Get project settings with defaults applied
 */
export function getProjectSettings(projectId: string): ProjectSettings {
  const config = loadConfig();
  const project = config.projects.find((p) => p.id === projectId);

  if (!project) {
    return DEFAULT_PROJECT_SETTINGS;
  }

  const stored = project.settings || {};

  // Merge stored settings with defaults
  return deepMerge(DEFAULT_PROJECT_SETTINGS, stored);
}

/**
 * Update project settings (partial update supported)
 */
export function updateProjectSettings(
  projectId: string,
  partial: Partial<ProjectSettings>
): ProjectSettings {
  const config = loadConfig();
  const projectIndex = config.projects.findIndex((p) => p.id === projectId);

  if (projectIndex === -1) {
    throw new Error(`Project not found: ${projectId}`);
  }

  const current = getProjectSettings(projectId);

  // Merge partial updates into current settings
  const updated = deepMerge(current, partial);

  // Save to config
  config.projects[projectIndex].settings = updated;
  saveConfig(config);

  return updated;
}

/**
 * Get the projects root path (from settings or default)
 */
export function getProjectsRoot(): string {
  const settings = getGlobalSettings();
  return settings.paths.projectsRoot || process.cwd();
}

/**
 * Get the logs directory path
 */
export function getLogsDir(): string {
  const settings = getGlobalSettings();
  return settings.paths.logsDir || '.hexops/logs';
}

/**
 * Get the cache directory path
 */
export function getCacheDir(): string {
  const settings = getGlobalSettings();
  return settings.paths.cacheDir || '.hexops/cache';
}

// Export defaults for use in UI
export { DEFAULT_GLOBAL_SETTINGS, DEFAULT_PROJECT_SETTINGS };
