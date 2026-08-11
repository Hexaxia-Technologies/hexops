import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ProjectConfig } from '../types';
import { readJsonCache, writeJsonCache } from './json-cache';
import { cveLiteToolVersion } from './cve-lite-cache';
import { ScanSkippedError } from './types';

const execAsync = promisify(exec);

export interface OverrideFinding {
	ruleId?: string;
	severity?: string;
	package?: { name?: string };
	location?: { file?: string; jsonPath?: string };
	message?: string;
	details?: string;
	fix?: { type?: string; patch?: unknown[]; runnableCommand?: string };
	references?: string[];
}

export interface OverrideAuditOutput {
	findings?: OverrideFinding[];
}

function binPath(): string {
	return join(process.cwd(), 'node_modules', '.bin', 'cve-lite');
}

/** Path-first argument order (#770): `cve-lite <path> overrides --json [flags]`. */
export function buildOverrideCommand(
	bin: string,
	projectPath: string,
	flags: string[] = [],
): string {
	return [bin, projectPath, 'overrides', '--json', ...flags]
		.map((p) => JSON.stringify(p))
		.join(' ');
}

/**
 * Matches the CLI's own message when `overrides` finds no package.json to
 * audit at all (`buildOverrideContext: no package.json at <path>`) — the
 * override-hygiene equivalent of cve-lite's "no scannable packages" case.
 * That's not a failure, just nothing to audit.
 */
const NO_PACKAGE_JSON_RE = /no package\.json at/i;

/**
 * Pure classifier for the "no output file was written" case in
 * runOverrideAuditRaw. Exported for unit testing without shelling out to the
 * real binary — mirrors cve-lite.ts's classifyMissingOutput.
 */
export function classifyMissingOverrideOutput(input: {
	execErrorMessage?: string;
	stdout?: string;
	stderr?: string;
}): { kind: 'no-package-json' } | { kind: 'error'; message: string } {
	const combined = `${input.stdout ?? ''}\n${input.stderr ?? ''}`;
	if (NO_PACKAGE_JSON_RE.test(combined)) return { kind: 'no-package-json' };
	return {
		kind: 'error',
		message: input.execErrorMessage
			? `cve-lite overrides produced no output: ${input.execErrorMessage}`
			: 'cve-lite overrides produced no output',
	};
}

/**
 * Runs one override audit. `overrides --json` writes a timestamped file into
 * cwd rather than stdout, so this runs in a temp dir and reads the file back.
 * A non-zero exit is expected when findings exist, so the file's presence —
 * not the exit code — distinguishes success from failure. When no file is
 * written, distinguishes "nothing to audit" (no package.json — throws
 * ScanSkippedError) from a genuine failure (throws a plain Error).
 */
export async function runOverrideAuditRaw(project: ProjectConfig): Promise<OverrideAuditOutput> {
	const tmp = mkdtempSync(join(tmpdir(), 'hexops-cve-lite-ovr-'));
	try {
		let execErrorMessage: string | undefined;
		let stdout = '';
		let stderr = '';
		try {
			const res = await execAsync(buildOverrideCommand(binPath(), project.path), {
				cwd: tmp,
				timeout: 170_000,
				maxBuffer: 64 * 1024 * 1024,
			});
			stdout = res.stdout ?? '';
			stderr = res.stderr ?? '';
		} catch (err) {
			// findings present => non-zero exit, file still written. Disambiguated below.
			execErrorMessage = err instanceof Error ? err.message : String(err);
			const withStreams = err as { stdout?: string; stderr?: string };
			stdout = withStreams.stdout ?? '';
			stderr = withStreams.stderr ?? '';
		}
		const outFile = readdirSync(tmp).find(
			(f) => f.startsWith('cve-lite-overrides-') && f.endsWith('.json'),
		);
		if (outFile) {
			return JSON.parse(readFileSync(join(tmp, outFile), 'utf-8')) as OverrideAuditOutput;
		}
		const outcome = classifyMissingOverrideOutput({ execErrorMessage, stdout, stderr });
		if (outcome.kind === 'no-package-json') {
			throw new ScanSkippedError(
				`No package.json found under ${project.path} — nothing to audit for override hygiene`,
			);
		}
		throw new Error(outcome.message);
	} finally {
		try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
	}
}

/** Cache-aware override audit (1h TTL), mirroring the cve-lite scan cache. */
export async function runOverrideAudit(
	project: ProjectConfig,
	opts: { force?: boolean } = {},
): Promise<OverrideAuditOutput> {
	if (!opts.force) {
		const cached = readJsonCache<OverrideAuditOutput>('override-audit', project.id, cveLiteToolVersion());
		if (cached) return cached;
	}
	const report = await runOverrideAuditRaw(project);
	writeJsonCache('override-audit', project.id, cveLiteToolVersion(), report);
	return report;
}

/** True when cve-lite is installed. */
export function overrideAuditAvailable(): boolean {
	return existsSync(binPath());
}
