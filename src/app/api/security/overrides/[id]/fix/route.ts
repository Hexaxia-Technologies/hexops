import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import { getProject } from '@/lib/config';
import { runOverrideAudit, overrideAuditAvailable } from '@/lib/security/override-audit';
import { scanProject as runSecurityScan } from '@/lib/security/runner';
import { OVERRIDE_HYGIENE_FIX_ENABLED } from '@/lib/auto-apply-flag';
import { runWithDevServerGuard } from '@/lib/process-manager';
import { logger } from '@/lib/logger';

const execAsync = promisify(exec);
const BIN = join(process.cwd(), 'node_modules', '.bin', 'cve-lite');

/** Only OA rule ids are accepted — PD rules are not fixable through this path. */
const RULE_RE = /^OA\d{3}$/;

export async function POST(
	req: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	// Checked first so a stale browser tab cannot bypass the kill switch (#96/#97).
	if (!OVERRIDE_HYGIENE_FIX_ENABLED) {
		return NextResponse.json(
			{
				ok: false,
				error:
					'Override hygiene fixes are disabled in HexOps. Set OVERRIDE_HYGIENE_FIX_ENABLED to enable.',
			},
			{ status: 409 },
		);
	}

	const { id } = await params;
	const project = getProject(id);
	if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 });
	if (!overrideAuditAvailable()) {
		return NextResponse.json({ error: 'cve-lite not installed' }, { status: 503 });
	}

	const body = (await req.json().catch(() => ({}))) as { rule?: string };
	if (body.rule !== undefined && !RULE_RE.test(body.rule)) {
		return NextResponse.json({ error: 'rule must match OA###' }, { status: 400 });
	}
	const ruleFlags = body.rule ? ['--rule', body.rule] : [];

	// overrides --fix runs an install; guard the dev server (#109).
	const guardOutcome = await runWithDevServerGuard(
		project,
		async () => {
			const cmd = [BIN, project.path, 'overrides', '--fix', ...ruleFlags]
				.map((p) => JSON.stringify(p))
				.join(' ');
			try {
				const { stdout } = await execAsync(cmd, {
					cwd: project.path,
					timeout: 300_000,
					maxBuffer: 64 * 1024 * 1024,
				});
				return { ok: true, summary: stdout.slice(-2000) };
			} catch (err) {
				// Exit 1 = findings remain; exit 2 = fix ran but did not verify;
				// exit 3 = tool error. Treat all as not-ok and surface the output.
				const summary = err instanceof Error ? err.message.slice(-2000) : 'override fix failed';
				return { ok: false, summary };
			}
		},
		{ clearBuildDir: true },
	);

	if (guardOutcome.blocked) {
		return NextResponse.json(
			{
				ok: false,
				error: guardOutcome.reason,
				devServerGuard: { action: guardOutcome.decision, reason: guardOutcome.reason },
			},
			{ status: 409 },
		);
	}

	const { ok, summary } = guardOutcome.result!;
	if (ok) {
		await runOverrideAudit(project, { force: true }).catch(() => {});
		await runSecurityScan(project).catch(() => {});
	}
	logger.info('api', 'override_hygiene_fix', `overrides --fix on ${id} (ok=${ok})`, {
		projectId: id,
	});
	return NextResponse.json({ ok, summary, rescanned: ok });
}
