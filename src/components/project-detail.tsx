'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  ArrowLeft,
  ExternalLink,
  Play,
  Square,
  RotateCcw,
  RefreshCw,
  Trash2,
  ChevronDown,
  ChevronRight,
  Terminal,
  FolderOpen,
  Code,
  Clock,
  Cpu,
  Activity,
  Wifi,
  Hash,
  GitBranch,
  GitCommit,
  ArrowDown,
  ArrowUp,
  AlertCircle,
  Triangle,
  Rocket,
  Link,
  Package,
  Check,
  X,
  Pencil,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import type { Project, ProjectConfig } from '@/lib/types';
import { AddProjectDialog } from './add-project-dialog';

// Collapsible section components
import { LogsSection } from './detail-sections/logs-section';
import { InfoSection } from './detail-sections/info-section';
import { GitSection } from './detail-sections/git-section';
import { PackageHealthSection } from './detail-sections/package-health-section';
import { PatchHistorySection } from './detail-sections/patch-history-section';

interface ProjectDetailProps {
  project: Project;
  onBack: () => void;
  onStart: (id: string) => Promise<void>;
  onStop: (id: string) => Promise<void>;
  onClearCache: (id: string) => Promise<void>;
  onDeleteLock: (id: string) => Promise<void>;
  onRefresh: () => void;
  onOpenPackageHealthPanel?: (
    projectId: string,
    projectName: string,
    subType: 'outdated' | 'audit',
    rawOutput: string
  ) => void;
  onOpenShell?: (cwd: string, label: string) => void;
  categories?: string[];
}

interface Metrics {
  status: 'running' | 'stopped';
  process: {
    pid: number | null;
    uptime: number | null;
    memoryMB: number | null;
    cpuPercent: number | null;
    command: string | null;
  };
  port: {
    isOpen: boolean;
    responseTimeMs: number | null;
  };
  startedAt: string | null;
}

interface GitInfo {
  branch: string;
  lastCommit: {
    hash: string;
    message: string;
    author: string;
    date: string;
  };
  isDirty: boolean;
  uncommittedCount: number;
  untrackedCount: number;
  aheadCount: number;
  behindCount: number;
}

interface ProjectInfo {
  name: string;
  version: string;
  description?: string;
  nodeVersion?: string;
  packageManager: string;
  scripts: Record<string, string>;
}

interface VercelInfo {
  isVercelProject: boolean;
  isLinked: boolean;
  projectInfo: {
    projectId: string;
    orgId: string;
  } | null;
  latestDeployment: {
    url: string;
    state: string;
    created: string;
    target?: string;
  } | null;
}

export function ProjectDetail({
  project,
  onBack,
  onStart,
  onStop,
  onClearCache,
  onDeleteLock,
  onRefresh,
  onOpenPackageHealthPanel,
  onOpenShell,
  categories = [],
}: ProjectDetailProps) {
  const [isToggling, setIsToggling] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [gitInfo, setGitInfo] = useState<GitInfo | null>(null);
  const [gitLoading, setGitLoading] = useState<string | null>(null);
  const [projectInfo, setProjectInfo] = useState<ProjectInfo | null>(null);
  const [vercelInfo, setVercelInfo] = useState<VercelInfo | null>(null);
  const [vercelDeploying, setVercelDeploying] = useState<string | null>(null);
  const [showStartMenu, setShowStartMenu] = useState(false);
  const [startMode, setStartMode] = useState<'dev' | 'prod' | null>(null);
  const [isUpdatingPackages, setIsUpdatingPackages] = useState(false);
  const [logsKey, setLogsKey] = useState(0); // Used to force logs section to re-render and open
  const [showCommitInput, setShowCommitInput] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  const startMenuRef = useRef<HTMLDivElement>(null);
  const commitInputRef = useRef<HTMLInputElement>(null);

  const isRunning = project.status === 'running';

  // Check if project supports production mode (has both build and start scripts)
  const hasProdMode = projectInfo?.scripts?.build && projectInfo?.scripts?.start;

  // Close start menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (startMenuRef.current && !startMenuRef.current.contains(event.target as Node)) {
        setShowStartMenu(false);
      }
    };

    if (showStartMenu) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showStartMenu]);

  // Fetch metrics
  const fetchMetrics = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${project.id}/metrics`);
      if (res.ok) {
        const data = await res.json();
        setMetrics(data);
      }
    } catch {
      // Silently fail - metrics are optional
    }
  }, [project.id]);

  // Fetch git info
  const fetchGitInfo = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${project.id}/git`);
      if (res.ok) {
        const data = await res.json();
        setGitInfo(data);
      }
    } catch {
      // Silently fail - git info is optional
    }
  }, [project.id]);

  // Fetch project info
  const fetchProjectInfo = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${project.id}/info`);
      if (res.ok) {
        const data = await res.json();
        setProjectInfo(data);
      }
    } catch {
      // Silently fail - project info is optional
    }
  }, [project.id]);

  // Fetch Vercel info
  const fetchVercelInfo = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${project.id}/vercel`);
      if (res.ok) {
        const data = await res.json();
        setVercelInfo(data);
      }
    } catch {
      // Silently fail - Vercel info is optional
    }
  }, [project.id]);

  // Poll metrics every 5 seconds when running, fetch git/project/vercel info on mount
  useEffect(() => {
    fetchMetrics();
    fetchGitInfo();
    fetchProjectInfo();
    fetchVercelInfo();
    if (isRunning) {
      const interval = setInterval(fetchMetrics, 5000);
      return () => clearInterval(interval);
    }
  }, [isRunning, fetchMetrics, fetchGitInfo, fetchProjectInfo, fetchVercelInfo]);

  const handleStart = async (mode: 'dev' | 'prod' = 'dev') => {
    setIsToggling(true);
    setStartMode(mode);
    setShowStartMenu(false);
    try {
      // Call API directly to support mode parameter
      const res = await fetch(`/api/projects/${project.id}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      const data = await res.json();

      if (!res.ok) {
        // Handle "already running" as success - just means it's up
        if (data.status === 'running' || data.error?.includes('already running')) {
          toast.success(`${project.name} is already running`);
          setLogsKey(k => k + 1);
        } else {
          toast.error(`Failed to start: ${data.error || 'Unknown error'}`);
          console.error('Start failed:', data.error);
          return;
        }
      } else {
        toast.success(`Starting ${project.name} in ${mode} mode...`);
      }

      // Poll until project is actually running (max 15 seconds)
      const maxAttempts = 15;
      for (let i = 0; i < maxAttempts; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        onRefresh();
        // Check if project is now running by fetching fresh status
        const statusRes = await fetch(`/api/projects`);
        const statusData = await statusRes.json();
        const updatedProject = statusData.projects?.find((p: Project) => p.id === project.id);
        if (updatedProject?.status === 'running') {
          // Force logs section to re-render and open
          setLogsKey(k => k + 1);
          break;
        }
      }
      onRefresh();
    } catch (err) {
      toast.error('Failed to start project');
      console.error('Start error:', err);
    } finally {
      setIsToggling(false);
      setStartMode(null);
    }
  };

  const handleStop = async () => {
    setIsToggling(true);
    try {
      await onStop(project.id);
      // Parent (page.tsx) handles toast

      // Poll until project is actually stopped (max 10 seconds)
      // Port may take time to be released after process termination
      const maxAttempts = 10;
      for (let i = 0; i < maxAttempts; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        // Check if project is now stopped by fetching fresh status
        const statusRes = await fetch(`/api/projects`);
        const statusData = await statusRes.json();
        const updatedProject = statusData.projects?.find((p: Project) => p.id === project.id);
        if (updatedProject?.status === 'stopped') {
          onRefresh();
          break;
        }
      }
      onRefresh();
    } catch (err) {
      toast.error('Failed to stop project');
      console.error('Stop error:', err);
    } finally {
      setIsToggling(false);
    }
  };

  const handleRestart = async () => {
    setIsRestarting(true);
    try {
      await onStop(project.id);

      // Poll until project is actually stopped (max 10 seconds)
      for (let i = 0; i < 10; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const statusRes = await fetch(`/api/projects`);
        const statusData = await statusRes.json();
        const updatedProject = statusData.projects?.find((p: Project) => p.id === project.id);
        if (updatedProject?.status === 'stopped') {
          break;
        }
      }

      // Now start the project
      await onStart(project.id);
      toast.success(`Restarting ${project.name}...`);

      // Poll until project is actually running (max 15 seconds)
      for (let i = 0; i < 15; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const statusRes = await fetch(`/api/projects`);
        const statusData = await statusRes.json();
        const updatedProject = statusData.projects?.find((p: Project) => p.id === project.id);
        if (updatedProject?.status === 'running') {
          setLogsKey(k => k + 1);
          break;
        }
      }
      onRefresh();
    } catch (err) {
      toast.error('Failed to restart project');
      console.error('Restart error:', err);
    } finally {
      setIsRestarting(false);
    }
  };

  const handleClearCache = async () => {
    setActionLoading('cache');
    try {
      await onClearCache(project.id);
    } finally {
      setActionLoading(null);
    }
  };

  const handleDeleteLock = async () => {
    setActionLoading('lock');
    try {
      await onDeleteLock(project.id);
    } finally {
      setActionLoading(null);
    }
  };

  const handleUpdatePackages = async () => {
    setIsUpdatingPackages(true);
    try {
      const res = await fetch(`/api/projects/${project.id}/update`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        // Refresh to get updated package info
        onRefresh();
        // Optionally show the output in the sidebar
        if (onOpenPackageHealthPanel && data.output) {
          onOpenPackageHealthPanel(project.id, project.name, 'outdated', data.output);
        }
      }
    } catch (error) {
      console.error('Failed to update packages:', error);
    } finally {
      setIsUpdatingPackages(false);
    }
  };

  const handleGitPull = async () => {
    setGitLoading('pull');
    try {
      const res = await fetch(`/api/projects/${project.id}/git-pull`, { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.success) {
        toast.success('Pull completed');
        await fetchGitInfo();
        onRefresh(); // Update dashboard git status
      } else {
        toast.error(data.error || 'Pull failed');
      }
    } catch {
      toast.error('Failed to pull');
    } finally {
      setGitLoading(null);
    }
  };

  const handleGitPush = async () => {
    setGitLoading('push');
    try {
      const res = await fetch(`/api/projects/${project.id}/git-push`, { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.success) {
        toast.success('Push completed');
        await fetchGitInfo();
        onRefresh(); // Update dashboard git status
      } else {
        toast.error(data.error || 'Push failed');
      }
    } catch {
      toast.error('Failed to push');
    } finally {
      setGitLoading(null);
    }
  };

  const handleGitCommit = async () => {
    if (!commitMessage.trim()) {
      toast.error('Please enter a commit message');
      return;
    }
    setGitLoading('commit');
    try {
      const res = await fetch(`/api/projects/${project.id}/git-commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: commitMessage.trim() }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        toast.success('Changes committed');
        setCommitMessage('');
        setShowCommitInput(false);
        await fetchGitInfo();
        onRefresh(); // Update dashboard git status
      } else {
        toast.error(data.error || 'Commit failed');
      }
    } catch {
      toast.error('Failed to commit');
    } finally {
      setGitLoading(null);
    }
  };

  const openInIDE = () => {
    // Uses code command (VS Code)
    window.open(`vscode://file${project.path}`, '_blank');
  };

  const openTerminal = () => {
    // This would need a backend endpoint to actually open terminal
    // For now, copy path to clipboard
    navigator.clipboard.writeText(`cd ${project.path}`);
  };

  const openFileManager = () => {
    // This would need a backend endpoint to open file manager
    // For now, copy path to clipboard
    navigator.clipboard.writeText(project.path);
  };

  const handleVercelDeploy = async (production: boolean) => {
    const deployType = production ? 'prod' : 'preview';
    setVercelDeploying(deployType);
    try {
      const res = await fetch(`/api/projects/${project.id}/vercel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ production }),
      });
      if (res.ok) {
        await fetchVercelInfo();
      }
    } catch {
      // Silently fail
    } finally {
      setVercelDeploying(null);
    }
  };

  // Format uptime
  const formatUptime = (seconds: number | null): string => {
    if (seconds === null) return '-';
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${mins}m`;
  };

  return (
    <div className="flex flex-col h-full">
      {/* Minimal Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 flex-shrink-0">
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 px-2 text-zinc-400 hover:text-zinc-100"
            onClick={onBack}
          >
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back
          </Button>

          <div className="h-6 w-px bg-zinc-700" />

          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-lg font-semibold text-zinc-100">{project.name}</h1>
              <Badge
                variant="outline"
                className={cn(
                  'text-xs',
                  isRunning
                    ? 'border-green-500/50 text-green-400 bg-green-500/10'
                    : 'border-zinc-600 text-zinc-500'
                )}
              >
                <span
                  className={cn(
                    'w-1.5 h-1.5 rounded-full mr-1.5',
                    isRunning ? 'bg-green-500 animate-pulse' : 'bg-zinc-600'
                  )}
                />
                {isRunning ? 'Running' : 'Stopped'}
              </Badge>
              <Badge variant="secondary" className="text-xs bg-zinc-800 text-zinc-400">
                :{project.port}
              </Badge>
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              <p className="text-xs text-zinc-500 font-mono">{project.path}</p>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 w-5 p-0 text-zinc-500 hover:text-zinc-300"
                onClick={() => setShowEditDialog(true)}
                title="Edit project"
              >
                <Pencil className="h-3 w-3" />
              </Button>
            </div>
          </div>
        </div>
      </header>

      {/* Content */}
      <div className="flex-1 overflow-auto p-6 space-y-4">
        {/* Control Panel */}
        <div className="border border-zinc-800 rounded-lg bg-zinc-900/50 p-4 space-y-4">
          {/* Project Info Row */}
          <div className="pb-4 border-b border-zinc-800">
            {/* Description */}
            {(project.description || projectInfo?.description) && (
              <p className="text-sm text-zinc-400 mb-3">
                {project.description || projectInfo?.description}
              </p>
            )}

            {/* Info badges */}
            <div className="flex flex-wrap items-center gap-3">
              {projectInfo?.version && (
                <Badge variant="secondary" className="text-xs bg-zinc-800 text-zinc-300">
                  v{projectInfo.version}
                </Badge>
              )}

              <Badge variant="secondary" className="text-xs bg-zinc-800 text-zinc-400">
                {project.category}
              </Badge>

              {projectInfo?.packageManager && (
                <Badge variant="secondary" className="text-xs bg-zinc-800 text-zinc-400">
                  {projectInfo.packageManager}
                </Badge>
              )}

              {projectInfo?.nodeVersion && (
                <Badge variant="secondary" className="text-xs bg-zinc-800 text-zinc-400">
                  Node {projectInfo.nodeVersion}
                </Badge>
              )}

              {project.extended?.packages?.outdatedCount !== undefined && project.extended.packages.outdatedCount > 0 && (
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-xs border-yellow-500/50 text-yellow-400">
                    <Package className="h-3 w-3 mr-1" />
                    {project.extended.packages.outdatedCount} outdated
                  </Badge>
                  <Button
                    size="sm"
                    variant="outline"
                    className={cn(
                      'h-6 px-2 text-xs',
                      project.extended.packages.criticalVulnerabilityCount && project.extended.packages.criticalVulnerabilityCount > 0
                        ? 'border-red-500/50 text-red-400 hover:bg-red-500/10'
                        : 'border-yellow-500/50 text-yellow-400 hover:bg-yellow-500/10'
                    )}
                    onClick={handleUpdatePackages}
                    disabled={isUpdatingPackages}
                  >
                    <ArrowUp className={cn('h-3 w-3 mr-1', isUpdatingPackages && 'animate-bounce')} />
                    {isUpdatingPackages ? 'Updating...' : 'Update'}
                  </Button>
                </div>
              )}

              <span className="text-xs text-zinc-500 font-mono">
                {project.scripts.dev}
              </span>
            </div>
          </div>

          {/* Git Status Row */}
          {gitInfo && (
            <div className="flex items-center justify-between pb-4 border-b border-zinc-800">
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <GitBranch className="h-4 w-4 text-zinc-500" />
                  <span className="text-sm font-medium text-zinc-200">{gitInfo.branch}</span>
                </div>

                {gitInfo.isDirty && (
                  <Badge variant="outline" className="text-xs border-yellow-500/50 text-yellow-400">
                    <AlertCircle className="h-3 w-3 mr-1" />
                    {gitInfo.uncommittedCount} modified
                  </Badge>
                )}

                {gitInfo.untrackedCount > 0 && (
                  <span className="text-xs text-zinc-500">
                    +{gitInfo.untrackedCount} untracked
                  </span>
                )}

                <div className="flex items-center gap-1.5 text-xs text-zinc-500">
                  <GitCommit className="h-3.5 w-3.5" />
                  <span className="font-mono">{gitInfo.lastCommit.hash}</span>
                  <span className="truncate max-w-[200px]">{gitInfo.lastCommit.message}</span>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 text-xs text-zinc-400 hover:text-zinc-100"
                  onClick={handleGitPull}
                  disabled={gitLoading === 'pull'}
                  title={gitInfo.behindCount > 0 ? `Pull ${gitInfo.behindCount} commit${gitInfo.behindCount !== 1 ? 's' : ''}` : 'Pull from remote'}
                >
                  <ArrowDown className={cn('h-3.5 w-3.5 mr-1', gitLoading === 'pull' && 'animate-bounce')} />
                  Pull{gitInfo.behindCount > 0 && ` (${gitInfo.behindCount})`}
                </Button>

                {/* Commit button/input */}
                {showCommitInput ? (
                  <div className="flex items-center gap-1">
                    <input
                      ref={commitInputRef}
                      type="text"
                      placeholder="Commit message..."
                      value={commitMessage}
                      onChange={(e) => setCommitMessage(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleGitCommit();
                        if (e.key === 'Escape') {
                          setShowCommitInput(false);
                          setCommitMessage('');
                        }
                      }}
                      className="h-8 px-2 text-xs bg-zinc-800 border border-zinc-700 rounded text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-purple-500 w-48"
                      autoFocus
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 w-8 p-0 text-green-400 hover:text-green-300 hover:bg-green-500/10"
                      onClick={handleGitCommit}
                      disabled={gitLoading === 'commit' || !commitMessage.trim()}
                    >
                      <Check className={cn('h-4 w-4', gitLoading === 'commit' && 'animate-pulse')} />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 w-8 p-0 text-zinc-400 hover:text-zinc-200"
                      onClick={() => {
                        setShowCommitInput(false);
                        setCommitMessage('');
                      }}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 text-xs text-zinc-400 hover:text-zinc-100"
                    onClick={() => setShowCommitInput(true)}
                    disabled={!gitInfo.isDirty}
                    title={gitInfo.isDirty ? 'Commit changes' : 'No changes to commit'}
                  >
                    <GitCommit className="h-3.5 w-3.5 mr-1" />
                    Commit
                  </Button>
                )}

                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 text-xs text-zinc-400 hover:text-zinc-100"
                  onClick={handleGitPush}
                  disabled={gitLoading === 'push' || gitInfo.aheadCount === 0}
                  title={gitInfo.aheadCount > 0 ? `Push ${gitInfo.aheadCount} commit${gitInfo.aheadCount !== 1 ? 's' : ''}` : 'No commits to push'}
                >
                  <ArrowUp className={cn('h-3.5 w-3.5 mr-1', gitLoading === 'push' && 'animate-bounce')} />
                  Push{gitInfo.aheadCount > 0 && ` (${gitInfo.aheadCount})`}
                </Button>

                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 text-xs text-zinc-400 hover:text-zinc-100"
                  onClick={fetchGitInfo}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          )}

          {/* Vercel Row - only show if it's a Vercel project */}
          {vercelInfo?.isVercelProject && (
            <div className="flex items-center justify-between pb-4 border-b border-zinc-800">
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <Triangle className="h-4 w-4 text-zinc-500" fill="currentColor" />
                  <span className="text-sm font-medium text-zinc-200">Vercel</span>
                </div>

                {vercelInfo.isLinked ? (
                  <Badge variant="outline" className="text-xs border-green-500/50 text-green-400">
                    <Link className="h-3 w-3 mr-1" />
                    Linked
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-xs border-yellow-500/50 text-yellow-400">
                    Not linked
                  </Badge>
                )}

                {vercelInfo.latestDeployment && (
                  <div className="flex items-center gap-2 text-xs">
                    <span className={cn(
                      'px-1.5 py-0.5 rounded text-[10px] uppercase font-medium',
                      vercelInfo.latestDeployment.state === 'READY'
                        ? 'bg-green-500/20 text-green-400'
                        : vercelInfo.latestDeployment.state === 'ERROR'
                        ? 'bg-red-500/20 text-red-400'
                        : 'bg-yellow-500/20 text-yellow-400'
                    )}>
                      {vercelInfo.latestDeployment.state}
                    </span>
                    {vercelInfo.latestDeployment.target && (
                      <span className="text-zinc-500">
                        ({vercelInfo.latestDeployment.target})
                      </span>
                    )}
                    {vercelInfo.latestDeployment.url && (
                      <a
                        href={`https://${vercelInfo.latestDeployment.url}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-purple-400 hover:text-purple-300 font-mono truncate max-w-[200px]"
                      >
                        {vercelInfo.latestDeployment.url}
                      </a>
                    )}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 text-xs text-zinc-400 hover:text-zinc-100"
                  onClick={() => handleVercelDeploy(false)}
                  disabled={vercelDeploying !== null}
                  title="Deploy preview"
                >
                  <Rocket className={cn('h-3.5 w-3.5 mr-1', vercelDeploying === 'preview' && 'animate-pulse')} />
                  Preview
                </Button>

                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs border-zinc-700 hover:bg-zinc-800"
                  onClick={() => handleVercelDeploy(true)}
                  disabled={vercelDeploying !== null}
                  title="Deploy to production"
                >
                  <Rocket className={cn('h-3.5 w-3.5 mr-1', vercelDeploying === 'prod' && 'animate-pulse')} />
                  Production
                </Button>

                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 text-xs text-zinc-400 hover:text-zinc-100"
                  onClick={fetchVercelInfo}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          )}

          {/* Metrics Bar */}
          <div className="flex items-center gap-6 pb-4 border-b border-zinc-800">
            <MetricItem
              icon={<Clock className="h-4 w-4" />}
              label="Uptime"
              value={isRunning ? formatUptime(metrics?.process.uptime ?? null) : '-'}
              active={isRunning}
            />
            <MetricItem
              icon={<Cpu className="h-4 w-4" />}
              label="Memory"
              value={metrics?.process.memoryMB ? `${metrics.process.memoryMB} MB` : '-'}
              active={isRunning && metrics?.process.memoryMB !== null}
            />
            <MetricItem
              icon={<Activity className="h-4 w-4" />}
              label="CPU"
              value={metrics?.process.cpuPercent !== null ? `${metrics?.process.cpuPercent}%` : '-'}
              active={isRunning && metrics?.process.cpuPercent !== null}
            />
            <MetricItem
              icon={<Wifi className="h-4 w-4" />}
              label="Port"
              value={metrics?.port.isOpen ? `${metrics.port.responseTimeMs}ms` : 'Closed'}
              active={metrics?.port.isOpen ?? false}
              color={metrics?.port.isOpen ? 'green' : 'red'}
            />
            <MetricItem
              icon={<Hash className="h-4 w-4" />}
              label="PID"
              value={metrics?.process.pid?.toString() ?? '-'}
              active={isRunning && metrics?.process.pid !== null}
            />
          </div>

          {/* Action Buttons */}
          <div className="flex items-center justify-between">
            {/* Primary Actions */}
            <div className="flex items-center gap-2">
              {/* Start Button with optional dropdown for prod mode */}
              <div className="relative" ref={startMenuRef}>
                <div className="flex">
                  <Button
                    size="sm"
                    className={cn(
                      'h-9 text-xs',
                      hasProdMode ? 'rounded-r-none' : '',
                      isRunning
                        ? 'bg-zinc-700 hover:bg-zinc-600 text-zinc-300'
                        : 'bg-green-600 hover:bg-green-700 text-white'
                    )}
                    onClick={() => handleStart('dev')}
                    disabled={isToggling || isRestarting || isRunning}
                  >
                    <Play className={cn('h-3.5 w-3.5 mr-1.5', startMode === 'dev' && 'animate-pulse')} />
                    {startMode === 'dev' ? 'Starting...' : 'Start Dev'}
                  </Button>
                  {hasProdMode && (
                    <Button
                      size="sm"
                      className={cn(
                        'h-9 px-2 rounded-l-none border-l border-green-700',
                        isRunning
                          ? 'bg-zinc-700 hover:bg-zinc-600 text-zinc-300'
                          : 'bg-green-600 hover:bg-green-700 text-white'
                      )}
                      onClick={() => setShowStartMenu(!showStartMenu)}
                      disabled={isToggling || isRestarting || isRunning}
                    >
                      <ChevronDown className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
                {/* Dropdown menu */}
                {showStartMenu && !isRunning && (
                  <div className="absolute top-full left-0 mt-1 bg-zinc-800 border border-zinc-700 rounded-md shadow-lg z-10 min-w-[140px]">
                    <button
                      className="w-full px-3 py-2 text-left text-xs text-zinc-300 hover:bg-zinc-700 flex items-center gap-2"
                      onClick={() => { setShowStartMenu(false); handleStart('dev'); }}
                    >
                      <Play className="h-3 w-3" />
                      Start Dev
                    </button>
                    <button
                      className="w-full px-3 py-2 text-left text-xs text-zinc-300 hover:bg-zinc-700 flex items-center gap-2 border-t border-zinc-700"
                      onClick={() => { setShowStartMenu(false); handleStart('prod'); }}
                    >
                      <Rocket className="h-3 w-3" />
                      Start Prod
                    </button>
                  </div>
                )}
              </div>

              <Button
                size="sm"
                variant="destructive"
                className="h-9 text-xs"
                onClick={handleStop}
                disabled={isToggling || isRestarting || !isRunning}
              >
                <Square className="h-3.5 w-3.5 mr-1.5" />
                Stop
              </Button>

              <Button
                size="sm"
                variant="outline"
                className="h-9 text-xs border-zinc-700 hover:bg-zinc-800"
                onClick={handleRestart}
                disabled={isToggling || isRestarting || !isRunning}
              >
                <RotateCcw className={cn('h-3.5 w-3.5 mr-1.5', isRestarting && 'animate-spin')} />
                Restart
              </Button>
            </div>

            {/* Utility Actions */}
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                className="h-9 text-xs text-zinc-400 hover:text-zinc-100"
                onClick={openInIDE}
                title="Open in VS Code"
              >
                <Code className="h-3.5 w-3.5 mr-1.5" />
                IDE
              </Button>

              <Button
                size="sm"
                variant="ghost"
                className="h-9 text-xs text-zinc-400 hover:text-zinc-100"
                onClick={() => {
                  if (onOpenShell) {
                    onOpenShell(project.path, project.name);
                  } else {
                    openTerminal();
                  }
                }}
                title={onOpenShell ? "Open shell panel" : "Copy cd command to clipboard"}
              >
                <Terminal className="h-3.5 w-3.5 mr-1.5" />
                Shell
              </Button>

              <Button
                size="sm"
                variant="ghost"
                className="h-9 text-xs text-zinc-400 hover:text-zinc-100"
                onClick={openFileManager}
                title="Copy path to clipboard"
              >
                <FolderOpen className="h-3.5 w-3.5 mr-1.5" />
                Files
              </Button>

              {isRunning && (
                <a
                  href={`http://localhost:${project.port}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 h-9 px-3 text-xs text-purple-400 hover:text-purple-300 hover:bg-zinc-800 rounded-md transition-colors"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Browser
                </a>
              )}

              <div className="h-6 w-px bg-zinc-700 mx-1" />

              {/* Cache Tools */}
              <Button
                size="sm"
                variant="ghost"
                className="h-9 text-xs text-zinc-400 hover:text-zinc-100"
                onClick={handleClearCache}
                disabled={actionLoading === 'cache'}
                title="Clear .next cache"
              >
                <RefreshCw className={cn('h-3.5 w-3.5 mr-1.5', actionLoading === 'cache' && 'animate-spin')} />
                Clear Cache
              </Button>

              <Button
                size="sm"
                variant="ghost"
                className="h-9 text-xs text-zinc-400 hover:text-zinc-100"
                onClick={handleDeleteLock}
                disabled={actionLoading === 'lock'}
                title="Delete pnpm-lock.yaml"
              >
                <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                Delete Lock
              </Button>
            </div>
          </div>
        </div>

        {/* Collapsible Sections */}
        <CollapsibleSection key={`logs-${logsKey}`} title="Logs" defaultOpen={isRunning}>
          <LogsSection projectId={project.id} isRunning={isRunning} />
        </CollapsibleSection>

        <CollapsibleSection title="Project Info" defaultOpen>
          <InfoSection projectId={project.id} projectPath={project.path} />
        </CollapsibleSection>

        <CollapsibleSection title="Git">
          <GitSection projectId={project.id} projectPath={project.path} />
        </CollapsibleSection>

        <CollapsibleSection title="Package Health">
          <PackageHealthSection
            projectId={project.id}
            projectPath={project.path}
            projectName={project.name}
            initialOutdatedCount={project.extended?.packages?.outdatedCount}
            holds={project.holds || []}
            onOpenPanel={onOpenPackageHealthPanel}
          />
        </CollapsibleSection>

        <CollapsibleSection title="Patch History">
          <PatchHistorySection projectId={project.id} />
        </CollapsibleSection>
      </div>

      {/* Edit Project Dialog */}
      <AddProjectDialog
        open={showEditDialog}
        onOpenChange={setShowEditDialog}
        onSuccess={onRefresh}
        categories={categories}
        editProject={project as ProjectConfig}
      />
    </div>
  );
}

// Metric display item
interface MetricItemProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  active?: boolean;
  color?: 'green' | 'red' | 'default';
}

function MetricItem({ icon, label, value, active = false, color = 'default' }: MetricItemProps) {
  const colorClass = {
    green: 'text-green-400',
    red: 'text-red-400',
    default: active ? 'text-zinc-100' : 'text-zinc-500',
  }[color];

  return (
    <div className="flex items-center gap-2">
      <span className={cn('text-zinc-500', active && 'text-zinc-400')}>{icon}</span>
      <div className="flex flex-col">
        <span className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</span>
        <span className={cn('text-sm font-mono', colorClass)}>{value}</span>
      </div>
    </div>
  );
}

// Collapsible section wrapper
interface CollapsibleSectionProps {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

function CollapsibleSection({ title, defaultOpen = false, children }: CollapsibleSectionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className="border border-zinc-800 rounded-lg overflow-hidden">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between px-4 py-3 bg-zinc-900/50 hover:bg-zinc-900 transition-colors"
      >
        <span className="text-sm font-medium text-zinc-200">{title}</span>
        {isOpen ? (
          <ChevronDown className="h-4 w-4 text-zinc-500" />
        ) : (
          <ChevronRight className="h-4 w-4 text-zinc-500" />
        )}
      </button>
      {isOpen && (
        <div className="p-4 border-t border-zinc-800 bg-zinc-950">
          {children}
        </div>
      )}
    </div>
  );
}
