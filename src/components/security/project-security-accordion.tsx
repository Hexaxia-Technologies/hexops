'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { CveLiteOutput, ScanOptions } from '@/lib/security/sources/cve-lite';
import type { DbStatus } from '@/lib/security/cve-lite-db';
import type { FindingRow } from '@/lib/security/cve-lite-view';
import type { SourceResult, Finding } from '@/lib/security/types';
import { deriveParentPackage } from '@/lib/security/parent-package';
import { selectFixPlan, findingRows, deriveReachable } from '@/lib/security/cve-lite-view';
import { FixPlan } from '@/components/security/cve-lite/fix-plan';
import { CveLiteFindings } from '@/components/security/cve-lite/cve-lite-findings';
import { CveLiteToolbar } from '@/components/security/cve-lite/cve-lite-toolbar';
import { CveLiteScanControls } from '@/components/security/cve-lite/cve-lite-scan-controls';
import { CveLiteManage } from '@/components/security/cve-lite/cve-lite-manage';
import { OverrideHygienePanel } from '@/components/security/cve-lite/override-hygiene-panel';
import { ConfirmDialog } from '@/components/security/cve-lite/confirm-dialog';
import { PendingCommitBanner } from '@/components/security/cve-lite/pending-commit-banner';
import { CompletenessBanner } from '@/components/security/cve-lite/completeness-banner';
import { SourcePluginCards } from '@/components/security/source-plugin-cards';
import type { PluginCardEntry } from '@/lib/security/plugins/types';
import { AUTO_APPLY_ENABLED } from '@/lib/auto-apply-flag';
import type { UpdatedPackage } from '@/lib/patch-commit-message';
import { generatePatchCommitMessage } from '@/lib/patch-commit-message';
import { remediationFromRow, remediationFromRows } from '@/lib/security/remediation-commit';
import type { SecurityException } from '@/lib/security/exceptions';
import { ExceptionDialog } from '@/components/security/exception-dialog';
import type { FindingState } from '@/lib/security/finding-states';
import { RemediationPanel } from '@/components/security/remediation-panel';
import { RemediationDialog } from '@/components/security/remediation-dialog';
import type { RemediationDialogPhase } from '@/components/security/remediation-dialog';

interface ConfirmState { title: string; body: ReactNode; run: () => Promise<void> }
interface GitStatus { branch: string; ahead: number; behind: number; dirty: boolean }
interface PendingCommit {
  packages: UpdatedPackage[];
  advisories: string[];
  severity?: string;
  message: string;
  isEditing: boolean;
}

export interface ProjectSecurityAccordionProps {
  project: { id: string; name: string };
  sources: Record<string, SourceResult>;
  severity?: { critical: number; high: number; medium: number; low: number; info?: number };
  findings?: Finding[];
  findingStates?: Record<string, FindingState>;
  startsExpanded?: boolean;
  onAnyDataChanged?: () => void;
}

const SEVERITY_BADGE: Record<string, string> = {
  critical: 'border-red-500/30 text-red-400 bg-red-500/10',
  high: 'border-orange-500/30 text-orange-400 bg-orange-500/10',
  medium: 'border-yellow-500/30 text-yellow-400 bg-yellow-500/10',
  low: 'border-zinc-500/30 text-zinc-400 bg-zinc-500/10',
  info: 'border-zinc-700 text-zinc-500 bg-zinc-900/40',
};

// ─── Severity rank (local copy to avoid importing the full types SEVERITY_RANK) ───
const SEVERITY_RANK_LOCAL: Record<string, number> = {
  critical: 4, high: 3, medium: 2, moderate: 2, low: 1, info: 0,
};

// ─── Package grouping types ───────────────────────────────────────────────────

interface PackageGroup {
  key: string;
  package: string;
  version?: string;
  findings: Finding[];
  worstSeverity: string;
  severityCounts: { critical: number; high: number; medium: number; low: number; info: number };
  fixedIn?: string;
  sourcesUnion: string[];
  /** Present when all findings in this group share the same parent npm package. */
  parentPackage?: string;
  /** The originally-reported package (e.g. 'stdlib') when grouped by parent. */
  reportedPackage?: string;
}

function groupFindingsForDisplay(findings: Finding[]): PackageGroup[] {
  const map = new Map<string, PackageGroup>();
  for (const f of findings) {
    const pkg = f.package ?? f.title;
    const ver = f.version;
    const parent = deriveParentPackage(f);
    // Group by parent when derivable AND different from the reported package
    const useParent = parent && parent !== pkg;
    const key = useParent ? `parent:${parent}` : `${pkg}@${ver ?? '?'}`;
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        package: useParent ? parent! : pkg,
        version: useParent ? undefined : ver,
        findings: [],
        worstSeverity: 'info',
        severityCounts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
        fixedIn: undefined,
        sourcesUnion: [],
        parentPackage: useParent ? parent! : undefined,
        reportedPackage: useParent ? pkg : undefined,
      };
      map.set(key, g);
    }
    g.findings.push(f);
    const s = (f.severity ?? 'info').toLowerCase();
    if ((SEVERITY_RANK_LOCAL[s] ?? 0) > (SEVERITY_RANK_LOCAL[g.worstSeverity] ?? 0)) {
      g.worstSeverity = s;
    }
    if (s === 'critical' || s === 'high' || s === 'low' || s === 'info') {
      g.severityCounts[s as keyof typeof g.severityCounts]++;
    } else if (s === 'medium' || s === 'moderate') {
      g.severityCounts.medium++;
    }
    if (!g.fixedIn && f.fixedIn) g.fixedIn = f.fixedIn;
    for (const src of f.sources) {
      if (!g.sourcesUnion.includes(src)) g.sourcesUnion.push(src);
    }
  }
  return Array.from(map.values()).sort((a, b) => {
    const rb = SEVERITY_RANK_LOCAL[b.worstSeverity] ?? 0;
    const ra = SEVERITY_RANK_LOCAL[a.worstSeverity] ?? 0;
    if (ra !== rb) return rb - ra;
    if (b.findings.length !== a.findings.length) return b.findings.length - a.findings.length;
    return a.package.localeCompare(b.package);
  });
}

// ─── Hover text for native title attr (no HoverCard available) ───────────────

function buildHoverText(f: Finding): string {
  const parts: string[] = [];
  if (f.title) parts.push(f.title);
  if (f.detail && f.detail !== f.title) {
    parts.push(f.detail.slice(0, 400) + (f.detail.length > 400 ? '…' : ''));
  }
  if (f.cvss !== undefined) parts.push(`CVSS: ${f.cvss}`);
  if (f.references.length > 0) parts.push(`See: ${f.references.slice(0, 2).join(' · ')}`);
  return parts.join('\n\n');
}

// ─── relativeTime helper ──────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.round(d / 60)}m ago`;
  if (d < 86400) return `${Math.round(d / 3600)}h ago`;
  if (d < 604800) return `${Math.round(d / 86400)}d ago`;
  return `${Math.round(d / 604800)}w ago`;
}

// ─── FindingRow — individual CVE row ─────────────────────────────────────────

function FindingRow({ finding: f, findingState }: { finding: Finding; findingState?: FindingState }) {
  const sev = (f.severity ?? 'info').toLowerCase();
  const firstSeen = findingState?.firstSeenAt;
  const firstSeenLabel = firstSeen ? relativeTime(firstSeen) : undefined;
  const isNew = firstSeen && (Date.now() - new Date(firstSeen).getTime()) < 24 * 60 * 60 * 1000;
  return (
    <div className="flex items-center gap-2 bg-zinc-900/40 hover:bg-zinc-900/60 transition-colors px-3 py-2 rounded border border-zinc-800/60 text-xs">
      <span className={`shrink-0 px-1.5 py-0.5 rounded border ${SEVERITY_BADGE[sev] ?? SEVERITY_BADGE.info}`}>{sev}</span>
      <span className="text-zinc-200 font-medium truncate">{f.package ?? f.title}</span>
      {f.version && <span className="text-zinc-500 shrink-0">{f.version}</span>}
      {f.divergent && (
        <span className="shrink-0 px-1.5 py-0.5 rounded border border-amber-500/30 text-amber-400 bg-amber-500/10">
          divergent
        </span>
      )}
      <div className="ml-auto flex items-center gap-2 text-zinc-500 shrink-0">
        {f.advisoryIds.length > 0 && (
          <span
            title={buildHoverText(f)}
            className="truncate max-w-[280px] cursor-help"
          >
            {f.advisoryIds[0]}{f.advisoryIds.length > 1 ? ` +${f.advisoryIds.length - 1}` : ''}
          </span>
        )}
        <span className="opacity-75">{f.sources.join(' + ')}</span>
        {f.fixedIn && (
          <span className="shrink-0 px-1.5 py-0.5 rounded border border-cyan-500/30 text-cyan-300 bg-cyan-500/10 text-[0.7rem]">
            fix: {f.fixedIn}
          </span>
        )}
        {firstSeenLabel && (
          <span className="text-zinc-500 shrink-0 text-[0.7rem]">first seen {firstSeenLabel}</span>
        )}
        {isNew && (
          <span className="shrink-0 px-1.5 py-0.5 rounded border border-blue-500/30 text-blue-400 bg-blue-500/10 text-[0.7rem]">
            new
          </span>
        )}
      </div>
    </div>
  );
}

// ─── PackageRow — collapsible group for one package@version ──────────────────

function PackageRow({
  group,
  onFileException,
  findingStates,
  onOpenRemediation,
  onViewReferences,
  projectId,
}: {
  group: PackageGroup;
  onFileException?: (group: PackageGroup) => void;
  findingStates?: Record<string, FindingState>;
  onOpenRemediation?: (g: PackageGroup, mode: 'apply' | 'override') => void;
  onViewReferences?: (g: PackageGroup) => void;
  projectId?: string;
}) {
  const [open, setOpen] = useState(false);
  const total = group.findings.length;
  const bodyId = `pkg-${group.key}-body`;
  return (
    <div className="border border-zinc-800/60 rounded overflow-hidden">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen(x => !x)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen(x => !x);
          }
        }}
        className="w-full flex items-center gap-2 bg-zinc-900/40 hover:bg-zinc-900/60 transition-colors px-3 py-2 text-xs text-left cursor-pointer"
      >
        {open
          ? <ChevronDown className="h-3.5 w-3.5 text-zinc-500" />
          : <ChevronRight className="h-3.5 w-3.5 text-zinc-500" />
        }
        <span className={`shrink-0 px-1.5 py-0.5 rounded border ${SEVERITY_BADGE[group.worstSeverity] ?? SEVERITY_BADGE.info}`}>
          {group.worstSeverity}
        </span>
        {group.parentPackage ? (
          <>
            <span className="text-zinc-200 font-medium truncate">{group.parentPackage}</span>
            <span className="text-zinc-500 shrink-0 text-[0.7rem]">via {group.reportedPackage}</span>
          </>
        ) : (
          <>
            <span className="text-zinc-200 font-medium truncate">{group.package}</span>
            {group.version && <span className="text-zinc-500 shrink-0">{group.version}</span>}
          </>
        )}
        <div className="flex items-center gap-1 ml-2">
          {group.severityCounts.critical > 0 && (
            <span className="px-1.5 py-0.5 rounded border border-red-500/30 text-red-400 bg-red-500/10">
              {group.severityCounts.critical}c
            </span>
          )}
          {group.severityCounts.high > 0 && (
            <span className="px-1.5 py-0.5 rounded border border-orange-500/30 text-orange-400 bg-orange-500/10">
              {group.severityCounts.high}h
            </span>
          )}
          {group.severityCounts.medium > 0 && (
            <span className="px-1.5 py-0.5 rounded border border-yellow-500/30 text-yellow-400 bg-yellow-500/10">
              {group.severityCounts.medium}m
            </span>
          )}
          {group.severityCounts.low > 0 && (
            <span className="px-1.5 py-0.5 rounded border border-zinc-500/30 text-zinc-400 bg-zinc-500/10">
              {group.severityCounts.low}l
            </span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2 text-zinc-500 shrink-0">
          <span>{total} CVE{total !== 1 ? 's' : ''}</span>
          <span>·</span>
          <span className="opacity-75">{group.sourcesUnion.join(' + ')}</span>
          {group.fixedIn && (
            <span className="shrink-0 px-1.5 py-0.5 rounded border border-cyan-500/30 text-cyan-300 bg-cyan-500/10 text-xs">
              fix: {group.fixedIn}
            </span>
          )}
          {onFileException && group.parentPackage && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onFileException(group); }}
              className="ml-1 px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 transition-colors"
            >
              File exception
            </button>
          )}
        </div>
      </div>
      {open && (
        <div id={bodyId} className="border-t border-zinc-800/60 bg-zinc-950/30 px-3 py-2 space-y-1">
          {onOpenRemediation && projectId && (
            <RemediationPanel
              parentPackage={group.parentPackage}
              reportedPackage={group.reportedPackage ?? group.package}
              currentVersion={group.version}
              fixedIn={group.fixedIn}
              cveCount={group.findings.length}
              sources={group.sourcesUnion}
              references={Array.from(new Set(group.findings.flatMap(f => f.references)))}
              isParentEmbedded={!!group.parentPackage && group.parentPackage !== (group.reportedPackage ?? group.package)}
              projectId={projectId}
              onApplyFix={() => onOpenRemediation(group, 'apply')}
              onOverridePin={() => onOpenRemediation(group, 'override')}
              onViewReferences={() => onViewReferences?.(group)}
            />
          )}
          {group.findings.map(f => <FindingRow key={f.dedupKey} finding={f} findingState={findingStates?.[f.dedupKey]} />)}
        </div>
      )}
    </div>
  );
}

// ─── Classification badge styling ────────────────────────────────────────────

const CLASSIFICATION_BADGE: Record<string, string> = {
  'risk-accepted':        'border-amber-500/30 text-amber-400 bg-amber-500/10',
  'false-positive':       'border-blue-500/30 text-blue-400 bg-blue-500/10',
  'compensating-control': 'border-teal-500/30 text-teal-400 bg-teal-500/10',
  'deferred':             'border-zinc-500/30 text-zinc-400 bg-zinc-500/10',
  'unfixable':            'border-red-500/30 text-red-400 bg-red-500/10',
  'deviation':            'border-purple-500/30 text-purple-400 bg-purple-500/10',
};

// ─── ExceptionRow — click-to-expand with Edit + Revoke ───────────────────────

function ExceptionRow({
  exception,
  onRevoke,
  onEdit,
  busyRevoke,
  busyEdit,
}: {
  exception: SecurityException;
  onRevoke: (exc: SecurityException) => void;
  onEdit: (exc: SecurityException) => void;
  busyRevoke?: boolean;
  busyEdit?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const expiresLabel = exception.expiresAt
    ? `expires ${new Date(exception.expiresAt).toLocaleDateString()}`
    : 'no expiry';
  const detailsId = `exc-${exception.id}-details`;
  return (
    <div className="rounded border border-amber-700/40 bg-amber-950/10 overflow-hidden">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={() => setOpen(o => !o)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen(o => !o);
          }
        }}
        className="flex items-center gap-3 px-3 py-2 text-xs cursor-pointer hover:bg-amber-950/30 transition-colors"
      >
        {open
          ? <ChevronDown className="h-3.5 w-3.5 text-amber-400" />
          : <ChevronRight className="h-3.5 w-3.5 text-amber-400" />
        }
        <Badge variant="outline" className="text-[0.65rem] px-1.5 py-0 border-amber-500/40 text-amber-300 bg-amber-500/10">
          {exception.classification}
        </Badge>
        <span className="text-amber-100 font-medium truncate">{exception.parentPackage}</span>
        <span className="text-amber-400/70 text-[0.7rem] shrink-0">{expiresLabel}</span>
        <div className="ml-auto flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onEdit(exception); }}
            disabled={busyEdit}
            className="px-2 py-0.5 text-[0.7rem] rounded border border-amber-600/40 text-amber-200 hover:bg-amber-500/10 disabled:opacity-50"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onRevoke(exception); }}
            disabled={busyRevoke}
            className="px-2 py-0.5 text-[0.7rem] rounded border border-amber-600/40 text-amber-200 hover:bg-amber-500/10 disabled:opacity-50"
          >
            {busyRevoke ? '…' : 'Revoke'}
          </button>
        </div>
      </div>
      {open && (
        <div id={detailsId} className="border-t border-amber-700/30 px-3 py-2 text-xs space-y-1 text-amber-100/80 bg-amber-950/30">
          <div><span className="text-amber-400/70 mr-2">Reason:</span>{exception.reason}</div>
          {exception.notes && (
            <div><span className="text-amber-400/70 mr-2">Notes:</span>{exception.notes}</div>
          )}
          <div className="text-[0.7rem] text-amber-400/60 pt-1 border-t border-amber-700/20 mt-1.5">
            Filed by <span className="text-amber-300">{exception.createdBy}</span> at {new Date(exception.createdAt).toLocaleString()}
            {exception.expiresAt && <> · expires {new Date(exception.expiresAt).toLocaleString()}</>}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── ActiveExceptionsSection ──────────────────────────────────────────────────

function ActiveExceptionsSection({
  exceptions,
  onRevoke,
  onEdit,
}: {
  exceptions: SecurityException[];
  onRevoke: (exc: SecurityException) => void;
  onEdit: (exc: SecurityException) => void;
}) {
  return (
    <section className="mt-4 rounded-lg border border-amber-700/40 bg-amber-950/20 p-3">
      <h3 className="flex items-center gap-2 text-sm font-medium text-amber-200 mb-3">
        <AlertTriangle className="h-4 w-4" />
        Active exceptions ({exceptions.length})
      </h3>
      <div className="space-y-2">
        {exceptions.map(exc => (
          <ExceptionRow
            key={exc.id}
            exception={exc}
            onRevoke={onRevoke}
            onEdit={onEdit}
          />
        ))}
      </div>
    </section>
  );
}

// ─── Main accordion ───────────────────────────────────────────────────────────

export function ProjectSecurityAccordion({
  project,
  sources,
  severity,
  findings,
  findingStates = {},
  startsExpanded = false,
  onAnyDataChanged,
}: ProjectSecurityAccordionProps) {
  const [expanded, setExpanded] = useState(startsExpanded);
  const [loadedOnce, setLoadedOnce] = useState(false);

  // Exceptions state
  const [exceptions, setExceptions] = useState<SecurityException[]>([]);
  const [filingForGroup, setFilingForGroup] = useState<PackageGroup | null>(null);
  const [filingBusy, setFilingBusy] = useState(false);
  const [editingException, setEditingException] = useState<SecurityException | null>(null);
  const [editBusy, setEditBusy] = useState(false);

  // Per-project CVE Lite state
  const [report, setReport] = useState<CveLiteOutput | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importedOnly, setImportedOnly] = useState(false);
  const [scannedAt, setScannedAt] = useState<string | null>(null);
  const [options, setOptions] = useState<ScanOptions>({});
  const [dbStatus, setDbStatus] = useState<DbStatus | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingCommit, setPendingCommit] = useState<PendingCommit | null>(null);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [isCommitting, setIsCommitting] = useState(false);
  const [isPushing, setIsPushing] = useState(false);
  const [committed, setCommitted] = useState(false);
  const [pluginEntries, setPluginEntries] = useState<PluginCardEntry[]>([]);

  // Remediation state (grype per-package panel actions)
  const [remediation, setRemediation] = useState<{
    group: PackageGroup;
    mode: 'apply' | 'override';
  } | null>(null);
  const [remediationBusy, setRemediationBusy] = useState(false);
  const [remediationPhase, setRemediationPhase] = useState<RemediationDialogPhase>('configuring');
  const [remediationOutcome, setRemediationOutcome] = useState<{
    previousCount: number;
    currentCount: number;
    error?: string;
  } | undefined>(undefined);
  const [remediationAttemptId, setRemediationAttemptId] = useState<string | undefined>(undefined);
  const [referencesFor, setReferencesFor] = useState<PackageGroup | null>(null);

  // "All findings" section collapse state — open by default when ≤10 findings
  const [findingsExpanded, setFindingsExpanded] = useState(
    (findings?.length ?? 0) <= 10,
  );

  // Fetch db-status once on mount (lightweight)
  useEffect(() => {
    fetch('/api/security/cve-lite/db-status')
      .then(r => r.json())
      .then(setDbStatus)
      .catch(() => {});
  }, []);

  // Fetch exceptions for this project (refresh when onAnyDataChanged fires indirectly via key)
  const fetchExceptions = useCallback(async () => {
    try {
      const r = await fetch(`/api/projects/${project.id}/security/exceptions`);
      if (!r.ok) return;
      const j = await r.json();
      setExceptions(j.exceptions ?? []);
    } catch {
      // best-effort
    }
  }, [project.id]);

  useEffect(() => {
    fetchExceptions();
  }, [fetchExceptions]);

  const load = useCallback(async (force = false) => {
    setLoading(true); setError(null);
    try {
      const qs = new URLSearchParams();
      if (force) qs.set('force', 'true');
      if (options.minSeverity) qs.set('minSeverity', options.minSeverity);
      if (options.prodOnly) qs.set('prodOnly', 'true');
      if (options.onlyUsed) qs.set('onlyUsed', 'true');
      if (options.all) qs.set('all', 'true');
      const res = await fetch(`/api/security/cve-lite/${project.id}?${qs.toString()}`);
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error((e as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      setReport(await res.json());
      setScannedAt(new Date().toISOString());
      setLoadedOnce(true);
      onAnyDataChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'scan failed');
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, [project.id, options, onAnyDataChanged]);

  // Scan button handler: run 3-source security scan first (best-effort), then cve-lite scan.
  // Note: load(true) already calls onAnyDataChanged internally, so we don't call it again here.
  const scanRow = useCallback(async () => {
    if (!expanded) setExpanded(true);
    setLoading(true); setError(null);
    try {
      await fetch(`/api/projects/${project.id}/security-scan`, { method: 'POST' });
    } catch {
      // best-effort — proceed to cve-lite scan regardless
    }
    // load() manages loading state from here; setLoading(true) above covers the 3-source phase
    await load(true);
  }, [project.id, expanded, load]);

  // Lazy load: fetch when first expanded
  useEffect(() => {
    if (expanded && !loadedOnce) {
      load(false);
    }
  }, [expanded, loadedOnce, load]);

  // Fetch plugin status when expanded
  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    (async () => {
      try {
        const listRes = await fetch('/api/security/plugins');
        if (!listRes.ok) return;
        const listJson = await listRes.json();
        const plugins: Array<{ id: string; name: string; kind: PluginCardEntry['kind']; detailRoute?: string }>
          = listJson.plugins ?? [];
        const entries = await Promise.all(
          plugins.map(async (p) => {
            const r = await fetch(`/api/security/plugins/${p.id}/status?projectId=${encodeURIComponent(project.id)}`);
            if (!r.ok) return null;
            const j = await r.json();
            return {
              pluginId: j.pluginId,
              name: p.name,
              kind: p.kind,
              host: j.host,
              card: j.card,
              detailRoute: p.detailRoute,
            } as PluginCardEntry;
          }),
        );
        if (!cancelled) {
          setPluginEntries(entries.filter((e): e is PluginCardEntry => e !== null));
        }
      } catch {
        if (!cancelled) setPluginEntries([]);
      }
    })();
    return () => { cancelled = true; };
  }, [expanded, project.id]);

  // Reset pending commit state when collapsed
  useEffect(() => {
    if (!expanded) {
      setPendingCommit(null);
      setCommitted(false);
      setGitStatus(null);
    }
  }, [expanded]);

  // Reset remediation phase/outcome/attemptId whenever a dialog is opened fresh
  useEffect(() => {
    if (remediation) {
      setRemediationPhase('configuring');
      setRemediationOutcome(undefined);
      setRemediationAttemptId(undefined);
    }
  }, [remediation]);

  const fetchGitStatus = useCallback(async (): Promise<GitStatus | null> => {
    try {
      const res = await fetch(`/api/projects/${project.id}/git`);
      if (!res.ok) return null;
      const d = await res.json();
      return { branch: d.branch ?? '', ahead: d.aheadCount ?? 0, behind: d.behindCount ?? 0, dirty: !!d.isDirty };
    } catch {
      return null;
    }
  }, [project.id]);

  const beginPendingCommit = useCallback(
    async (rc: { packages: UpdatedPackage[]; advisories: string[]; severity?: string }) => {
      const status = await fetchGitStatus();
      setGitStatus(status);
      if (!status?.dirty) {
        setPendingCommit(null);
        setCommitted(false);
        setError('Fix ran, but there were no file changes to commit. A transitive advisory cannot be fixed by "Fix all direct" — use the per-finding Apply, which adds a package override.');
        return;
      }
      setError(null);
      const generated = generatePatchCommitMessage(rc.packages).full;
      const message = generated || `chore(deps): apply cve-lite fixes in ${project.id}`;
      setPendingCommit({ ...rc, message, isEditing: false });
      setCommitted(false);
    },
    [project.id, fetchGitStatus],
  );

  const handleCommit = useCallback(async () => {
    if (!pendingCommit) return;
    setIsCommitting(true); setError(null);
    try {
      const res = await fetch(`/api/projects/${project.id}/git-commit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        // Scope this commit to dependency files (package.json + whatever
        // lockfile the project actually has) so unrelated in-progress work
        // in the tree isn't swept into — and potentially auto-deployed by —
        // a cve-lite remediation commit. Resolved server-side; the browser
        // doesn't know the project's filesystem layout.
        body: JSON.stringify({
          message: pendingCommit.message,
          source: 'cve-lite',
          advisories: pendingCommit.advisories,
          scope: 'dependencies',
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || (data as { success?: boolean }).success === false) throw new Error((data as { error?: string }).error ?? `commit failed (HTTP ${res.status})`);
      setCommitted(true);
      setPendingCommit((pc) => (pc ? { ...pc, isEditing: false } : pc));
      setGitStatus(await fetchGitStatus());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'commit failed');
    } finally {
      setIsCommitting(false);
    }
  }, [pendingCommit, project.id, fetchGitStatus]);

  const handlePush = useCallback(async () => {
    if (!pendingCommit) return;
    setIsPushing(true); setError(null);
    try {
      const res = await fetch(`/api/projects/${project.id}/git-push`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'cve-lite', advisories: pendingCommit.advisories }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || (data as { success?: boolean }).success === false) throw new Error((data as { error?: string }).error ?? `push failed (HTTP ${res.status})`);
      setPendingCommit(null); setCommitted(false);
      setGitStatus(await fetchGitStatus());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'push failed');
    } finally {
      setIsPushing(false);
    }
  }, [pendingCommit, project.id, fetchGitStatus]);

  const runConfirmed = async () => {
    if (!confirm) return;
    setBusy(true); setError(null);
    try {
      await confirm.run();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'action failed');
    } finally {
      setBusy(false); setConfirm(null);
    }
  };

  const fixAll = () => setConfirm({
    title: 'Fix all direct dependencies?',
    body: (
      <>
        Runs <code>cve-lite --fix</code> in <b>{project.name}</b>, rewriting package.json + lockfile
        (may reinstall). A rescan runs after. You may need to restart that project&apos;s dev server.
      </>
    ),
    run: async () => {
      const rc = remediationFromRows(report ? findingRows(report) : []);
      const attemptId = `rem_${globalThis.crypto.randomUUID()}`;
      let fixSucceeded = false;
      try {
        const res = await fetch(`/api/security/cve-lite/${project.id}/fix`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode: 'all', auditContext: { source: 'cve-lite', advisories: rc.advisories, severity: rc.severity, attemptId } }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || (data as { ok?: boolean }).ok === false) throw new Error((data as { error?: string; summary?: string }).error ?? (data as { summary?: string }).summary ?? `fix failed (HTTP ${res.status})`);
        fixSucceeded = true;
        await load(true);
        await beginPendingCommit(rc);
      } catch (err) {
        // Log failure outcome (fire-and-forget)
        const msg = err instanceof Error ? err.message : 'fix failed';
        fetch(`/api/projects/${project.id}/security/remediation/${attemptId}/complete`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            source: 'cve-lite',
            outcome: {
              status: 'error',
              previousFindingCount: rc.packages.length,
              currentFindingCount: rc.packages.length,
              findingsCovered: rc.advisories,
              error: msg,
            },
          }),
        }).catch(() => {});
        throw err;
      }
      // Log success outcome (fire-and-forget)
      if (fixSucceeded) {
        fetch(`/api/projects/${project.id}/security/remediation/${attemptId}/complete`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            source: 'cve-lite',
            outcome: {
              status: 'resolved',
              previousFindingCount: rc.packages.length,
              currentFindingCount: 0,
              findingsCovered: rc.advisories,
            },
          }),
        }).catch(() => {});
      }
    },
  });

  const applyOne = (row: FindingRow) => setConfirm({
    title: `Apply fix for ${row.package}?`,
    body: (
      <>
        Updates <b>{row.package}</b> {row.version ?? '?'} → <b>{row.validatedFixVersion}</b> via the
        patch pipeline{row.relationship === 'transitive' ? ' (flat override)' : ''}, then rescans.
      </>
    ),
    run: async () => {
      const rc = remediationFromRow(row);
      const attemptId = `rem_${globalThis.crypto.randomUUID()}`;
      let updateSucceeded = false;
      try {
        const res = await fetch(`/api/projects/${project.id}/update`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            packages: [{
              name: row.package,
              fromVersion: row.version,
              toVersion: row.validatedFixVersion,
              fixViaOverride: row.relationship === 'transitive',
            }],
            auditContext: { source: 'cve-lite', advisories: rc.advisories, severity: rc.severity, attemptId },
          }),
        });
        if (!res.ok) {
          const e = await res.json().catch(() => ({}));
          throw new Error((e as { error?: string }).error ?? `update failed (HTTP ${res.status})`);
        }
        updateSucceeded = true;
        await load(true);
        await beginPendingCommit(rc);
      } catch (err) {
        // Log failure outcome (fire-and-forget)
        const msg = err instanceof Error ? err.message : 'apply failed';
        fetch(`/api/projects/${project.id}/security/remediation/${attemptId}/complete`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            source: 'cve-lite',
            outcome: {
              status: 'error',
              previousFindingCount: 1,
              currentFindingCount: 1,
              findingsCovered: rc.advisories,
              error: msg,
            },
          }),
        }).catch(() => {});
        throw err;
      }
      // Log success outcome (fire-and-forget)
      if (updateSucceeded) {
        fetch(`/api/projects/${project.id}/security/remediation/${attemptId}/complete`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            source: 'cve-lite',
            outcome: {
              status: 'resolved',
              previousFindingCount: 1,
              currentFindingCount: 0,
              findingsCovered: rc.advisories,
              findingsResolved: rc.advisories,
            },
          }),
        }).catch(() => {});
      }
    },
  });

  const installSkill = () => setConfirm({
    title: 'Generate cve-lite skill files?',
    body: (
      <>
        Runs <code>cve-lite install-skill</code> in <b>{project.name}</b>, writing AI-assistant skill
        files into the project.
      </>
    ),
    run: async () => {
      const res = await fetch(`/api/security/cve-lite/${project.id}/install-skill`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || (data as { ok?: boolean }).ok === false) throw new Error((data as { error?: string }).error ?? `install-skill failed (HTTP ${res.status})`);
    },
  });

  const handleFileException = useCallback(async (payload: {
    classification: string;
    reason: string;
    expiresAt?: string;
    notes?: string;
  }) => {
    if (!filingForGroup) return;
    setFilingBusy(true);
    try {
      const res = await fetch(`/api/projects/${project.id}/security/exceptions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parentPackage: filingForGroup.parentPackage,
          classification: payload.classification,
          reason: payload.reason,
          notes: payload.notes,
          expiresAt: payload.expiresAt,
        }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error((e as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      setFilingForGroup(null);
      await fetchExceptions();
      onAnyDataChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to file exception');
    } finally {
      setFilingBusy(false);
    }
  }, [filingForGroup, project.id, fetchExceptions, onAnyDataChanged]);

  const handleRevokeException = useCallback(async (exc: SecurityException) => {
    try {
      const res = await fetch(
        `/api/projects/${project.id}/security/exceptions/${exc.id}/revoke`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      );
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error((e as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      await fetchExceptions();
      onAnyDataChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to revoke exception');
    }
  }, [project.id, fetchExceptions, onAnyDataChanged]);

  const handleEditException = useCallback((exc: SecurityException) => {
    setEditingException(exc);
  }, []);

  const handleEditSubmit = useCallback(async (payload: {
    classification: string;
    reason: string;
    expiresAt?: string;
    notes?: string;
  }) => {
    if (!editingException) return;
    setEditBusy(true);
    try {
      const res = await fetch(
        `/api/projects/${project.id}/security/exceptions/${editingException.id}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        },
      );
      if (res.ok) {
        await fetchExceptions();
        onAnyDataChanged?.();
      } else {
        const e = await res.json().catch(() => ({}));
        throw new Error((e as { error?: string }).error ?? `HTTP ${res.status}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to update exception');
    } finally {
      setEditBusy(false);
      setEditingException(null);
    }
  }, [editingException, project.id, fetchExceptions, onAnyDataChanged]);

  const handleRemediationSubmit = useCallback(async ({
    targetVersion,
    viaOverride,
  }: { targetVersion: string; viaOverride: boolean }) => {
    if (!remediation) return;
    const group = remediation.group;
    const targetPkg = group.parentPackage ?? group.reportedPackage ?? group.package;
    const fromVersion = group.version ?? '';
    const advisories = Array.from(new Set(group.findings.flatMap(f => f.advisoryIds)));
    const severity = group.worstSeverity;
    const previousCount = group.findings.length;
    const groupKey = group.key;

    // Change-control: generate a stable tracking id for this apply attempt
    const attemptId = `rem_${globalThis.crypto.randomUUID()}`;
    setRemediationAttemptId(attemptId);

    setRemediationBusy(true);
    setRemediationOutcome(undefined);

    try {
      // Phase: installing
      setRemediationPhase('installing');
      const installRes = await fetch(`/api/projects/${project.id}/update`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          packages: [{
            name: targetPkg,
            fromVersion,
            toVersion: targetVersion,
            fixViaOverride: viaOverride,
          }],
          auditContext: {
            source: 'grype',
            advisories,
            severity,
            attemptId,
          },
        }),
      });
      if (!installRes.ok) {
        const e = await installRes.json().catch(() => ({}));
        throw new Error((e as { error?: string }).error ?? `update failed (HTTP ${installRes.status})`);
      }

      // Phase: rescanning — full 3-source scan to refresh the merged cache
      setRemediationPhase('rescanning');
      await fetch(`/api/projects/${project.id}/security-scan`, { method: 'POST' });
      // Continue to verify even if rescan fails (best-effort)

      // Phase: verifying — re-pull merged findings and compare for this group
      setRemediationPhase('verifying');
      const findingsRes = await fetch('/api/security/findings');
      const findingsJson = await findingsRes.json().catch(() => ({}));
      const projEntry = (findingsJson.projects ?? []).find(
        (p: { projectId: string }) => p.projectId === project.id,
      );
      const allFindings: Finding[] = projEntry?.findings ?? [];

      // Count remaining findings for this group: same parent-package key OR same reported package@version
      const stillMatching = allFindings.filter((f) => {
        if (groupKey.startsWith('parent:')) {
          const expectedParent = groupKey.slice(7);
          return deriveParentPackage(f) === expectedParent;
        }
        // Fallback: package@version equality
        return `${f.package ?? ''}@${f.version ?? '?'}` === groupKey;
      });
      const currentCount = stillMatching.length;

      setRemediationOutcome({ previousCount, currentCount });
      if (currentCount === 0) setRemediationPhase('resolved');
      else if (currentCount < previousCount) setRemediationPhase('partial');
      else setRemediationPhase('unresolved');

      // Change-control: POST the verified outcome to the audit-log endpoint (fire-and-forget)
      const findingsCovered = group.findings.map(f => f.dedupKey);
      const findingsRemaining = stillMatching.map(f => f.dedupKey);
      const findingsResolved = findingsCovered.filter(k => !new Set(findingsRemaining).has(k));
      const outcomeStatus: 'resolved' | 'partial' | 'unresolved' = currentCount === 0
        ? 'resolved'
        : currentCount < previousCount
          ? 'partial'
          : 'unresolved';
      fetch(`/api/projects/${project.id}/security/remediation/${attemptId}/complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source: 'grype',
          outcome: {
            status: outcomeStatus,
            previousFindingCount: previousCount,
            currentFindingCount: currentCount,
            findingsCovered,
            findingsResolved,
            findingsRemaining,
          },
        }),
      }).catch(() => {/* swallow — best-effort audit log */});

      // Open the pending-commit banner so the user can review + commit the change
      const rc = {
        packages: [{
          name: targetPkg,
          fromVersion,
          toVersion: targetVersion,
          isSecurityFix: true,
          vulnCount: group.findings.length,
        }],
        advisories,
        severity,
      };
      await beginPendingCommit(rc);
      onAnyDataChanged?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'remediation failed';
      setRemediationOutcome({ previousCount, currentCount: previousCount, error: msg });
      setRemediationPhase('error');

      // Change-control: report failure outcome (fire-and-forget)
      fetch(`/api/projects/${project.id}/security/remediation/${attemptId}/complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source: 'grype',
          outcome: {
            status: 'error',
            previousFindingCount: previousCount,
            currentFindingCount: previousCount,   // unknown — leave as previous
            findingsCovered: group.findings.map(f => f.dedupKey),
            error: msg,
          },
        }),
      }).catch(() => {});
    } finally {
      setRemediationBusy(false);
    }
  }, [remediation, project.id, beginPendingCommit, onAnyDataChanged]);

  // Derived view
  const visibleReport: CveLiteOutput | null = report && importedOnly
    ? { ...report, findings: (report.findings ?? []).filter(f => deriveReachable(f.usage) === true) }
    : report;
  const groups = visibleReport ? selectFixPlan(visibleReport) : [];
  const rows = visibleReport ? findingRows(visibleReport) : [];

  // Total findings count: from parent-provided sources when not yet loaded, from report when available
  const totalFindings = loadedOnce
    ? (visibleReport?.findings ?? []).length
    : Object.values(sources).reduce((sum, s) => sum + s.findingCount, 0);

  // Compute severity pill total from severity prop (critical + high + medium + low; ignore info)
  const sev = severity;
  const totalSev = sev ? sev.critical + sev.high + sev.medium + sev.low : 0;

  // Active exceptions set — inline isExceptionActive logic to avoid server-only import
  const activeParents = useMemo(() => {
    const now = new Date();
    return new Set(
      exceptions
        .filter(e => !e.revokedAt && (!e.expiresAt || new Date(e.expiresAt) > now))
        .map(e => e.parentPackage),
    );
  }, [exceptions]);

  // Memoised package groups for "All findings" section — split into actionable + suppressed
  const { actionableGroups, suppressedGroups } = useMemo(() => {
    const all = findings && findings.length > 0 ? groupFindingsForDisplay(findings) : [];
    const actionable: PackageGroup[] = [];
    const suppressed: PackageGroup[] = [];
    for (const g of all) {
      if (g.parentPackage && activeParents.has(g.parentPackage)) {
        suppressed.push(g);
      } else {
        actionable.push(g);
      }
    }
    return { actionableGroups: actionable, suppressedGroups: suppressed };
  }, [findings, activeParents]);

  // Active exceptions (for display in the "Active exceptions" section)
  const activeExceptions = useMemo(() => {
    const now = new Date();
    return exceptions.filter(e => !e.revokedAt && (!e.expiresAt || new Date(e.expiresAt) > now));
  }, [exceptions]);

  return (
    <div className="border border-zinc-800 rounded-lg overflow-hidden">
      {/* Header row — always visible */}
      <div className="flex items-center bg-zinc-900/50 hover:bg-zinc-900 transition-colors px-4 py-3">
        <div className="flex items-center gap-3 flex-1">
          <button
            type="button"
            onClick={() => setExpanded(x => !x)}
            className="flex items-center"
          >
            {expanded
              ? <ChevronDown className="h-4 w-4 text-zinc-500" />
              : <ChevronRight className="h-4 w-4 text-zinc-500" />
            }
          </button>
          <span className="font-medium text-zinc-200">{project.name}</span>
          {sev && totalSev > 0 ? (
            <div className="flex items-center gap-1.5">
              {sev.critical > 0 && (
                <Badge variant="outline" className="text-xs border-red-500/30 text-red-400 bg-red-500/10">
                  {sev.critical} critical
                </Badge>
              )}
              {sev.high > 0 && (
                <Badge variant="outline" className="text-xs border-orange-500/30 text-orange-400 bg-orange-500/10">
                  {sev.high} high
                </Badge>
              )}
              {sev.medium > 0 && (
                <Badge variant="outline" className="text-xs border-yellow-500/30 text-yellow-400 bg-yellow-500/10">
                  {sev.medium} medium
                </Badge>
              )}
              {sev.low > 0 && (
                <Badge variant="outline" className="text-xs border-zinc-500/30 text-zinc-400 bg-zinc-500/10">
                  {sev.low} low
                </Badge>
              )}
            </div>
          ) : sev && totalSev === 0 ? (
            <Badge variant="outline" className="text-xs border-green-500/30 text-green-400 bg-green-500/10">
              ✓ Clean
            </Badge>
          ) : null}
          {activeExceptions.length > 0 && (
            <Badge variant="outline" className="text-xs border-amber-500/40 text-amber-300 bg-amber-500/10">
              {activeExceptions.length} exception{activeExceptions.length !== 1 ? 's' : ''}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={scanRow}
            disabled={loading}
          >
            <RefreshCw className={cn('h-3 w-3 mr-1', loading && 'animate-spin')} />
            Scan
          </Button>
        </div>
      </div>

      {/* Body — only when expanded */}
      {expanded && (
        <div className="border-t border-zinc-800 bg-zinc-950/30 px-4 py-3 space-y-3">
          {findings && findings.length > 0 && actionableGroups.length > 0 && (
            <section>
              {/* Section-level collapse toggle */}
              <button
                type="button"
                onClick={() => setFindingsExpanded(x => !x)}
                className="flex items-center gap-2 text-xs uppercase tracking-wide text-zinc-500 hover:text-zinc-300 transition-colors mb-2 px-1"
              >
                {findingsExpanded
                  ? <ChevronDown className="h-3.5 w-3.5" />
                  : <ChevronRight className="h-3.5 w-3.5" />
                }
                All findings ({actionableGroups.reduce((n, g) => n + g.findings.length, 0)})
              </button>
              {findingsExpanded && (
                <div className="space-y-1">
                  {actionableGroups.slice(0, 30).map(g => (
                    <PackageRow
                      key={g.key}
                      group={g}
                      findingStates={findingStates}
                      projectId={project.id}
                      onFileException={AUTO_APPLY_ENABLED && g.parentPackage ? setFilingForGroup : undefined}
                      onOpenRemediation={AUTO_APPLY_ENABLED ? (group, mode) => setRemediation({ group, mode }) : undefined}
                      onViewReferences={(group) => setReferencesFor(group)}
                    />
                  ))}
                  {actionableGroups.length > 30 && (
                    <div className="text-xs text-zinc-500 px-2 py-1">
                      + {actionableGroups.length - 30} more package(s)
                    </div>
                  )}
                </div>
              )}
            </section>
          )}
          {activeExceptions.length > 0 && (
            <ActiveExceptionsSection
              exceptions={activeExceptions}
              onRevoke={handleRevokeException}
              onEdit={handleEditException}
            />
          )}
          <SourcePluginCards
            sources={sources}
            plugins={pluginEntries}
          />
          <CveLiteToolbar
            hideSelector
            projectId={project.id}
            projects={[]}
            selected={project.id}
            onSelect={() => {}}
            scannedAt={scannedAt}
            importedOnly={importedOnly}
            onToggleImported={setImportedOnly}
            onRescan={() => load(true)}
          />
          <CveLiteScanControls options={options} onChange={setOptions} />
          <div className="flex items-center gap-4 flex-wrap text-xs border border-zinc-800 rounded-md px-3 py-2 bg-zinc-900/30">
            <CveLiteManage
              projectId={project.id}
              dbStatus={dbStatus}
              onSynced={setDbStatus}
              onInstallSkill={installSkill}
            />
          </div>
          {pendingCommit && AUTO_APPLY_ENABLED && (
            <PendingCommitBanner
              packages={pendingCommit.packages}
              message={pendingCommit.message}
              isEditing={pendingCommit.isEditing}
              ahead={gitStatus?.ahead ?? 0}
              committed={committed}
              isCommitting={isCommitting}
              isPushing={isPushing}
              onMessageChange={(msg) => setPendingCommit((pc) => (pc ? { ...pc, message: msg } : pc))}
              onToggleEdit={() => setPendingCommit((pc) => (pc ? { ...pc, isEditing: !pc.isEditing } : pc))}
              onCommit={handleCommit}
              onPush={handlePush}
              onDismiss={() => { setPendingCommit(null); setCommitted(false); }}
            />
          )}
          {loading && <div className="text-sm text-zinc-500">Scanning…</div>}
          {error && <div className="text-sm text-red-400">{error}</div>}
          {!loading && !error && visibleReport && (
            <>
              {/* Completeness is a property of the scan, not of the "imported only" view
                  filter — pass the unfiltered report so a filtered-out finding with an
                  unresolved advisory can't make a partial scan look clean (F1). */}
              <CompletenessBanner report={report} />
              <section>
                <h2 className="text-sm font-medium text-zinc-300 mb-2">Fix plan</h2>
                <FixPlan groups={groups} onFixAll={AUTO_APPLY_ENABLED ? fixAll : undefined} fixingAll={busy} />
              </section>
              <section>
                <h2 className="text-sm font-medium text-zinc-300 mb-2">Findings</h2>
                <CveLiteFindings rows={rows} onApply={AUTO_APPLY_ENABLED ? applyOne : undefined} />
              </section>
              <section>
                <h2 className="text-sm font-medium text-zinc-300 mb-2">Override hygiene</h2>
                <OverrideHygienePanel projectId={project.id} />
              </section>
            </>
          )}
          {confirm && (
            <ConfirmDialog
              open
              title={confirm.title}
              body={confirm.body}
              busy={busy}
              onConfirm={runConfirmed}
              onCancel={() => setConfirm(null)}
            />
          )}
        </div>
      )}
      {filingForGroup && (
        <ExceptionDialog
          parentPackage={filingForGroup.parentPackage ?? filingForGroup.package}
          findingsCount={filingForGroup.findings.length}
          busy={filingBusy}
          onSubmit={handleFileException}
          onCancel={() => setFilingForGroup(null)}
        />
      )}
      {editingException && (
        <ExceptionDialog
          parentPackage={editingException.parentPackage}
          existing={{
            classification: editingException.classification,
            reason: editingException.reason,
            notes: editingException.notes,
            expiresAt: editingException.expiresAt,
          }}
          onSubmit={handleEditSubmit}
          onCancel={() => setEditingException(null)}
          busy={editBusy}
        />
      )}
      {remediation && (
        <RemediationDialog
          targetPackage={remediation.group.parentPackage ?? remediation.group.reportedPackage ?? remediation.group.package}
          currentVersion={remediation.group.version}
          defaultTargetVersion={
            remediation.group.parentPackage && remediation.group.parentPackage !== (remediation.group.reportedPackage ?? remediation.group.package)
              ? 'latest'
              : (remediation.group.fixedIn?.split(',')[0]?.trim() ?? 'latest')
          }
          cveCount={remediation.group.findings.length}
          mode={remediation.mode}
          note={
            remediation.group.parentPackage && remediation.group.parentPackage !== (remediation.group.reportedPackage ?? remediation.group.package)
              ? `Note: grype's fix versions describe the embedded artifact (${remediation.group.reportedPackage}). Bumping ${remediation.group.parentPackage} is the npm-level action; consult the package's release notes to find a release that resolves the underlying issue.`
              : undefined
          }
          phase={remediationPhase}
          outcome={remediationOutcome}
          attemptId={remediationAttemptId}
          onFileException={() => {
            // Close remediation dialog, open file-exception dialog targeting the same group
            const groupToFile = remediation.group;
            setRemediation(null);
            setRemediationPhase('configuring');
            setRemediationOutcome(undefined);
            setRemediationAttemptId(undefined);
            setFilingForGroup(groupToFile);
          }}
          onClose={() => {
            setRemediation(null);
            setRemediationPhase('configuring');
            setRemediationOutcome(undefined);
            setRemediationAttemptId(undefined);
          }}
          onSubmit={handleRemediationSubmit}
          onCancel={() => setRemediation(null)}
          busy={remediationBusy}
        />
      )}
      {referencesFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-xl rounded-lg border border-zinc-800 bg-zinc-950 shadow-xl">
            <div className="border-b border-zinc-800 px-5 py-3 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-medium text-zinc-100">
                  References — {referencesFor.parentPackage ?? referencesFor.reportedPackage ?? referencesFor.package}
                </h2>
                <p className="text-xs text-zinc-500 mt-1">
                  {Array.from(new Set(referencesFor.findings.flatMap(f => f.references))).length} link(s) across{' '}
                  {referencesFor.findings.length} CVE(s)
                </p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setReferencesFor(null)}>Close</Button>
            </div>
            <div className="px-5 py-3 max-h-96 overflow-auto text-xs">
              {Array.from(new Set(referencesFor.findings.flatMap(f => f.references))).map((url) => (
                <a
                  key={url}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block py-1 text-blue-400 hover:text-blue-300 break-all"
                >
                  {url}
                </a>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

