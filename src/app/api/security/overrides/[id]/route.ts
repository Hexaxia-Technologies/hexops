import { NextRequest, NextResponse } from 'next/server';
import { getProject } from '@/lib/config';
import { runOverrideAudit, overrideAuditAvailable } from '@/lib/security/override-audit';
import { parseOverrideAuditJson } from '@/lib/security/sources/override-hygiene';
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
		return NextResponse.json({
			findings: report.findings ?? [],
			rows: parseOverrideAuditJson(report),
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : 'override audit failed';
		logger.error('api', 'override_audit_failed', message, { projectId: id });
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
