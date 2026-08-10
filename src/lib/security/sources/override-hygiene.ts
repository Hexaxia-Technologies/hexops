import type { Finding, ScanSource, ScanSourceResult, Severity } from '../types';
import type { ProjectConfig } from '../../types';
import {
	overrideAuditAvailable,
	runOverrideAudit,
	type OverrideAuditOutput,
	type OverrideFinding,
} from '../override-audit';

const SEVERITY_MAP: Record<string, Severity> = {
	critical: 'critical',
	high: 'high',
	medium: 'medium',
	moderate: 'medium',
	low: 'low',
	info: 'info',
};

/**
 * Phantom-dependency rules are filtered out: DependencyHealthSource (#125) is
 * HexOps's phantom-dep authority, and config findings dedup on title+path, so
 * letting both report would show the same phantom dep twice on /security.
 */
export const EXCLUDED_RULES = new Set(['PD001', 'PD002']);

export function parseOverrideAuditJson(out: OverrideAuditOutput): Finding[] {
	const findings: Finding[] = [];
	for (const of of out.findings ?? []) {
		// A missing/unrecognised ruleId used to default to 'OA000', which isn't in
		// EXCLUDED_RULES — an unlabelled phantom-dep finding would slip past the
		// PD filter and duplicate DependencyHealthSource. Rather than invent a
		// taxonomy to classify it, drop anything we can't positively identify as
		// a known, non-excluded rule (F7).
		const ruleId = of.ruleId;
		if (!ruleId) continue;
		if (EXCLUDED_RULES.has(ruleId)) continue;
		findings.push(toFinding(of, ruleId));
	}
	return findings;
}

function toFinding(of: OverrideFinding, ruleId: string): Finding {
	const file = of.location?.file ?? 'package.json';
	const jsonPath = of.location?.jsonPath ?? '';
	const pkgName = of.package?.name;
	return {
		type: 'config',
		dedupKey: '',
		sources: ['override-hygiene'],
		// jsonPath is part of the path so two findings of the same rule on
		// different override entries get distinct dedup keys — the fixture
		// contains two OA009 findings with identical message text. When jsonPath
		// is absent, fall back to the package name (rather than bare `file`) so
		// same-rule findings on different packages with identical message text
		// don't collide on the merger's `config:<path>|<title>` dedup key (F6).
		path: jsonPath ? `${file}#${jsonPath}` : pkgName ? `${file}#${pkgName}` : file,
		title: `${ruleId}: ${of.message ?? 'Override hygiene finding'}`,
		detail: of.details ?? '',
		package: of.package?.name,
		severity: SEVERITY_MAP[(of.severity ?? 'info').toLowerCase()] ?? 'info',
		advisoryIds: [],
		rawBySource: { 'override-hygiene': of },
		references: of.references ?? [],
		remediation: {
			source: 'override-hygiene',
			runnableFixCommand: of.fix?.runnableCommand ?? undefined,
			recommendedAction: of.details ?? undefined,
		},
	};
}

export const OverrideHygieneSource: ScanSource = {
	id: 'override-hygiene',
	displayName: 'Override Hygiene (OA)',
	findingTypes: ['config'],
	timeoutMs: 180_000,

	isAvailable: async () => overrideAuditAvailable(),

	async scan(project: ProjectConfig): Promise<ScanSourceResult> {
		const report = await runOverrideAudit(project);
		return { findings: parseOverrideAuditJson(report) };
	},
};
