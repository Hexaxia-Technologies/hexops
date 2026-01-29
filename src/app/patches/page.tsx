'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Sidebar } from '@/components/sidebar';
import { PatchesSidebar, type UpdateResult, type UpdateStatus } from '@/components/patches-sidebar';
import { AddProjectDialog } from '@/components/add-project-dialog';
import { RefreshCw, Shield, Package, ArrowUp, List, FolderTree, ChevronDown, ChevronRight, AlertTriangle, Link as LinkIcon, PauseCircle, PlayCircle, ExternalLink, HelpCircle } from 'lucide-react';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import type { PatchQueueItem, PatchSummary } from '@/lib/types';
import { generatePatchCommitMessage, type UpdatedPackage } from '@/lib/patch-commit-message';
import { GitCommit, Upload, Pencil, X } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';

interface PatchesData {
  queue: PatchQueueItem[];
  summary: PatchSummary;
  lastScan: string | null;
  projectCount: number;
  categories: string[];
  projectCategories: Record<string, string>;  // projectId -> category
  projectNames: Record<string, string>;  // projectId -> name
}

type FilterType = 'all' | 'vulns' | 'outdated';
type ViewMode = 'flat' | 'grouped';

// localStorage persistence
const PREFS_KEY = 'hexops-patches-preferences';

interface PatchesPreferences {
  viewMode: ViewMode;
  showUnfixable: boolean;
  showHeld: boolean;
}

const DEFAULT_PREFS: PatchesPreferences = {
  viewMode: 'grouped',  // Default to grouped view
  showUnfixable: true,
  showHeld: true,
};

function loadPreferences(): PatchesPreferences {
  if (typeof window === 'undefined') return DEFAULT_PREFS;
  try {
    const stored = localStorage.getItem(PREFS_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      return { ...DEFAULT_PREFS, ...parsed };
    }
  } catch {
    // Ignore parse errors
  }
  return DEFAULT_PREFS;
}

function savePreferences(prefs: Partial<PatchesPreferences>): void {
  if (typeof window === 'undefined') return;
  try {
    const current = loadPreferences();
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...current, ...prefs }));
  } catch {
    // Ignore storage errors
  }
}

interface ProjectGroup {
  projectId: string;
  projectName: string;
  patches: PatchQueueItem[];
  isExpanded: boolean;
}

// Per-project git state for commit/push flow
interface PendingCommit {
  packages: UpdatedPackage[];
  message: string;
  isEditing: boolean;
}

interface ProjectGitStatus {
  dirty: boolean;
  ahead: number;
  behind: number;
}

interface ProjectGitState {
  pendingCommit: PendingCommit | null;
  gitStatus: ProjectGitStatus | null;
  isCommitting: boolean;
  isPushing: boolean;
}

export default function PatchesPage() {
  const [data, setData] = useState<PatchesData | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [filter, setFilter] = useState<FilterType>('all');
  const [viewMode, setViewMode] = useState<ViewMode>(DEFAULT_PREFS.viewMode);
  const [selectedPackages, setSelectedPackages] = useState<Set<string>>(new Set());
  const [updating, setUpdating] = useState(false);
  const [showAddProject, setShowAddProject] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [recentUpdates, setRecentUpdates] = useState<UpdateResult[]>([]);
  const [showUnfixable, setShowUnfixable] = useState(DEFAULT_PREFS.showUnfixable);
  const [showHeld, setShowHeld] = useState(DEFAULT_PREFS.showHeld);
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  // Per-project git state for commit/push flow
  const [projectGitStates, setProjectGitStates] = useState<Record<string, ProjectGitState>>({});

  const fetchPatches = useCallback(async (bustCache = false) => {
    try {
      // Add cache-busting param after updates to ensure fresh data
      const url = bustCache ? `/api/patches?t=${Date.now()}` : '/api/patches';
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to fetch');
      const json = await res.json();
      setData(json);
      // Expand all projects by default
      const projectIds = new Set<string>(json.queue.map((item: PatchQueueItem) => item.projectId));
      setExpandedProjects(projectIds);
    } catch (error) {
      console.error('Failed to fetch patches:', error);
      toast.error('Failed to load patch data');
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch persisted patch history
  const fetchHistory = useCallback(async () => {
    try {
      const res = await fetch('/api/patches/history?limit=20');
      if (!res.ok) return;
      const json = await res.json();
      // Convert persisted format to UpdateResult format
      const updates: UpdateResult[] = (json.updates || []).map((entry: {
        projectId: string;
        projectName?: string;
        package: string;
        fromVersion: string;
        toVersion: string;
        success: boolean;
        error?: string;
        timestamp: string;
      }) => ({
        projectId: entry.projectId,
        projectName: entry.projectName || entry.projectId,
        packageName: entry.package,
        fromVersion: entry.fromVersion,
        toVersion: entry.toVersion,
        success: entry.success,
        error: entry.error,
        timestamp: new Date(entry.timestamp),
      }));
      setRecentUpdates(updates);
    } catch (error) {
      console.error('Failed to fetch history:', error);
    }
  }, []);

  useEffect(() => {
    fetchPatches();
    fetchHistory();
  }, [fetchPatches, fetchHistory]);

  // Load preferences from localStorage on mount
  useEffect(() => {
    const prefs = loadPreferences();
    setViewMode(prefs.viewMode);
    setShowUnfixable(prefs.showUnfixable);
    setShowHeld(prefs.showHeld);
    setPrefsLoaded(true);
  }, []);

  // Save preferences when they change (after initial load)
  useEffect(() => {
    if (prefsLoaded) {
      savePreferences({ viewMode, showUnfixable, showHeld });
    }
  }, [viewMode, showUnfixable, showHeld, prefsLoaded]);

  // Fetch git status for a project
  const fetchProjectGitStatus = useCallback(async (projectId: string) => {
    try {
      const res = await fetch(`/api/projects/${projectId}/git`);
      if (!res.ok) return null;
      const data = await res.json();
      return {
        dirty: data.isDirty ?? false,
        ahead: data.aheadCount ?? 0,
        behind: data.behindCount ?? 0,
      } as ProjectGitStatus;
    } catch {
      return null;
    }
  }, []);

  // Fetch git status for all projects on load (to detect pending commits/pushes)
  useEffect(() => {
    if (!data) return;

    const fetchAllGitStatuses = async () => {
      const projectIds = Object.keys(data.projectCategories);
      const statuses: Record<string, ProjectGitState> = {};

      await Promise.all(
        projectIds.map(async (projectId) => {
          const gitStatus = await fetchProjectGitStatus(projectId);
          if (gitStatus && (gitStatus.ahead > 0 || gitStatus.dirty)) {
            statuses[projectId] = {
              pendingCommit: null,
              gitStatus,
              isCommitting: false,
              isPushing: false,
            };
          }
        })
      );

      // Merge with existing states (don't overwrite active pending commits)
      setProjectGitStates(prev => {
        const merged = { ...statuses };
        for (const [id, state] of Object.entries(prev)) {
          if (state.pendingCommit || state.isCommitting || state.isPushing) {
            merged[id] = state;
          }
        }
        return merged;
      });
    };

    fetchAllGitStatuses();
  }, [data, fetchProjectGitStatus]);

  // Set pending commit for a project after updates
  const setPendingCommit = useCallback((
    projectId: string,
    packages: UpdatedPackage[]
  ) => {
    const { full: message } = generatePatchCommitMessage(packages);
    setProjectGitStates(prev => ({
      ...prev,
      [projectId]: {
        ...prev[projectId],
        pendingCommit: { packages, message, isEditing: false },
        isCommitting: false,
        isPushing: false,
      },
    }));
    // Fetch git status for this project
    fetchProjectGitStatus(projectId).then(gitStatus => {
      setProjectGitStates(prev => ({
        ...prev,
        [projectId]: { ...prev[projectId], gitStatus },
      }));
    });
  }, [fetchProjectGitStatus]);

  // Dismiss pending commit
  const dismissPendingCommit = useCallback((projectId: string) => {
    setProjectGitStates(prev => ({
      ...prev,
      [projectId]: { ...prev[projectId], pendingCommit: null },
    }));
  }, []);

  // Update commit message
  const updateCommitMessage = useCallback((projectId: string, message: string) => {
    setProjectGitStates(prev => ({
      ...prev,
      [projectId]: {
        ...prev[projectId],
        pendingCommit: prev[projectId]?.pendingCommit
          ? { ...prev[projectId].pendingCommit!, message }
          : null,
      },
    }));
  }, []);

  // Toggle edit mode for commit message
  const toggleCommitEditMode = useCallback((projectId: string) => {
    setProjectGitStates(prev => ({
      ...prev,
      [projectId]: {
        ...prev[projectId],
        pendingCommit: prev[projectId]?.pendingCommit
          ? { ...prev[projectId].pendingCommit!, isEditing: !prev[projectId].pendingCommit!.isEditing }
          : null,
      },
    }));
  }, []);

  // Handle commit
  const handleCommit = useCallback(async (projectId: string) => {
    const state = projectGitStates[projectId];
    if (!state?.pendingCommit) return;

    setProjectGitStates(prev => ({
      ...prev,
      [projectId]: { ...prev[projectId], isCommitting: true },
    }));

    try {
      const res = await fetch(`/api/projects/${projectId}/git-commit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: state.pendingCommit.message }),
      });
      const data = await res.json();

      if (res.ok && data.success) {
        toast.success('Changes committed');
        // Clear pending commit and refresh git status
        const gitStatus = await fetchProjectGitStatus(projectId);
        setProjectGitStates(prev => ({
          ...prev,
          [projectId]: {
            ...prev[projectId],
            pendingCommit: null,
            gitStatus,
            isCommitting: false,
          },
        }));
      } else {
        toast.error(data.error || 'Commit failed');
        setProjectGitStates(prev => ({
          ...prev,
          [projectId]: { ...prev[projectId], isCommitting: false },
        }));
      }
    } catch {
      toast.error('Failed to commit');
      setProjectGitStates(prev => ({
        ...prev,
        [projectId]: { ...prev[projectId], isCommitting: false },
      }));
    }
  }, [projectGitStates, fetchProjectGitStatus]);

  // Handle push
  const handlePush = useCallback(async (projectId: string) => {
    setProjectGitStates(prev => ({
      ...prev,
      [projectId]: { ...prev[projectId], isPushing: true },
    }));

    try {
      const res = await fetch(`/api/projects/${projectId}/git-push`, {
        method: 'POST',
      });
      const data = await res.json();

      if (res.ok && data.success) {
        toast.success('Pushed to remote');
        // Refresh git status
        const gitStatus = await fetchProjectGitStatus(projectId);
        setProjectGitStates(prev => ({
          ...prev,
          [projectId]: { ...prev[projectId], gitStatus, isPushing: false },
        }));
      } else {
        toast.error(data.error || 'Push failed');
        setProjectGitStates(prev => ({
          ...prev,
          [projectId]: { ...prev[projectId], isPushing: false },
        }));
      }
    } catch {
      toast.error('Failed to push');
      setProjectGitStates(prev => ({
        ...prev,
        [projectId]: { ...prev[projectId], isPushing: false },
      }));
    }
  }, [fetchProjectGitStatus]);

  const handleScan = async () => {
    setScanning(true);
    try {
      const res = await fetch('/api/patches/scan', { method: 'POST' });
      if (!res.ok) throw new Error('Scan failed');
      const json = await res.json();
      setData(json);
      toast.success('Scan complete');
    } catch (error) {
      console.error('Scan failed:', error);
      toast.error('Scan failed');
    } finally {
      setScanning(false);
    }
  };

  // Create selection key for an item (1:1 relationship)
  // Include type and severity to handle cases like multiple vulns for same package
  const getItemKey = (item: PatchQueueItem) => {
    // For vulnerabilities with titles (multiple CVEs can affect same package), include title for uniqueness
    // For outdated packages, the package+version combo is unique enough
    const titlePart = item.type === 'vulnerability' && item.title ? `:${item.title}` : '';
    return `${item.projectId}:${item.type}:${item.package}:${item.severity}:${item.targetVersion || 'no-fix'}${titlePart}`;
  };

  const toggleSelection = (key: string) => {
    setSelectedPackages(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  // Filter queue by type and category
  // Count unfixable vulnerabilities
  const unfixableCount = useMemo(() => {
    if (!data) return 0;
    return data.queue.filter(
      item => item.type === 'vulnerability' && item.fixAvailable === false
    ).length;
  }, [data]);

  // Count held packages
  const heldCount = useMemo(() => {
    if (!data) return 0;
    return data.queue.filter(item => item.isHeld === true).length;
  }, [data]);

  const filteredQueue = useMemo(() => {
    if (!data) return [];

    return data.queue.filter(item => {
      // Type filter
      if (filter === 'vulns' && item.type !== 'vulnerability') return false;
      if (filter === 'outdated' && item.type !== 'outdated') return false;

      // Hide unfixable vulnerabilities if toggle is off
      if (!showUnfixable && item.type === 'vulnerability' && item.fixAvailable === false) {
        return false;
      }

      // Hide held packages if toggle is off
      if (!showHeld && item.isHeld) {
        return false;
      }

      // Category filter
      if (selectedCategory && selectedCategory !== 'running' && selectedCategory !== 'stopped') {
        const itemCategory = data.projectCategories[item.projectId];
        if (itemCategory !== selectedCategory) return false;
      }

      return true;
    });
  }, [data, filter, selectedCategory, showUnfixable, showHeld]);

  // Group by project for grouped view - show ALL projects
  const groupedByProject = useMemo((): ProjectGroup[] => {
    if (!data) return [];

    const groups = new Map<string, ProjectGroup>();

    // Initialize all projects (so they all appear even with 0 patches)
    for (const [projectId, projectName] of Object.entries(data.projectNames)) {
      // Apply category filter
      if (selectedCategory && selectedCategory !== 'running' && selectedCategory !== 'stopped') {
        const itemCategory = data.projectCategories[projectId];
        if (itemCategory !== selectedCategory) continue;
      }

      groups.set(projectId, {
        projectId,
        projectName,
        patches: [],
        isExpanded: expandedProjects.has(projectId),
      });
    }

    // Add patches to their projects
    for (const item of filteredQueue) {
      const group = groups.get(item.projectId);
      if (group) {
        group.patches.push(item);
      }
    }

    return Array.from(groups.values()).sort((a, b) =>
      a.projectName.localeCompare(b.projectName)
    );
  }, [data, filteredQueue, expandedProjects, selectedCategory]);

  const toggleProjectExpanded = (projectId: string) => {
    setExpandedProjects(prev => {
      const next = new Set(prev);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  };

  const selectAllInProject = (projectId: string) => {
    // Exclude held and unfixable packages from selection
    const projectPatches = filteredQueue.filter(
      item => item.projectId === projectId && !item.isHeld && !(item.type === 'vulnerability' && item.fixAvailable === false)
    );
    const keys = projectPatches.map(item => getItemKey(item));
    setSelectedPackages(prev => {
      const next = new Set(prev);
      keys.forEach(key => next.add(key));
      return next;
    });
  };

  const deselectAllInProject = (projectId: string) => {
    const projectPatches = filteredQueue.filter(item => item.projectId === projectId);
    const keys = new Set(projectPatches.map(item => getItemKey(item)));
    setSelectedPackages(prev => {
      const next = new Set(prev);
      keys.forEach(key => next.delete(key));
      return next;
    });
  };

  const getProjectSelectionState = (projectId: string): 'none' | 'some' | 'all' => {
    // Only count selectable items (not held, not unfixable)
    const selectablePatches = filteredQueue.filter(
      item => item.projectId === projectId && !item.isHeld && !(item.type === 'vulnerability' && item.fixAvailable === false)
    );
    if (selectablePatches.length === 0) return 'none';
    const selectedCount = selectablePatches.filter(item => selectedPackages.has(getItemKey(item))).length;
    if (selectedCount === 0) return 'none';
    if (selectedCount === selectablePatches.length) return 'all';
    return 'some';
  };

  const selectAll = () => {
    // Exclude held and unfixable packages from selection
    const selectableItems = filteredQueue.filter(
      item => !item.isHeld && !(item.type === 'vulnerability' && item.fixAvailable === false)
    );
    const keys = selectableItems.map(item => getItemKey(item));
    setSelectedPackages(new Set(keys));
  };

  const clearSelection = () => {
    setSelectedPackages(new Set());
  };

  const handleHold = async (projectId: string, packageName: string, hold: boolean) => {
    try {
      const method = hold ? 'POST' : 'DELETE';
      const res = await fetch(`/api/projects/${projectId}/holds`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ package: packageName }),
      });

      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || `Failed to ${hold ? 'hold' : 'release'} package`);
        return;
      }

      // When putting on hold, remove from selection
      if (hold) {
        setSelectedPackages(prev => {
          const next = new Set(prev);
          // Remove any selection keys for this package in this project
          for (const key of prev) {
            if (key.startsWith(`${projectId}:`) && key.includes(`:${packageName}:`)) {
              next.delete(key);
            }
          }
          return next;
        });
      }

      toast.success(hold ? `${packageName} put on hold` : `${packageName} released from hold`);
      // Refresh data to update hold status
      fetchPatches(true);
    } catch {
      toast.error(`Failed to ${hold ? 'hold' : 'release'} package`);
    }
  };

  const handleUpdateSelected = async () => {
    if (!data || selectedPackages.size === 0) return;

    setUpdating(true);
    const selectedItems = filteredQueue.filter(
      item => selectedPackages.has(getItemKey(item))
    );

    // Group by project for batch updates
    const updatesByProject = new Map<string, { name: string; projectName: string; toVersion: string; fromVersion: string }[]>();

    for (const item of selectedItems) {
      if (!updatesByProject.has(item.projectId)) {
        updatesByProject.set(item.projectId, []);
      }
      updatesByProject.get(item.projectId)!.push({
        name: item.package,
        projectName: item.projectName,
        toVersion: item.targetVersion,
        fromVersion: item.currentVersion,
      });
    }

    const totalUpdates = selectedItems.length;
    let completedUpdates = 0;

    setUpdateStatus({
      isUpdating: true,
      progress: 0,
      total: totalUpdates,
    });

    const newResults: UpdateResult[] = [];

    for (const [projectId, packages] of updatesByProject) {
      const projectName = packages[0]?.projectName || projectId;

      for (const pkg of packages) {
        setUpdateStatus({
          isUpdating: true,
          currentProject: projectName,
          currentPackage: pkg.name,
          progress: completedUpdates,
          total: totalUpdates,
        });

        try {
          const res = await fetch(`/api/projects/${projectId}/update`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ packages: [pkg] }),
          });
          const result = await res.json();

          newResults.unshift({
            projectId,
            projectName,
            packageName: pkg.name,
            fromVersion: pkg.fromVersion,
            toVersion: pkg.toVersion,
            success: result.success,
            error: result.error,
            timestamp: new Date(),
          });
        } catch (err) {
          newResults.unshift({
            projectId,
            projectName,
            packageName: pkg.name,
            fromVersion: pkg.fromVersion,
            toVersion: pkg.toVersion,
            success: false,
            error: 'Network error',
            timestamp: new Date(),
          });
        }

        completedUpdates++;
      }
    }

    setUpdateStatus(null);
    setUpdating(false);
    setSelectedPackages(new Set());
    setRecentUpdates(prev => [...newResults, ...prev].slice(0, 20));

    const successCount = newResults.filter(r => r.success).length;
    const failCount = newResults.filter(r => !r.success).length;

    if (failCount === 0) {
      toast.success(`Updated ${successCount} package(s)`);
    } else {
      toast.warning(`${successCount} succeeded, ${failCount} failed`);
    }

    // Set pending commits for projects with successful updates
    const successfulByProject = new Map<string, UpdatedPackage[]>();
    for (const result of newResults) {
      if (result.success) {
        if (!successfulByProject.has(result.projectId)) {
          successfulByProject.set(result.projectId, []);
        }
        // Check if this was a security fix (look up from selectedItems)
        const originalItem = selectedItems.find(
          item => item.projectId === result.projectId && item.package === result.packageName
        );
        successfulByProject.get(result.projectId)!.push({
          name: result.packageName,
          fromVersion: result.fromVersion,
          toVersion: result.toVersion,
          isSecurityFix: originalItem?.type === 'vulnerability',
          vulnCount: originalItem?.type === 'vulnerability' ? 1 : undefined,
        });
      }
    }

    // Create pending commits for each project
    for (const [projectId, packages] of successfulByProject) {
      setPendingCommit(projectId, packages);
    }

    // Refresh data with cache busting to get fresh scan results
    fetchPatches(true);
  };

  // Calculate counts for sidebar
  const projectCounts = useMemo(() => {
    if (!data) return {};
    const counts: Record<string, number> = {};
    for (const category of data.categories) {
      counts[category] = Object.entries(data.projectCategories)
        .filter(([, cat]) => cat === category)
        .length;
    }
    return counts;
  }, [data]);

  // Get unique project count from queue
  const uniqueProjectIds = useMemo(() => {
    if (!data) return new Set<string>();
    return new Set(data.queue.map(item => item.projectId));
  }, [data]);

  if (loading) {
    return (
      <div className="flex h-screen bg-zinc-950 items-center justify-center">
        <div className="text-zinc-500">Loading patch data...</div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex h-screen bg-zinc-950 items-center justify-center">
        <div className="text-red-400">Failed to load patch data</div>
      </div>
    );
  }

  const { summary } = data;
  const totalIssues = summary.critical + summary.high + summary.moderate +
    summary.outdatedMajor + summary.outdatedMinor + summary.outdatedPatch;

  return (
    <div className="flex h-screen bg-zinc-950">
      {/* Left Sidebar - Navigation */}
      <Sidebar
        categories={data.categories}
        selectedCategory={selectedCategory}
        onSelectCategory={setSelectedCategory}
        projectCounts={projectCounts}
        runningCount={0}  // Not relevant for patches view
        totalCount={data.projectCount}
        onAddProject={() => setShowAddProject(true)}
      />

      {/* Main Content */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <header className="border-b border-zinc-800 px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-semibold text-zinc-100">Patches</h1>
              <p className="text-xs text-zinc-500 mt-1">
                {filteredQueue.length} update{filteredQueue.length !== 1 ? 's' : ''} across {uniqueProjectIds.size} project{uniqueProjectIds.size !== 1 ? 's' : ''}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-zinc-500">
                {data.lastScan
                  ? `Last scan: ${new Date(data.lastScan).toLocaleString()}`
                  : 'Never scanned'}
              </span>
              <Button
                variant="outline"
                size="sm"
                className="border-zinc-700"
                onClick={handleScan}
                disabled={scanning}
              >
                <RefreshCw className={cn('h-4 w-4 mr-2', scanning && 'animate-spin')} />
                {scanning ? 'Scanning...' : 'Scan All'}
              </Button>
            </div>
          </div>
        </header>

        {/* Summary Bar */}
        <div className="border-b border-zinc-800 px-6 py-3 bg-zinc-900/50">
          <div className="flex items-center gap-6">
            {summary.critical > 0 && (
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-red-500" />
                <span className="text-sm text-red-400">{summary.critical} critical</span>
              </div>
            )}
            {summary.high > 0 && (
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-orange-500" />
                <span className="text-sm text-orange-400">{summary.high} high</span>
              </div>
            )}
            {summary.outdatedMajor > 0 && (
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-yellow-500" />
                <span className="text-sm text-yellow-400">{summary.outdatedMajor} major</span>
              </div>
            )}
            {(summary.outdatedMinor + summary.outdatedPatch) > 0 && (
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-zinc-500" />
                <span className="text-sm text-zinc-400">
                  {summary.outdatedMinor + summary.outdatedPatch} minor/patch
                </span>
              </div>
            )}
            {totalIssues === 0 && (
              <span className="text-sm text-green-400">All packages up to date!</span>
            )}
          </div>
        </div>

        {/* Filters & Actions */}
        <div className="border-b border-zinc-800 px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-4">
            {/* Type filter */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-500 mr-1">Type:</span>
              <Button
                variant={filter === 'all' ? 'secondary' : 'ghost'}
                size="sm"
                className="h-7 text-xs"
                onClick={() => setFilter('all')}
              >
                All ({data.queue.length})
              </Button>
              <Button
                variant={filter === 'vulns' ? 'secondary' : 'ghost'}
                size="sm"
                className="h-7 text-xs"
                onClick={() => setFilter('vulns')}
              >
                <Shield className="h-3 w-3 mr-1" />
                Vulns
              </Button>
              <Button
                variant={filter === 'outdated' ? 'secondary' : 'ghost'}
                size="sm"
                className="h-7 text-xs"
                onClick={() => setFilter('outdated')}
              >
                <Package className="h-3 w-3 mr-1" />
                Outdated
              </Button>
            </div>

            {/* View mode toggle */}
            <div className="h-5 w-px bg-zinc-700" />
            <div className="flex items-center gap-1">
              <span className="text-xs text-zinc-500 mr-1">View:</span>
              <Button
                variant={viewMode === 'flat' ? 'secondary' : 'ghost'}
                size="sm"
                className="h-7 text-xs px-2"
                onClick={() => setViewMode('flat')}
                title="Flat list"
              >
                <List className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant={viewMode === 'grouped' ? 'secondary' : 'ghost'}
                size="sm"
                className="h-7 text-xs px-2"
                onClick={() => setViewMode('grouped')}
                title="Group by project"
              >
                <FolderTree className="h-3.5 w-3.5" />
              </Button>
            </div>

            {/* Unfixable toggle */}
            {unfixableCount > 0 && (
              <>
                <div className="h-5 w-px bg-zinc-700" />
                <Button
                  variant={showUnfixable ? 'secondary' : 'ghost'}
                  size="sm"
                  className={cn(
                    'h-7 text-xs',
                    showUnfixable ? 'bg-amber-500/20 hover:bg-amber-500/30 text-amber-400' : ''
                  )}
                  onClick={() => setShowUnfixable(!showUnfixable)}
                  title={showUnfixable ? 'Hide unfixable vulnerabilities' : 'Show unfixable vulnerabilities'}
                >
                  <AlertTriangle className="h-3 w-3 mr-1" />
                  Unfixable ({unfixableCount})
                </Button>
              </>
            )}

            {/* Held toggle */}
            {heldCount > 0 && (
              <>
                <div className="h-5 w-px bg-zinc-700" />
                <Button
                  variant={showHeld ? 'secondary' : 'ghost'}
                  size="sm"
                  className={cn(
                    'h-7 text-xs',
                    showHeld ? 'bg-zinc-500/20 hover:bg-zinc-500/30 text-zinc-400' : ''
                  )}
                  onClick={() => setShowHeld(!showHeld)}
                  title={showHeld ? 'Hide held packages' : 'Show held packages'}
                >
                  <PauseCircle className="h-3 w-3 mr-1" />
                  On Hold ({heldCount})
                </Button>
              </>
            )}
          </div>

          {/* Selection actions */}
          {selectedPackages.size > 0 ? (
            <div className="flex items-center gap-3">
              <span className="text-xs text-zinc-400">{selectedPackages.size} selected</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-zinc-400"
                onClick={clearSelection}
              >
                Clear
              </Button>
              <Button
                size="sm"
                className="h-7 text-xs bg-purple-600 hover:bg-purple-700"
                onClick={handleUpdateSelected}
                disabled={updating}
              >
                <ArrowUp className={cn('h-3 w-3 mr-1', updating && 'animate-bounce')} />
                {updating ? 'Updating...' : 'Update Selected'}
              </Button>
            </div>
          ) : filteredQueue.length > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-zinc-400"
              onClick={selectAll}
            >
              Select All
            </Button>
          ) : null}
        </div>

        {/* Queue List */}
        <div className="flex-1 overflow-auto p-6">
          {filteredQueue.length === 0 ? (
            <div className="text-center py-12 text-zinc-500">
              {filter === 'all'
                ? 'No patches needed — all packages are up to date!'
                : `No ${filter === 'vulns' ? 'vulnerabilities' : 'outdated packages'} found`}
            </div>
          ) : viewMode === 'flat' ? (
            <div className="space-y-2">
              {filteredQueue.map((item) => {
                const key = getItemKey(item);
                const isSelected = selectedPackages.has(key);

                return (
                  <PatchRow
                    key={key}
                    item={item}
                    itemKey={key}
                    isSelected={isSelected}
                    onToggle={toggleSelection}
                    onHold={handleHold}
                    showProject={true}
                  />
                );
              })}
            </div>
          ) : (
            <div className="space-y-4">
              {groupedByProject.map((group) => {
                const selectionState = getProjectSelectionState(group.projectId);
                return (
                <div key={group.projectId} className="border border-zinc-800 rounded-lg overflow-hidden">
                  {/* Project Header */}
                  <div className="flex items-center bg-zinc-900/50 hover:bg-zinc-900 transition-colors px-4 py-3">
                    {/* Left side: expand toggle, name, count, select all */}
                    <div className="flex items-center gap-3 flex-1">
                      <button
                        className="flex items-center gap-3"
                        onClick={() => group.patches.length > 0 && toggleProjectExpanded(group.projectId)}
                      >
                        {group.patches.length > 0 ? (
                          expandedProjects.has(group.projectId) ? (
                            <ChevronDown className="h-4 w-4 text-zinc-500" />
                          ) : (
                            <ChevronRight className="h-4 w-4 text-zinc-500" />
                          )
                        ) : (
                          <div className="w-4" /> /* Spacer when no patches */
                        )}
                        <span className="font-medium text-zinc-200">{group.projectName}</span>
                        <Link
                          href={`/?project=${group.projectId}`}
                          onClick={(e) => e.stopPropagation()}
                          className="text-zinc-500 hover:text-zinc-300 transition-colors"
                          title="View project details"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                        </Link>
                        {group.patches.length > 0 ? (
                          <Badge variant="outline" className="text-xs border-zinc-700 text-zinc-500">
                            {group.patches.length} update{group.patches.length !== 1 ? 's' : ''}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-xs border-green-500/30 text-green-400 bg-green-500/10">
                            ✓ All patched
                          </Badge>
                        )}
                      </button>
                      {/* Select All / Deselect All - only show when there are patches */}
                      {group.patches.length > 0 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs text-zinc-400 hover:text-zinc-200"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (selectionState === 'all') {
                              deselectAllInProject(group.projectId);
                            } else {
                              selectAllInProject(group.projectId);
                            }
                          }}
                        >
                          {selectionState === 'all' ? 'Deselect All' : 'Select All'}
                        </Button>
                      )}
                    </div>
                    {/* Right side: git controls */}
                    <div className="flex items-center gap-2">
                      {(() => {
                        const gitState = projectGitStates[group.projectId];
                        const hasPendingCommit = !!gitState?.pendingCommit;
                        const ahead = gitState?.gitStatus?.ahead ?? 0;
                        return (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              className={cn(
                                'h-7 text-xs',
                                hasPendingCommit
                                  ? 'text-green-400 hover:text-green-300 hover:bg-green-500/10'
                                  : 'text-zinc-600'
                              )}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (hasPendingCommit) handleCommit(group.projectId);
                              }}
                              disabled={!hasPendingCommit || gitState?.isCommitting}
                            >
                              <GitCommit className={cn('h-3.5 w-3.5 mr-1', gitState?.isCommitting && 'animate-pulse')} />
                              {gitState?.isCommitting ? 'Committing...' : 'Commit'}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className={cn(
                                'h-7 text-xs',
                                ahead > 0
                                  ? 'text-blue-400 hover:text-blue-300 hover:bg-blue-500/10'
                                  : 'text-zinc-600'
                              )}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (ahead > 0) handlePush(group.projectId);
                              }}
                              disabled={ahead === 0 || gitState?.isPushing}
                            >
                              <Upload className={cn('h-3.5 w-3.5 mr-1', gitState?.isPushing && 'animate-pulse')} />
                              {gitState?.isPushing ? 'Pushing...' : ahead > 0 ? `Push (${ahead}↑)` : 'Push'}
                            </Button>
                          </>
                        );
                      })()}
                    </div>
                  </div>

                  {/* Inline Commit UI - shows after patches are applied */}
                  {(() => {
                    const gitState = projectGitStates[group.projectId];
                    if (!gitState?.pendingCommit) return null;
                    const { packages, message, isEditing } = gitState.pendingCommit;
                    const securityCount = packages.filter(p => p.isSecurityFix).length;
                    const summary = securityCount > 0
                      ? `Updated ${packages.length} packages (${securityCount} security fix${securityCount !== 1 ? 'es' : ''})`
                      : `Updated ${packages.length} package${packages.length !== 1 ? 's' : ''}`;

                    return (
                      <div className="border-t border-zinc-800 bg-zinc-900/30 px-4 py-3">
                        <div className="flex items-start gap-3">
                          <div className="text-green-400 mt-0.5">✓</div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-zinc-300">{summary}</p>
                            {isEditing ? (
                              <Textarea
                                value={message}
                                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => updateCommitMessage(group.projectId, e.target.value)}
                                className="mt-2 font-mono text-xs min-h-[100px]"
                                placeholder="Commit message..."
                              />
                            ) : (
                              <div className="mt-2 bg-zinc-800 rounded px-3 py-2 font-mono text-xs text-zinc-300 whitespace-pre-wrap border border-zinc-700">
                                {message.split('\n').slice(0, 1).join('')}
                                {message.split('\n').length > 1 && (
                                  <span className="text-zinc-500"> ...</span>
                                )}
                              </div>
                            )}
                            <div className="flex items-center gap-2 mt-2">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 text-xs text-zinc-400 hover:text-zinc-200"
                                onClick={() => toggleCommitEditMode(group.projectId)}
                              >
                                <Pencil className="h-3 w-3 mr-1" />
                                {isEditing ? 'Done' : 'Edit'}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 text-xs text-zinc-500 hover:text-zinc-300"
                                onClick={() => dismissPendingCommit(group.projectId)}
                              >
                                <X className="h-3 w-3 mr-1" />
                                Dismiss
                              </Button>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })()}

                  {/* Project Patches */}
                  {expandedProjects.has(group.projectId) && (
                    <div className="p-2 space-y-2 bg-zinc-950">
                      {group.patches.map((item) => {
                        const key = getItemKey(item);
                        const isSelected = selectedPackages.has(key);

                        return (
                          <PatchRow
                            key={key}
                            item={item}
                            itemKey={key}
                            isSelected={isSelected}
                            onToggle={toggleSelection}
                            onHold={handleHold}
                            showProject={false}
                          />
                        );
                      })}
                    </div>
                  )}
                </div>
              );
              })}
            </div>
          )}
        </div>
      </main>

      {/* Right Sidebar - Update Status */}
      <PatchesSidebar
        updateStatus={updateStatus}
        recentUpdates={recentUpdates}
      />

      {/* Add Project Dialog */}
      <AddProjectDialog
        open={showAddProject}
        onOpenChange={setShowAddProject}
        onSuccess={() => fetchPatches(true)}
        categories={data?.categories || []}
      />
    </div>
  );
}

interface PatchRowProps {
  item: PatchQueueItem;
  itemKey: string;
  isSelected: boolean;
  onToggle: (key: string) => void;
  onHold: (projectId: string, packageName: string, hold: boolean) => void;
  showProject: boolean;
}

function PatchRow({ item, itemKey, isSelected, onToggle, onHold, showProject }: PatchRowProps) {
  const [showDetails, setShowDetails] = useState(false);
  const isUnfixable = item.type === 'vulnerability' && item.fixAvailable === false;
  const isTransitive = item.isDirect === false;
  const isHeld = item.isHeld === true;
  const isDisabled = isUnfixable || isHeld;

  const handleHoldClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onHold(item.projectId, item.package, !isHeld);
  };

  const handleInfoClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowDetails(!showDetails);
  };

  return (
    <div className="rounded-lg border transition-colors overflow-hidden"
      style={{
        backgroundColor: isHeld ? 'rgba(24, 24, 27, 0.5)' : isSelected ? 'rgba(168, 85, 247, 0.1)' : isUnfixable ? 'rgba(245, 158, 11, 0.05)' : 'rgb(24, 24, 27)',
        borderColor: isHeld ? 'rgba(39, 39, 42, 0.5)' : isSelected ? 'rgba(168, 85, 247, 0.3)' : isUnfixable ? 'rgba(245, 158, 11, 0.2)' : 'rgb(39, 39, 42)',
        opacity: isHeld ? 0.6 : 1,
      }}
    >
      <div
        className={cn(
          'flex items-center gap-4 p-4 cursor-pointer',
          !isHeld && !isSelected && !isUnfixable && 'hover:bg-zinc-800/50'
        )}
        onClick={() => !isHeld && onToggle(itemKey)}
      >
        <Checkbox
          checked={isSelected}
          onCheckedChange={() => onToggle(itemKey)}
          disabled={isDisabled}
          className={isDisabled ? 'opacity-50' : undefined}
        />

        <SeverityBadge type={item.type} severity={item.severity} />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={cn('font-mono font-medium', isHeld && 'text-zinc-500')}>{item.package}</span>
            {item.currentVersion && (
              <>
                <span className="text-zinc-500 font-mono text-sm">
                  {item.currentVersion}
                </span>
                <span className="text-zinc-600">→</span>
                <span className={cn('font-mono text-sm', isHeld ? 'text-zinc-500' : 'text-green-400')}>
                  {item.targetVersion}
                </span>
              </>
            )}
            <Badge variant="outline" className="text-xs border-zinc-700 text-zinc-500">
              {item.updateType}
            </Badge>
            {isHeld && (
              <Badge variant="outline" className="text-xs bg-zinc-500/10 border-zinc-500/30 text-zinc-400">
                <PauseCircle className="h-3 w-3 mr-1" />
                On hold
              </Badge>
            )}
            {isUnfixable && !isHeld && (
              <Badge variant="outline" className="text-xs bg-amber-500/10 border-amber-500/30 text-amber-400">
                <AlertTriangle className="h-3 w-3 mr-1" />
                No fix available
              </Badge>
            )}
            {/* CVE badges */}
            {item.cves && item.cves.length > 0 && (
              <Badge variant="outline" className="text-xs bg-red-500/10 border-red-500/30 text-red-400">
                {item.cves.length} CVE{item.cves.length !== 1 ? 's' : ''}
              </Badge>
            )}
          </div>
          {item.title && (
            <p className="text-sm text-zinc-500 truncate mt-1">{item.title}</p>
          )}
          {/* Dependency chain for transitive vulnerabilities */}
          {isTransitive && item.via && item.via.length > 0 && (
            <div className="flex items-center gap-1 mt-1 text-xs text-zinc-600">
              <LinkIcon className="h-3 w-3" />
              <span>via</span>
              {item.via.map((dep, idx) => (
                <span key={dep}>
                  <span className="font-mono text-zinc-500">{dep}</span>
                  {idx < item.via!.length - 1 && <span className="text-zinc-700 mx-1">→</span>}
                </span>
              ))}
            </div>
          )}
          {/* Parent package at latest indicator */}
          {isTransitive && item.parentPackage && (
            <p className="text-xs text-amber-500/70 mt-1">
              ⚠ {item.parentPackage} needs to update its dependencies
            </p>
          )}
          {showProject && (
            <p className="text-xs text-zinc-600 mt-1">
              Project: {item.projectName}
            </p>
          )}
        </div>

        {/* Info button */}
        <Button
          variant="ghost"
          size="sm"
          onClick={handleInfoClick}
          className={cn(
            'h-8 px-2',
            showDetails
              ? 'text-blue-400 hover:text-blue-300 hover:bg-blue-500/10'
              : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'
          )}
          title="Show details"
        >
          <HelpCircle className="h-4 w-4" />
        </Button>

        {/* Hold/Unhold button */}
        <Button
          variant="ghost"
          size="sm"
          onClick={handleHoldClick}
          className={cn(
            'h-8 px-2',
            isHeld
              ? 'text-green-400 hover:text-green-300 hover:bg-green-500/10'
              : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'
          )}
          title={isHeld ? 'Release hold' : 'Put on hold'}
        >
          {isHeld ? (
            <PlayCircle className="h-4 w-4" />
          ) : (
            <PauseCircle className="h-4 w-4" />
          )}
        </Button>
      </div>

      {/* Expandable details panel */}
      {showDetails && (
        <div className="border-t border-zinc-800 bg-zinc-950 px-4 py-3">
          <div className="grid grid-cols-2 gap-4 text-xs">
            <div>
              <span className="text-zinc-500">Package:</span>
              <span className="ml-2 font-mono text-zinc-300">{item.package}</span>
            </div>
            <div>
              <span className="text-zinc-500">Type:</span>
              <span className="ml-2 text-zinc-300 capitalize">{item.type}</span>
            </div>
            {item.type === 'vulnerability' && (
              <>
                <div>
                  <span className="text-zinc-500">Severity:</span>
                  <span className="ml-2 text-zinc-300 capitalize">{item.severity}</span>
                </div>
                <div>
                  <span className="text-zinc-500">Fix Available:</span>
                  <span className={cn('ml-2', item.fixAvailable ? 'text-green-400' : 'text-amber-400')}>
                    {item.fixAvailable ? 'Yes' : 'No'}
                  </span>
                </div>
              </>
            )}
            {item.type === 'outdated' && (
              <>
                <div>
                  <span className="text-zinc-500">Update Type:</span>
                  <span className="ml-2 text-zinc-300 capitalize">{item.updateType}</span>
                </div>
                <div>
                  <span className="text-zinc-500">Version:</span>
                  <span className="ml-2 font-mono text-zinc-400">{item.currentVersion}</span>
                  <span className="mx-1 text-zinc-600">→</span>
                  <span className="font-mono text-green-400">{item.targetVersion}</span>
                </div>
              </>
            )}
            {item.isDirect !== undefined && (
              <div>
                <span className="text-zinc-500">Dependency:</span>
                <span className="ml-2 text-zinc-300">{item.isDirect ? 'Direct' : 'Transitive'}</span>
              </div>
            )}
            {item.title && (
              <div className="col-span-2">
                <span className="text-zinc-500">Description:</span>
                <span className="ml-2 text-zinc-300">{item.title}</span>
              </div>
            )}
            {/* CVE Information */}
            {item.cves && item.cves.length > 0 && (
              <div className="col-span-2">
                <span className="text-zinc-500">CVE{item.cves.length !== 1 ? 's' : ''}:</span>
                <div className="ml-2 mt-1 flex flex-wrap gap-2">
                  {item.cves.map(cve => (
                    <a
                      key={cve}
                      href={`https://nvd.nist.gov/vuln/detail/${cve}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors font-mono text-xs"
                    >
                      {cve}
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  ))}
                </div>
              </div>
            )}
            {/* Advisory link */}
            {item.url && (
              <div className="col-span-2">
                <span className="text-zinc-500">Advisory:</span>
                <a
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="ml-2 inline-flex items-center gap-1 text-blue-400 hover:text-blue-300"
                >
                  View Advisory <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            )}
            {/* npm advisory ID link if no URL but has advisoryId */}
            {!item.url && item.advisoryId && (
              <div className="col-span-2">
                <span className="text-zinc-500">Advisory:</span>
                <a
                  href={`https://www.npmjs.com/advisories/${item.advisoryId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="ml-2 inline-flex items-center gap-1 text-blue-400 hover:text-blue-300"
                >
                  npm Advisory #{item.advisoryId} <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SeverityBadge({ type, severity }: { type: string; severity: string }) {
  if (type === 'vulnerability') {
    const styles: Record<string, string> = {
      critical: 'bg-red-500/20 text-red-400 border-red-500/50',
      high: 'bg-orange-500/20 text-orange-400 border-orange-500/50',
      moderate: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/50',
      low: 'bg-blue-500/20 text-blue-400 border-blue-500/50',
      info: 'bg-zinc-500/20 text-zinc-400 border-zinc-500/50',
    };
    return (
      <Badge variant="outline" className={cn('text-xs uppercase w-20 justify-center', styles[severity])}>
        {severity}
      </Badge>
    );
  }

  // Outdated
  const styles: Record<string, string> = {
    major: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/50',
    minor: 'bg-blue-500/20 text-blue-400 border-blue-500/50',
    patch: 'bg-zinc-500/20 text-zinc-400 border-zinc-500/50',
  };
  return (
    <Badge variant="outline" className={cn('text-xs uppercase w-20 justify-center', styles[severity])}>
      {severity}
    </Badge>
  );
}
