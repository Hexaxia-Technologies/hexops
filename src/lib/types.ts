// Escalation Types

export type EscalateAction = 'force_override' | 'force_major' | 'accepted_risk';

export interface EscalationConfig {
  acceptedRiskMaxDays: number;   // default 90
  autoCommit: boolean;           // force_override: commit after patching
  autoPush: boolean;             // force_override: push after committing
}

export interface EscalateRecord {
  id: string;                    // uuid (crypto.randomUUID())
  projectId: string;
  package: string;
  action: EscalateAction;
  reason: string;
  createdAt: string;             // ISO 8601
  expiresAt?: string;            // accepted_risk only
  resolvedAt?: string;           // set by scanner when upstream patch becomes available
  overrideVersion?: string;      // force_override: version pinned to
  targetVersion?: string;        // force_major: target version
}

export interface EscalationStore {
  records: EscalateRecord[];
}

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
  escalation?: Partial<EscalationConfig>;
  settings?: Partial<ProjectSettings>;  // Per-project settings overrides
  github?: {
    owner: string;
    repo: string;
  };
  propagation?: Partial<PropagationConfig>;
  autostart?: boolean;
  /**
   * Per-project SecurityPlugin settings. Optional; absence == default opt-out.
   * Keyed by plugin id (e.g. 'safe-chain').
   */
  plugins?: Record<string, ProjectPluginConfig>;
}

export interface ProjectPluginConfig {
  enabled?: boolean;
  // Plugins MAY extend this shape via declaration merging in their own
  // module if they need plugin-specific config. Keep the base intentionally
  // minimal — most plugins should ship with sensible defaults.
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

// Settings Types

export interface GlobalSettings {
  paths: {
    projectsRoot: string;
    logsDir: string;
    cacheDir: string;
  };
  integrations: {
    vercel: {
      token: string | null;
      teamId: string | null;
    };
    git: {
      defaultBranch: string;
      commitPrefix: string;
      pushAfterCommit: boolean;
    };
    github: {
      token: string | null;
    };
  };
  patching: {
    defaultLockfileResolution: LockfileResolutionMode;
    scanInterval: '1h' | '6h' | '24h' | 'manual';
  };
  notifications: {
    enabled: boolean;
    webhookUrl: string | null;
    webhookOnCritical: boolean;
    webhookOnCrash: boolean;
  };
  scheduler: {
    tasks: SchedulerTask[];
  };
}

export type SchedulerAction = 'patch-scan' | 'health-check';

export interface SchedulerTask {
  id: string;
  name: string;
  action: SchedulerAction;
  interval: '15m' | '1h' | '6h' | '24h';
  enabled: boolean;
  lastRun?: string;
  lastStatus?: 'success' | 'failure';
  lastOutput?: string;
  nextRun?: string;
}

export interface Notification {
  id: string;
  timestamp: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  category: 'security' | 'system' | 'application' | 'git' | 'scheduler';
  title: string;
  message: string;
  projectId?: string;
  read: boolean;
  actionUrl?: string;
  meta?: Record<string, unknown>;
}

export interface ProjectSettings {
  env: Record<string, string>;
  nodeVersion: string | null;
  shell: 'bash' | 'zsh' | 'system' | null;
  git: {
    autoPull: boolean;
    commitTemplate: string | null;
    branch: string | null;
  };
  deploy: {
    vercelProjectId: string | null;
    autoDeployBranch: string | null;
    environment: 'preview' | 'production';
  };
  monitoring: {
    healthCheckUrl: string | null;
    restartOnCrash: boolean;
    logRetentionDays: number;
  };
  patching: {
    lockfileResolution: LockfileResolutionMode | 'global';
  };
}

export interface HexOpsConfig {
  settings?: GlobalSettings;
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

// Lock File Resolution Types

export type LockfileResolutionMode = 'clean-slate' | 'repair' | 'preflight';
export type PackageManager = 'npm' | 'pnpm' | 'yarn';

export interface LockfileResolutionResult {
  mode: LockfileResolutionMode;
  success: boolean;
  packageManager: PackageManager;
  detectedVia: 'lockfile' | 'packageJson' | 'workspaceConfig' | 'npmrc' | 'fallback';
  actions: string[];
  error?: string;
}

// Dependabot Types

export interface DependabotPR {
  number: number;
  title: string;
  url: string;
  state: 'open' | 'closed' | 'merged';
  mergeable: boolean | null;
  draft: boolean;
  createdAt: string;
  updatedAt: string;
  labels: string[];
  updateType: 'version-update:semver-patch' | 'version-update:semver-minor' | 'version-update:semver-major' | string;
  dependencyGroup: string | null;
}

export interface DependabotConfig {
  managed: boolean;
  owner: string | null;
  repo: string | null;
  prs: DependabotPR[];
  fetchedAt: string | null;
  error: string | null;
}

export interface BranchSyncStatus {
  branch: string;
  status: 'synced' | 'out_of_sync' | 'conflict' | 'propagated';
  prUrl?: string;
  error?: string;
}

export interface PropagationConfig {
  activeBranchDays: number;
  openPR: boolean;
  autoPush: boolean;
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
  fixViaOverride?: boolean;     // Fix via package manager override (fallback for transitive deps)
  fixByParent?: { name: string; version: string };  // Fix by updating this direct dep to this version
  isBreakingFix?: boolean;      // Fix requires a semver-major update
  // CVE/Advisory info (for vulnerabilities)
  cves?: string[];
  url?: string;
  advisoryId?: number;
  // Escalation state (set by scanner when an EscalateRecord exists for this package)
  escalationId?: string;
  escalationStatus?: 'accepted_risk' | 'accepted_risk_expired' | 'force_override_pending' | 'force_major_pending';
  escalationReason?: string;
  escalationExpiresAt?: string;
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
  /** The version that was targeted/requested — kept as-is; do not repurpose this to mean "what got installed". */
  toVersion: string;
  /**
   * The version actually found installed on disk after the patch, when it
   * could be determined (see UpdateResult.resolvedVersion for the full
   * rationale). Undefined, not defaulted to toVersion, when verification
   * was inconclusive. With a `>=` floor override this can legitimately
   * differ from toVersion — that's success, not a discrepancy to paper
   * over by conflating the two fields.
   */
  resolvedVersion?: string;
  updateType: UpdateType;
  trigger: PatchTrigger;
  success: boolean;
  output: string;
  error?: string;
  lockfileResolution?: {
    mode: LockfileResolutionMode;
    detectedVia: string;
    actions: string[];
  };
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
  dependabotManaged?: boolean;
}

export interface VulnerabilityInfo {
  name: string;
  severity: VulnSeverity;
  title: string;
  path: string;
  fixAvailable: boolean;
  fixVersion?: string;
  currentVersion?: string;      // Currently installed version
  // Transitive dependency info
  isDirect: boolean;            // Is this a direct dependency?
  via?: string[];               // Dependency chain (e.g., ["@vercel/blob", "undici"])
  parentPackage?: string;       // Direct parent package that needs updating
  parentAtLatest?: boolean;     // Is the parent already at latest version?
  fixViaOverride?: boolean;     // Fix via package manager override (fallback for transitive deps)
  fixByParent?: { name: string; version: string };  // Fix by updating this direct dep to this version
  isBreakingFix?: boolean;      // Fix requires a semver-major update
  // CVE/Advisory info
  cves?: string[];              // CVE identifiers (e.g., ["CVE-2024-12345"])
  url?: string;                 // Link to advisory (GitHub/npm)
  advisoryId?: number;          // npm advisory ID
  dependabotManaged?: boolean;
}

export interface ActiveOverride {
  package: string;
  version: string;
  packageManager: 'npm' | 'pnpm' | 'yarn';
  overrideKey: 'overrides' | 'pnpm.overrides' | 'resolutions';
  stale: boolean;  // true = no current vulnerability for this package (override may no longer be needed)
}

export interface ProjectPatchCache {
  projectId: string;
  timestamp: string;
  expiresAt: string;
  outdated: OutdatedPackage[];
  vulnerabilities: VulnerabilityInfo[];
  activeOverrides?: ActiveOverride[];
  /** sha1 of package.json + lockfile(s); invalidates the cache on out-of-band dep changes */
  depsFingerprint?: string;
  schemaVersion?: number;
}
