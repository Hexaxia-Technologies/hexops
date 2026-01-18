export interface ProjectConfig {
  id: string;
  name: string;
  path: string;
  port: number;
  category: string;
  scripts: {
    dev: string;
    build: string;
    [key: string]: string;
  };
}

export interface Project extends ProjectConfig {
  status: 'running' | 'stopped' | 'unknown';
}

export interface HexOpsConfig {
  projects: ProjectConfig[];
  categories: string[];
}

export interface ProcessInfo {
  pid: number;
  projectId: string;
  startedAt: Date;
}

export interface CommandResult {
  success: boolean;
  output: string;
  error?: string;
}

export interface LogEntry {
  timestamp: Date;
  type: 'stdout' | 'stderr';
  message: string;
}
