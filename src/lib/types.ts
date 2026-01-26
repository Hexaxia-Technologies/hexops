export interface ProjectConfig {
  id: string;
  name: string;
  path: string;
  port: number;
  category: string;
  description?: string;
  scripts: {
    dev: string;
    build: string;
    [key: string]: string;
  };
  holds?: string[];  // Package names on hold (excluded from updates)
}

export interface ProjectExtendedStatus {
  git?: {
    branch: string;
    dirty: boolean;
  };
  packages?: {
    outdatedCount: number;
    heldCount?: number;  // How many of the outdated packages are on hold
    vulnerabilityCount?: number;
    criticalVulnerabilityCount?: number;
  };
  metrics?: {
    uptime: number; // milliseconds
    memory: number; // MB
    pid: number;
  };
}

export interface Project extends ProjectConfig {
  status: 'running' | 'stopped' | 'unknown';
  extended?: ProjectExtendedStatus;
}

export interface HexOpsConfig {
  projectsRoot?: string;
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

// Patch Management Types

export type UpdateType = 'patch' | 'minor' | 'major';
export type VulnSeverity = 'critical' | 'high' | 'moderate' | 'low' | 'info';
export type PatchTrigger = 'manual' | 'auto';

export interface PatchQueueItem {
  priority: number;
  type: 'vulnerability' | 'outdated';
  severity: VulnSeverity | 'major' | 'minor' | 'patch';
  package: string;
  currentVersion: string;
  targetVersion: string;
  updateType: UpdateType;
  projectId: string;      // Single project (1:1 relationship)
  projectName: string;    // For display
  title?: string;         // For vulnerabilities
  fixAvailable?: boolean;
  isHeld?: boolean;       // Package is on hold for this project
  // Transitive dependency info (for unfixable vulnerabilities)
  isDirect?: boolean;
  via?: string[];
  parentPackage?: string;
  parentAtLatest?: boolean;
}

export interface PatchSummary {
  critical: number;
  high: number;
  moderate: number;
  outdatedMajor: number;
  outdatedMinor: number;
  outdatedPatch: number;
}

export interface ProjectPatchState {
  outdatedCount: number;
  vulnCount: number;
  criticalCount: number;
  lastChecked: string; // ISO date
}

export interface PatchState {
  lastFullScan: string | null;
  projects: Record<string, ProjectPatchState>;
}

export interface PatchHistoryEntry {
  id: string;
  timestamp: string;
  projectId: string;
  package: string;
  fromVersion: string;
  toVersion: string;
  updateType: UpdateType;
  trigger: PatchTrigger;
  success: boolean;
  output: string;
  error?: string;
}

export interface PatchHistory {
  updates: PatchHistoryEntry[];
}

export interface OutdatedPackage {
  name: string;
  current: string;
  wanted: string;
  latest: string;
  type: 'dependencies' | 'devDependencies';
}

export interface VulnerabilityInfo {
  name: string;
  severity: VulnSeverity;
  title: string;
  path: string;
  fixAvailable: boolean;
  fixVersion?: string;
  // Transitive dependency info
  isDirect: boolean;            // Is this a direct dependency?
  via?: string[];               // Dependency chain (e.g., ["@vercel/blob", "undici"])
  parentPackage?: string;       // Direct parent package that needs updating
  parentAtLatest?: boolean;     // Is the parent already at latest version?
}

export interface ProjectPatchCache {
  projectId: string;
  timestamp: string;
  expiresAt: string;
  outdated: OutdatedPackage[];
  vulnerabilities: VulnerabilityInfo[];
}
