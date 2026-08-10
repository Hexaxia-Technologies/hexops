'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { PatchesSidebar, type UpdateResult, type UpdateStatus } from '@/components/patches-sidebar';
import { RefreshCw, Shield, Package, ArrowUp, List, FolderTree, ChevronDown, ChevronRight, AlertTriangle, Link as LinkIcon, PauseCircle, PlayCircle, ExternalLink, HelpCircle, Wrench, Siren, TrendingUp, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import type { PatchQueueItem, PatchSummary } from '@/lib/types';
import type { Finding } from '@/lib/security/types';
import { DependabotPanel } from '@/components/detail-sections/dependabot-panel';
import { EscalateModal } from '@/components/escalate-modal';
import { AcceptedRiskPanel } from '@/components/accepted-risk-panel';
import { ActiveOverridesPanel, type ProjectOverride } from '@/components/active-overrides-panel';
import { generatePatchCommitMessage, type UpdatedPackage } from '@/lib/patch-commit-message';
import { AUTO_APPLY_ENABLED, FIX_VIA_OVERRIDE_ENABLED } from '@/lib/auto-apply-flag';
import { GitCommit, Upload, Pencil, X, Download } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';

interface PatchesData {
  queue: PatchQueueItem[];
  summary: PatchSummary;
  lastScan: string | null;
  projectCount: number;
  categories: string[];
  projectCategories: Record<string, string>;  // projectId -> category
  projectNames: Record<string, string>;  // projectId -> name
  activeOverrides?: ProjectOverride[];
}

type FilterType = 'all' | 'vulns' | 'outdated';
type ViewMode = 'flat' | 'grouped';

// localStorage persistence
const PREFS_KEY = 'hexops-patches-preferences';

interface PatchesPreferences {
  viewMode: ViewMode;
  showHeld: boolean;
}

const DEFAULT_PREFS: PatchesPreferences = {
  viewMode: 'grouped',  // Default to grouped view
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
  const updatingRef = useRef(false);
  const [filter, setFilter] = useState<FilterType>('all');
  const [viewMode, setViewMode] = useState<ViewMode>(DEFAULT_PREFS.viewMode);
  const [selectedPackages, setSelectedPackages] = useState<Set<string>>(new Set());
  const [updating, setUpdating] = useState(false);
  const [selectedCategory] = useState<string | null>(null);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [recentUpdates, setRecentUpdates] = useState<UpdateResult[]>([]);
  // showUnfixable removed — all vulnerabilities are now actionable
  const [showHeld, setShowHeld] = useState(DEFAULT_PREFS.showHeld);
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  // Per-project git state for commit/push flow
  const [projectGitStates, setProjectGitStates] = useState<Record<string, ProjectGitState>>({});
  const [scanProgress, setScanProgress] = useState<{ scanned: number; total: number; currentProject: string } | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const [resolvingProjects, setResolvingProjects] = useState<Set<string>>(new Set());
  const [postPatchAudit, setPostPatchAudit] = useState<Record<string, { vulnCount: number; criticalCount: number; remainingAdvisories: string[] }>>({});
  const [dependabotMap, setDependabotMap] = useState<Record<string, boolean>>({});
  const [escalateItem, setEscalateItem] = useState<PatchQueueItem | null>(null);
  const [escalateModalOpen, setEscalateModalOpen] = useState(false);
  const [expandOverridesPanel, setExpandOverridesPanel] = useState(false);
  const [fixingOverrides, setFixingOverrides] = useState<Set<string>>(new Set());
  const [validating, setValidating] = useState(false);
  const [validationResult, setValidationResult] = useState<{ passed: boolean; output: string; projectId: string } | null>(null);
  const [validationPhase, setValidationPhase] = useState<string | null>(null);

  const handleEscalate = useCallback((item: PatchQueueItem) => {
    setEscalateItem(item);
    setEscalateModalOpen(true);
  }, []);

  const handleValidate = useCallback(async () => {
    if (!data || selectedPackages.size === 0) return;
    const selectedItems = (data.queue ?? []).filter((item) => selectedPackages.has(getItemKey(item)));
    if (selectedItems.length === 0) return;

    // Pick the first project — validation is per-project
    const projectId = selectedItems[0].projectId;
    const packages = selectedItems
      .filter((i) => i.projectId === projectId && i.targetVersion)
      .map((i) => ({ name: i.package, fromVersion: i.currentVersion, toVersion: i.targetVersion! }));

    if (packages.length === 0) return;

    setValidating(true);
    setValidationResult(null);
    setValidationPhase('starting');

    try {
      const res = await fetch(`/api/projects/${projectId}/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packages }),
      });

      if (!res.body) throw new Error('No response body');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';
        for (const block of events) {
          const lines = block.split('\n');
          const eventLine = lines.find((l) => l.startsWith('event: '));
          const dataLine = lines.find((l) => l.startsWith('data: '));
          if (!eventLine || !dataLine) continue;
          const eventType = eventLine.slice(7);
          const payload = JSON.parse(dataLine.slice(6));
          if (eventType === 'progress') {
            setValidationPhase(payload.message ?? payload.phase);
          } else if (eventType === 'complete') {
            setValidationResult({ passed: payload.buildPassed, output: payload.buildOutput, projectId });
            setValidationPhase(null);
          } else if (eventType === 'error') {
            setValidationResult({ passed: false, output: payload.message ?? 'Unknown error', projectId });
            setValidationPhase(null);
          }
        }
      }
    } catch (err) {
      toast.error('Validation failed', { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setValidating(false);
      setValidationPhase(null);
    }
  }, [data, selectedPackages]);

  const fetchPatches = useCallback((bustCache = false) => {
    // Close any existing connection
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    const params = new URLSearchParams();
    if (bustCache) {
      params.set('force', '1');
      params.set('t', Date.now().toString());
    }
    const url = `/api/patches/stream${params.toString() ? `?${params}` : ''}`;
    const es = new EventSource(url);
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);

        if (parsed.type === 'progress') {
          setScanProgress({
            scanned: parsed.scanned,
            total: parsed.total,
            currentProject: parsed.projectName,
          });
        }

        if (parsed.type === 'complete') {
          setData(parsed);
          const projectIds = new Set<string>(
            parsed.queue.map((item: PatchQueueItem) => item.projectId)
          );
          setExpandedProjects(projectIds);
          setScanProgress(null);
          setLoading(false);
          setScanning(false);
          es.close();
          eventSourceRef.current = null;
        }

        if (parsed.type === 'error') {
          toast.error(parsed.message || 'Failed to load patch data');
          setScanProgress(null);
          setLoading(false);
          setScanning(false);
          es.close();
          eventSourceRef.current = null;
        }
      } catch {
        // Ignore parse errors
      }
    };

    es.onerror = () => {
      // EventSource fires error on normal close; only show toast if no data loaded yet
      setScanProgress(null);
      setLoading(false);
      es.close();
      eventSourceRef.current = null;
    };
  }, []);

  const handleEscalateSuccess = useCallback(() => {
    setEscalateModalOpen(false);
    setEscalateItem(null);
    fetchPatches(true);
  }, [fetchPatches]);

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
    // Skip refetch if an update is in progress (prevents HMR re-mount
    // from replacing patch data mid-update with partially-scanned results)
    if (updatingRef.current) return;
    fetchPatches();
    fetchHistory();
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [fetchPatches, fetchHistory]);

  // Load preferences from localStorage on mount
  useEffect(() => {
    const prefs = loadPreferences();
    setViewMode(prefs.viewMode);
    setShowHeld(prefs.showHeld);
    setPrefsLoaded(true);
  }, []);

  // Save preferences when they change (after initial load)
  useEffect(() => {
    if (prefsLoaded) {
      savePreferences({ viewMode, showHeld });
    }
  }, [viewMode, showHeld, prefsLoaded]);

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

  // Fetch dependabot status for all projects once data loads
  useEffect(() => {
    if (!data) return;
    const projectIds = Object.keys(data.projectNames);
    if (!projectIds.length) return;
    Promise.all(
      projectIds.map((id) =>
        fetch(`/api/projects/${id}/dependabot`)
          .then((r) => r.json())
          .then((result) => [id, result.managed] as const)
          .catch(() => [id, false] as const)
      )
    ).then((results) => {
      setDependabotMap(Object.fromEntries(results));
    });
  }, [data]);

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
        // Scope this commit to dependency files (package.json + whatever
        // lockfile the project actually has) so an unrelated in-progress
        // change in the working tree doesn't get swept into — and
        // auto-deployed by — a dependency-patch commit. The server resolves
        // the concrete file set; the browser doesn't know the project's
        // filesystem layout.
        body: JSON.stringify({ message: state.pendingCommit.message, scope: 'dependencies' }),
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

  const handleScan = () => {
    const count = data?.projectCount;
    toast.info(`Cache cleared — rescanning ${count ? `${count} projects` : 'all projects'}…`, { duration: 3000 });
    setScanning(true);
    setLoading(true);
    fetchPatches(true);
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
  // Count override items (transitive deps fixed via package manager override)
  const overrideCount = useMemo(() => {
    if (!data) return 0;
    return data.queue.filter(
      item => item.fixViaOverride === true
    ).length;
  }, [data]);

  // Count breaking updates
  const breakingCount = useMemo(() => {
    if (!data) return 0;
    return data.queue.filter(
      item => item.isBreakingFix === true
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
  }, [data, filter, selectedCategory, showHeld]);

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
      item => item.projectId === projectId && !item.isHeld
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
      item => item.projectId === projectId && !item.isHeld
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
      item => !item.isHeld
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
      // Refresh data to update hold status (no force — config change is immediate)
      fetchPatches();
    } catch {
      toast.error(`Failed to ${hold ? 'hold' : 'release'} package`);
    }
  };

  const handleFixOverride = async (item: PatchQueueItem) => {
    const key = getItemKey(item);
    setFixingOverrides(prev => new Set(prev).add(key));
    try {
      const removeRes = await fetch(`/api/projects/${item.projectId}/override-remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ package: item.package }),
      });
      if (!removeRes.ok && removeRes.status !== 404) {
        const data = await removeRes.json();
        toast.error(data.error || 'Failed to remove override');
        return;
      }
      const updateRes = await fetch(`/api/projects/${item.projectId}/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          packages: [{
            name: item.package,
            toVersion: item.targetVersion,
            fromVersion: item.currentVersion,
            fixViaOverride: item.fixViaOverride,
            fixByParent: item.fixByParent,
          }],
        }),
      });
      if (!updateRes.ok) {
        const data = await updateRes.json();
        toast.error(data.error || 'Failed to apply patch');
        return;
      }
      toast.success(`Fixed ${item.package} — patch applied`);
      fetchPatches(true);
    } catch {
      toast.error('Failed to fix override');
    } finally {
      setFixingOverrides(prev => { const next = new Set(prev); next.delete(key); return next; });
    }
  };

  const handleBatchHold = useCallback(async (hold: boolean) => {
    if (!data || selectedPackages.size === 0) return;
    const selectedItems = (data.queue ?? []).filter((item) => selectedPackages.has(getItemKey(item)));
    if (selectedItems.length === 0) return;

    // Group by projectId
    const byProject = new Map<string, string[]>();
    for (const item of selectedItems) {
      if (!byProject.has(item.projectId)) byProject.set(item.projectId, []);
      byProject.get(item.projectId)!.push(item.package);
    }

    await Promise.all(
      Array.from(byProject.entries()).flatMap(([projectId, pkgNames]) =>
        pkgNames.map((pkg) => handleHold(projectId, pkg, hold))
      )
    );
  }, [data, selectedPackages, handleHold]);

  const handleResolveLockfile = async (projectId: string) => {
    setResolvingProjects(prev => new Set(prev).add(projectId));
    try {
      const res = await fetch(`/api/projects/${projectId}/resolve-lockfile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const result = await res.json();
      if (result.success) {
        toast.success(`Lock file resolved (${result.mode}) — ${result.packageManager} via ${result.detectedVia}`);
        // Rescan to update package info after resolution
        fetchPatches(true);
      } else {
        toast.error(`Lock file resolution failed: ${result.error ?? 'Unknown error'}`);
      }
    } catch (err) {
      toast.error('Failed to resolve lock file');
    } finally {
      setResolvingProjects(prev => {
        const next = new Set(prev);
        next.delete(projectId);
        return next;
      });
    }
  };

  const handleUpdateSelected = async () => {
    if (!data || selectedPackages.size === 0) return;

    setUpdating(true);
    updatingRef.current = true;
    const selectedItems = filteredQueue.filter(
      item => selectedPackages.has(getItemKey(item))
    );

    // Group by project for batch updates
    const updatesByProject = new Map<string, { name: string; projectName: string; toVersion: string; fromVersion: string; fixViaOverride?: boolean; fixByParent?: { name: string; version: string } }[]>();

    for (const item of selectedItems) {
      if (!updatesByProject.has(item.projectId)) {
        updatesByProject.set(item.projectId, []);
      }
      updatesByProject.get(item.projectId)!.push({
        name: item.package,
        projectName: item.projectName,
        toVersion: item.targetVersion,
        fromVersion: item.currentVersion,
        fixViaOverride: item.fixViaOverride,
        fixByParent: item.fixByParent,
      });
    }

    const totalUpdates = updatesByProject.size;
    let completedUpdates = 0;

    setUpdateStatus({
      isUpdating: true,
      progress: 0,
      total: totalUpdates,
    });

    const newResults: UpdateResult[] = [];
    const auditSummaryByProject: Record<string, { vulnCount: number; criticalCount: number; remainingAdvisories: string[] }> = {};

    for (const [projectId, packages] of updatesByProject) {
      const projectName = packages[0]?.projectName || projectId;

      setUpdateStatus({
        isUpdating: true,
        currentProject: projectName,
        currentPackage: packages.length === 1 ? packages[0].name : `${packages.length} packages`,
        progress: completedUpdates,
        total: totalUpdates,
      });

      try {
        const res = await fetch(`/api/projects/${projectId}/update`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ packages }),
        });
        const result = await res.json();

        if (result.auditSummary) {
          auditSummaryByProject[projectId] = result.auditSummary;
        }

        // Use per-package results from backend; fall back to top-level success if absent
        const pkgResults: Array<{ package: string; success: boolean; error?: string }> =
          Array.isArray(result.results) && result.results.length > 0
            ? result.results
            : packages.map(p => ({ package: p.name, success: result.success, error: result.error }));

        for (const r of pkgResults) {
          const pkg = packages.find(p => p.name === r.package);
          newResults.unshift({
            projectId,
            projectName,
            packageName: r.package,
            fromVersion: pkg?.fromVersion ?? '',
            toVersion: pkg?.toVersion ?? '',
            success: r.success,
            error: r.error,
            timestamp: new Date(),
          });
        }
      } catch {
        for (const pkg of packages) {
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
      }

      completedUpdates += 1;
    }

    setUpdateStatus(null);
    setUpdating(false);
    updatingRef.current = false;
    setSelectedPackages(new Set());
    setRecentUpdates(prev => [...newResults, ...prev].slice(0, 20));
    setPostPatchAudit(auditSummaryByProject);

    const successCount = newResults.filter(r => r.success).length;
    const failCount = newResults.filter(r => !r.success).length;
    const totalRemaining = Object.values(auditSummaryByProject).reduce((s, a) => s + a.vulnCount, 0);

    if (failCount === 0 && totalRemaining === 0) {
      toast.success(`Updated ${successCount} package(s) — all advisories cleared`);
    } else if (failCount === 0 && totalRemaining > 0) {
      toast.warning(`Updated ${successCount} package(s) — ${totalRemaining} vuln${totalRemaining !== 1 ? 's' : ''} still remain`);
    } else if (failCount === 0) {
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

    // Refresh data — the update route already rescanned the affected project(s),
    // so a normal fetch (no force) will pick up the fresh cache without rescanning all 24
    fetchPatches();
  };

  // Get unique project count from queue
  const uniqueProjectIds = useMemo(() => {
    if (!data) return new Set<string>();
    return new Set(data.queue.map(item => item.projectId));
  }, [data]);

  if (loading) {
    return (
      <main className="flex-1 flex items-center justify-center" suppressHydrationWarning>
        <div className="text-center space-y-3" suppressHydrationWarning>
          <div className="text-zinc-400 text-sm" suppressHydrationWarning>
            {scanProgress
              ? `Scanning projects\u2026 ${scanProgress.scanned} / ${scanProgress.total}`
              : 'Loading patch data\u2026'}
          </div>
          {scanProgress && (
            <>
              <div className="w-64 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-purple-500 rounded-full transition-all duration-300 ease-out"
                  style={{ width: `${(scanProgress.scanned / scanProgress.total) * 100}%` }}
                />
              </div>
              <div className="text-zinc-600 text-xs">{scanProgress.currentProject}</div>
            </>
          )}
        </div>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="flex-1 flex items-center justify-center">
        <div className="text-red-400">Failed to load patch data</div>
      </main>
    );
  }

  const { summary } = data;
  const totalIssues = summary.critical + summary.high + summary.moderate +
    summary.outdatedMajor + summary.outdatedMinor + summary.outdatedPatch;

  return (
    <>
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
              <Link href="/patches/trends">
                <Button variant="ghost" size="sm" className="border-zinc-700 text-zinc-400">
                  <TrendingUp className="h-4 w-4 mr-2" />
                  Trends
                </Button>
              </Link>
              <Button
                variant="outline"
                size="sm"
                className="border-zinc-700 text-zinc-400"
                onClick={() => window.open('/api/patches/export?format=csv', '_blank')}
                title="Export patch history as CSV"
              >
                <Download className="h-4 w-4 mr-2" />
                Export
              </Button>
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
            {(summary.high + summary.moderate) > 0 && (
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-orange-500" />
                <span className="text-sm text-orange-400">{summary.high + summary.moderate} high/moderate</span>
              </div>
            )}
            {(summary.outdatedMajor + summary.outdatedMinor + summary.outdatedPatch) > 0 && (
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-yellow-500" />
                <span className="text-sm text-yellow-400">
                  {summary.outdatedMajor + summary.outdatedMinor + summary.outdatedPatch} outdated
                </span>
              </div>
            )}
            {totalIssues === 0 && (
              <span className="text-sm text-green-400">All packages up to date!</span>
            )}
          </div>
        </div>

        {/* Post-patch audit summary */}
        {Object.keys(postPatchAudit).length > 0 && (
          <div className="mx-6 mt-3 rounded-md border border-zinc-700 bg-zinc-900 p-3 text-xs space-y-1">
            <div className="flex items-center justify-between">
              <span className="font-medium text-zinc-300">Post-patch audit</span>
              <button onClick={() => setPostPatchAudit({})} className="text-zinc-600 hover:text-zinc-400">✕</button>
            </div>
            {Object.entries(postPatchAudit).map(([pid, audit]) => {
              const proj = data.queue.find(q => q.projectId === pid);
              const name = proj?.projectName ?? pid;
              return (
                <div key={pid} className={audit.vulnCount === 0 ? 'text-green-400' : 'text-orange-400'}>
                  {name}: {audit.vulnCount === 0
                    ? '✓ all advisories cleared'
                    : `${audit.vulnCount} vuln${audit.vulnCount !== 1 ? 's' : ''} remain (${audit.remainingAdvisories.slice(0, 3).join(', ')}${audit.remainingAdvisories.length > 3 ? '…' : ''})`}
                </div>
              );
            })}
          </div>
        )}

        {/* Active Overrides Panel */}
        {data.activeOverrides && data.activeOverrides.length > 0 && (
          <ActiveOverridesPanel
            overrides={data.activeOverrides}
            onRemoved={() => fetchPatches(true)}
            forceExpand={expandOverridesPanel}
          />
        )}

        {/* Filters & Actions — two rows */}
        <div className="border-b border-zinc-800 px-6 py-2 space-y-1.5">
          {/* Row 1: Type + View */}
          <div className="flex items-center gap-4">
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
          </div>

          {/* Row 2: badges + selection actions */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {overrideCount > 0 && (
                <span className="text-xs text-blue-400" title="Transitive dependencies that will be fixed via package manager override">
                  {overrideCount} override{overrideCount !== 1 ? 's' : ''}
                </span>
              )}
              {breakingCount > 0 && (
                <>
                  {overrideCount > 0 && <div className="h-3.5 w-px bg-zinc-700" />}
                  <span className="text-xs text-orange-400" title="Updates that require a semver-major version change">
                    {breakingCount} breaking
                  </span>
                </>
              )}
              {heldCount > 0 && (
                <>
                  {(overrideCount > 0 || breakingCount > 0) && <div className="h-3.5 w-px bg-zinc-700" />}
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
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs border-zinc-600 text-zinc-300 hover:bg-zinc-800"
                  onClick={handleValidate}
                  disabled={validating || updating}
                  title="Run build validation in a worktree before applying"
                >
                  <Wrench className={cn('h-3 w-3 mr-1', validating && 'animate-spin')} />
                  {validating ? (validationPhase ?? 'Validating…') : 'Validate'}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs border-zinc-600 text-zinc-400 hover:bg-zinc-800"
                  onClick={() => handleBatchHold(true)}
                  disabled={updating}
                  title="Hold all selected packages"
                >
                  <PauseCircle className="h-3 w-3 mr-1" />
                  Hold All
                </Button>
                {AUTO_APPLY_ENABLED && (
                  <Button
                    size="sm"
                    className="h-7 text-xs bg-purple-600 hover:bg-purple-700"
                    onClick={handleUpdateSelected}
                    disabled={updating}
                  >
                    <ArrowUp className={cn('h-3 w-3 mr-1', updating && 'animate-bounce')} />
                    {updating ? 'Updating...' : 'Update Selected'}
                  </Button>
                )}
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
        </div>

        {/* Validation result banner */}
        {validationResult && (
          <div className={cn(
            'mx-6 mt-4 rounded-lg border px-4 py-3',
            validationResult.passed
              ? 'border-green-500/20 bg-green-500/5'
              : 'border-red-500/20 bg-red-500/5'
          )}>
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className={validationResult.passed ? 'text-green-400' : 'text-red-400'}>
                  {validationResult.passed ? '✓' : '✗'}
                </span>
                <span className={cn('text-sm font-medium', validationResult.passed ? 'text-green-300' : 'text-red-300')}>
                  Build validation {validationResult.passed ? 'passed' : 'failed'}
                </span>
              </div>
              <button
                onClick={() => setValidationResult(null)}
                className="text-zinc-500 hover:text-zinc-300 text-xs"
              >
                dismiss
              </button>
            </div>
            {!validationResult.passed && validationResult.output && (
              <pre className="mt-2 text-xs text-red-300/80 font-mono max-h-32 overflow-auto whitespace-pre-wrap">
                {validationResult.output.slice(-1500)}
              </pre>
            )}
          </div>
        )}

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
                    onEscalate={handleEscalate}
                    onExpandOverrides={() => setExpandOverridesPanel(true)}
                    onFixOverride={handleFixOverride}
                    isFixingOverride={fixingOverrides.has(key)}
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
                        onClick={() => (group.patches.length > 0 || dependabotMap[group.projectId]) && toggleProjectExpanded(group.projectId)}
                      >
                        {group.patches.length > 0 || dependabotMap[group.projectId] ? (
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
                        {dependabotMap[group.projectId] ? (
                          <div className="flex items-center gap-1.5">
                            <Badge variant="outline" className="text-xs border-orange-500/30 text-orange-400 bg-orange-500/10">
                              Dependabot
                            </Badge>
                            {group.patches.filter(p => p.type === 'vulnerability' && p.fixAvailable !== false && (p.fixViaOverride || p.isDirect)).length > 0 && (
                              <Badge variant="outline" className="text-xs border-red-500/30 text-red-400 bg-red-500/10">
                                {group.patches.filter(p => p.type === 'vulnerability' && p.fixAvailable !== false && (p.fixViaOverride || p.isDirect)).length} CVE{group.patches.filter(p => p.type === 'vulnerability' && p.fixAvailable !== false && (p.fixViaOverride || p.isDirect)).length !== 1 ? 's' : ''} urgent
                              </Badge>
                            )}
                          </div>
                        ) : group.patches.length > 0 ? (
                          <Badge variant="outline" className="text-xs border-zinc-700 text-zinc-500">
                            {group.patches.length} update{group.patches.length !== 1 ? 's' : ''}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-xs border-green-500/30 text-green-400 bg-green-500/10">
                            ✓ All patched
                          </Badge>
                        )}
                      </button>
                      {/* Select All / Deselect All - show for non-Dependabot projects, or Dependabot projects with urgent CVEs */}
                      {group.patches.length > 0 && (!dependabotMap[group.projectId] || group.patches.some(p => p.type === 'vulnerability' && p.fixAvailable !== false && (p.fixViaOverride || p.isDirect))) && (
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
                    {/* Right side: resolve + git controls */}
                    <div className="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs text-amber-400 hover:text-amber-300 hover:bg-amber-500/10"
                        onClick={(e) => { e.stopPropagation(); handleResolveLockfile(group.projectId); }}
                        disabled={resolvingProjects.has(group.projectId)}
                        title="Resolve lock file before patching"
                      >
                        <Wrench className={cn('h-3 w-3 mr-1', resolvingProjects.has(group.projectId) && 'animate-spin')} />
                        {resolvingProjects.has(group.projectId) ? 'Resolving...' : 'Resolve Lock'}
                      </Button>
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
                              {gitState?.isPushing ? 'Pushing...' : ahead > 0 ? `Push (${ahead})` : 'Push'}
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
                    dependabotMap[group.projectId] ? (
                      <div className="rounded-lg border border-orange-500/20 bg-orange-500/5 p-1 m-2">
                        <div className="flex items-center gap-2 px-3 py-2 border-b border-orange-500/10">
                          <span className="text-xs font-medium text-orange-400">Dependabot Managed</span>
                          <span className="text-xs text-zinc-500">— routine updates deferred to Dependabot</span>
                        </div>
                        <DependabotPanel projectId={group.projectId} />
                        {/* CVEs requiring immediate action — Dependabot can't fix these on its schedule */}
                        {group.patches.filter(p => p.type === 'vulnerability' && p.fixAvailable !== false && (p.fixViaOverride || p.isDirect)).length > 0 && (
                          <div className="border-t border-red-500/20">
                            <div className="flex items-center gap-2 px-3 py-2 bg-red-500/5">
                              <span className="text-xs font-medium text-red-400">CVEs requiring immediate action</span>
                              <span className="text-xs text-zinc-500">— {group.patches.some(p => p.fixViaOverride) ? 'Dependabot cannot fix transitive overrides' : 'patch now without waiting for Monday'}</span>
                            </div>
                            {group.patches.filter(p => p.type === 'vulnerability' && p.fixAvailable !== false && (p.fixViaOverride || p.isDirect)).map((item) => {
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
                                  onEscalate={handleEscalate}
                                  onExpandOverrides={() => setExpandOverridesPanel(true)}
                                  onFixOverride={handleFixOverride}
                                  isFixingOverride={fixingOverrides.has(key)}
                                />
                              );
                            })}
                          </div>
                        )}
                        {/* Show escalation rows for fixAvailable: false items */}
                        {group.patches.filter(p => p.fixAvailable === false).map((item) => (
                          <div key={getItemKey(item)} className="px-3 py-2 border-t border-orange-500/10">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <SeverityBadge type={item.type} severity={item.severity} />
                                <span className="font-mono text-sm text-zinc-300">{item.package}</span>
                                {item.escalationStatus === 'accepted_risk_expired' && (
                                  <Badge variant="outline" className="text-xs bg-red-500/10 border-red-500/30 text-red-400">Expired</Badge>
                                )}
                              </div>
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 text-xs border-amber-500/30 text-amber-400 hover:bg-amber-500/10 hover:text-amber-300"
                                onClick={() => handleEscalate(item)}
                              >
                                <Siren className="h-3 w-3 mr-1" />
                                Escalate
                              </Button>
                            </div>
                          </div>
                        ))}
                        {/* Accepted Risk Panel for Dependabot projects */}
                        <AcceptedRiskPanel
                          projectId={group.projectId}
                          items={group.patches.filter(p =>
                            p.escalationStatus === 'accepted_risk' ||
                            p.escalationStatus === 'accepted_risk_expired'
                          )}
                          onReverse={(_item: PatchQueueItem) => fetchPatches(true)}
                        />
                      </div>
                    ) : (
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
                              onEscalate={handleEscalate}
                              onExpandOverrides={() => setExpandOverridesPanel(true)}
                              onFixOverride={handleFixOverride}
                              isFixingOverride={fixingOverrides.has(key)}
                            />
                          );
                        })}
                        {/* Pending Major Bump banners */}
                        {group.patches.filter(p => p.escalationStatus === 'force_major_pending').map(item => (
                          <div key={`major-banner-${getItemKey(item)}`} className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 flex items-center justify-between">
                            <div className="flex items-center gap-2 text-sm">
                              <AlertTriangle className="h-4 w-4 text-amber-400" />
                              <span className="text-amber-300 font-medium">Pending Major Bump:</span>
                              <span className="font-mono text-zinc-300">{item.package}</span>
                              {item.currentVersion && item.targetVersion && (
                                <span className="text-zinc-500 text-xs">{item.currentVersion} → {item.targetVersion}</span>
                              )}
                            </div>
                            <Link
                              href={`/projects/${group.projectId}`}
                              className="text-xs text-amber-400 hover:text-amber-300 underline"
                              onClick={(e) => e.stopPropagation()}
                            >
                              Review & Commit →
                            </Link>
                          </div>
                        ))}
                        {/* Accepted Risk Panel */}
                        <AcceptedRiskPanel
                          projectId={group.projectId}
                          items={group.patches.filter(p =>
                            p.escalationStatus === 'accepted_risk' ||
                            p.escalationStatus === 'accepted_risk_expired'
                          )}
                          onReverse={(_item: PatchQueueItem) => fetchPatches(true)}
                        />
                      </div>
                    )
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

      {escalateItem && (
        <EscalateModal
          item={escalateItem}
          open={escalateModalOpen}
          onClose={() => { setEscalateModalOpen(false); setEscalateItem(null); }}
          onSuccess={handleEscalateSuccess}
        />
      )}
    </>
  );
}

interface PatchRowProps {
  item: PatchQueueItem;
  itemKey: string;
  isSelected: boolean;
  onToggle: (key: string) => void;
  onHold: (projectId: string, packageName: string, hold: boolean) => void;
  showProject: boolean;
  onEscalate?: (item: PatchQueueItem) => void;
  onExpandOverrides?: () => void;
  onFixOverride?: (item: PatchQueueItem) => void;
  isFixingOverride?: boolean;
}

function PatchRow({ item, itemKey, isSelected, onToggle, onHold, showProject, onEscalate, onExpandOverrides, onFixOverride, isFixingOverride }: PatchRowProps) {
  const [showDetails, setShowDetails] = useState(false);
  const [cveLiteFindings, setCveLiteFindings] = useState<Finding[] | null>(null);
  const isTransitive = item.isDirect === false;
  const isHeld = item.isHeld === true;
  const isDisabled = isHeld;

  const handleHoldClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onHold(item.projectId, item.package, !isHeld);
  };

  const handleInfoClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    const next = !showDetails;
    setShowDetails(next);
    if (next && item.type === 'vulnerability' && cveLiteFindings === null) {
      fetch(`/api/security/findings?project=${encodeURIComponent(item.projectId)}`)
        .then(r => r.json())
        .then(data => {
          const proj = (data.projects ?? []).find(
            (p: { projectId: string }) => p.projectId === item.projectId
          );
          setCveLiteFindings(proj?.findings ?? []);
        })
        .catch(() => setCveLiteFindings([]));
    }
  };

  return (
    <div className="rounded-lg border transition-colors overflow-hidden"
      style={{
        backgroundColor: isHeld ? 'rgba(24, 24, 27, 0.5)' : isSelected ? 'rgba(168, 85, 247, 0.1)' : 'rgb(24, 24, 27)',
        borderColor: isHeld ? 'rgba(39, 39, 42, 0.5)' : isSelected ? 'rgba(168, 85, 247, 0.3)' : 'rgb(39, 39, 42)',
        opacity: isHeld ? 0.6 : 1,
      }}
    >
      <div
        className={cn(
          'flex items-center gap-4 p-4 cursor-pointer',
          !isHeld && !isSelected && 'hover:bg-zinc-800/50'
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
                  {item.targetVersion === 'resolve-latest' ? 'latest' : item.targetVersion}
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
            {item.fixViaOverride && !isHeld && (
              <Badge variant="outline" className="text-xs bg-blue-500/10 border-blue-500/30 text-blue-400">
                Override
              </Badge>
            )}
            {item.isBreakingFix && !isHeld && (
              <Badge variant="outline" className="text-xs bg-orange-500/10 border-orange-500/30 text-orange-400">
                <AlertTriangle className="h-3 w-3 mr-1" />
                Breaking
              </Badge>
            )}
            {/* CVE badges */}
            {item.cves && item.cves.length > 0 && (
              <Badge variant="outline" className="text-xs bg-red-500/10 border-red-500/30 text-red-400">
                {item.cves.length} CVE{item.cves.length !== 1 ? 's' : ''}
              </Badge>
            )}
            {item.escalationStatus === 'force_override_pending' && (
              <Badge variant="outline" className="text-xs bg-amber-500/10 border-amber-500/30 text-amber-400">
                <Siren className="h-3 w-3 mr-1" />
                Escalated
              </Badge>
            )}
            {item.escalationStatus === 'accepted_risk_expired' && (
              <Badge variant="outline" className="text-xs bg-red-500/10 border-red-500/30 text-red-400">
                Expired
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
          {/* Fix strategy for transitive dependencies */}
          {isTransitive && item.fixByParent && !item.fixViaOverride && (
            <p className="text-xs text-green-400/70 mt-1">
              Fix: update {item.fixByParent.name} to {item.fixByParent.version}
            </p>
          )}
          {isTransitive && item.fixViaOverride && (
            <div className="flex items-center gap-2 mt-1">
              <span className="text-xs text-blue-400/70">
                Fix: package manager override{item.fixByParent ? ` (updating ${item.fixByParent.name} requires breaking change)` : ''}
              </span>
              {FIX_VIA_OVERRIDE_ENABLED && (
                <button
                  className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded border border-blue-500/30 bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 hover:text-blue-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  disabled={isFixingOverride}
                  onClick={(e) => {
                    e.stopPropagation();
                    onFixOverride?.(item);
                  }}
                >
                  {isFixingOverride ? (
                    <><Loader2 className="h-3 w-3 animate-spin" />fixing…</>
                  ) : (
                    <><Wrench className="h-3 w-3" />fix now</>
                  )}
                </button>
              )}
            </div>
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

        {/* Escalate button — shown for fixAvailable: false items */}
        {item.fixAvailable === false && !isHeld && onEscalate && (
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => { e.stopPropagation(); onEscalate(item); }}
            className="h-8 px-2 text-amber-500 hover:text-amber-300 hover:bg-amber-500/10"
            title="Escalate this vulnerability"
          >
            <Siren className="h-4 w-4" />
          </Button>
        )}

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
        <div className="border-t border-zinc-800 bg-zinc-950 px-4 py-3 space-y-3">
          {item.type === 'vulnerability' && (() => {
            if (cveLiteFindings === null) return null;
            const matches = cveLiteFindings.filter(
              f => f.package === item.package && f.type === 'vulnerability'
            );
            if (matches.length === 0) return null;
            return (
              <div className="border border-zinc-800 rounded-md p-3 space-y-2 text-xs bg-zinc-900/40">
                <div className="flex items-center justify-between">
                  <span className="text-zinc-500 uppercase tracking-wider text-[10px]">CVE Lite analysis</span>
                  <a
                    href={`/security?project=${encodeURIComponent(item.projectId)}`}
                    onClick={(e) => e.stopPropagation()}
                    className="text-purple-400 hover:text-purple-300 text-[10px] flex items-center gap-1"
                  >
                    Full analysis in Security →
                  </a>
                </div>
                {matches.map((f) => (
                  <div key={f.dedupKey} className="space-y-1.5">
                    {f.remediation?.recommendedAction && (
                      <p className="text-zinc-300">{f.remediation.recommendedAction}</p>
                    )}
                    {f.title && (
                      <p className="text-zinc-500 border-l-2 border-zinc-700 pl-2">{f.title}</p>
                    )}
                    {f.remediation?.parentUpgrade && (
                      <p className="text-zinc-500 text-[10px]">
                        via <span className="text-purple-400">{f.remediation.parentUpgrade}</span>
                      </p>
                    )}
                    {f.advisoryIds && f.advisoryIds.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {f.advisoryIds.map(id => (
                          <span key={id} className="bg-purple-500/10 border border-purple-500/20 text-purple-400 px-1.5 py-0.5 rounded text-[10px] font-mono">
                            {id}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            );
          })()}
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
                    {item.fixAvailable
                      ? item.fixViaOverride
                        ? 'Yes (via override)'
                        : item.fixByParent
                        ? `Yes (update ${item.fixByParent.name})`
                        : 'Yes'
                      : 'No'}
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
