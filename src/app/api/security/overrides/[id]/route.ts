import { NextRequest, NextResponse } from 'next/server';
import { getProject } from '@/lib/config';
import { runOverrideAudit, overrideAuditAvailable } from '@/lib/security/override-audit';
import { parseOverrideAuditJson, EXCLUDED_RULES } from '@/lib/security/sources/override-hygiene';
import { logger } from '@/lib/logger';

export async function GET(
	req: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	const project = getProject(id);
	if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });
	if (!overrideAuditAvailable()) {
		return NextResponse.json({ error: 'cve-lite not installed' }, { status: 503 });
	}
	const force = req.nextUrl?.searchParams.get('force') != null
		|| new URL(req.url).searchParams.get('force') != null;
	try {
		const report = await runOverrideAudit(project, { force });
		// The panel renders `findings` directly, so it must carry the same
		// PD001/PD002 exclusion as `rows` — otherwise a real phantom dep shows up
		// twice: once from DependencyHealthSource, once from this raw array (F2).
		const findings = (report.findings ?? []).filter(
			(f) => !EXCLUDED_RULES.has(f.ruleId ?? ''),
		);
		return NextResponse.json({
			findings,
			rows: parseOverrideAuditJson(report),
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : 'override audit failed';
		logger.error('api', 'override_audit_failed', message, { projectId: id });
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
