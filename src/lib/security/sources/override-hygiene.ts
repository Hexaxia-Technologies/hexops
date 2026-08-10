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
const EXCLUDED_RULES = new Set(['PD001', 'PD002']);

export function parseOverrideAuditJson(out: OverrideAuditOutput): Finding[] {
	const findings: Finding[] = [];
	for (const of of out.findings ?? []) {
		const ruleId = of.ruleId ?? 'OA000';
		if (EXCLUDED_RULES.has(ruleId)) continue;
		findings.push(toFinding(of, ruleId));
	}
	return findings;
}

function toFinding(of: OverrideFinding, ruleId: string): Finding {
	const file = of.location?.file ?? 'package.json';
	const jsonPath = of.location?.jsonPath ?? '';
	return {
		type: 'config',
		dedupKey: '',
		sources: ['override-hygiene'],
		// jsonPath is part of the path so two findings of the same rule on
		// different override entries get distinct dedup keys — the fixture
		// contains two OA009 findings with identical message text.
		path: jsonPath ? `${file}#${jsonPath}` : file,
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
