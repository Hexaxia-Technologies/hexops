import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ProjectConfig } from '../types';
import { readJsonCache, writeJsonCache } from './json-cache';
import { cveLiteToolVersion } from './cve-lite-cache';

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
 * Runs one override audit. `overrides --json` writes a timestamped file into
 * cwd rather than stdout, so this runs in a temp dir and reads the file back.
 * A non-zero exit is expected when findings exist, so the file's presence —
 * not the exit code — distinguishes success from failure.
 */
export async function runOverrideAuditRaw(project: ProjectConfig): Promise<OverrideAuditOutput> {
	const tmp = mkdtempSync(join(tmpdir(), 'hexops-cve-lite-ovr-'));
	try {
		try {
			await execAsync(buildOverrideCommand(binPath(), project.path), {
				cwd: tmp,
				timeout: 170_000,
				maxBuffer: 64 * 1024 * 1024,
			});
		} catch {
			// findings present => non-zero exit, file still written. Disambiguated below.
		}
		const outFile = readdirSync(tmp).find(
			(f) => f.startsWith('cve-lite-overrides-') && f.endsWith('.json'),
		);
		if (!outFile) throw new Error('cve-lite overrides produced no output');
		return JSON.parse(readFileSync(join(tmp, outFile), 'utf-8')) as OverrideAuditOutput;
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
