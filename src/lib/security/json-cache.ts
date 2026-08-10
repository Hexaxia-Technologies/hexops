import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';

interface Entry<T> { cachedAt: string; ttlMs: number; toolVersion: string; payload: T }

const DEFAULT_TTL_MS = 3_600_000; // 1 hour
let cacheDir = join(process.cwd(), '.hexops', 'cache');

export function _setJsonCacheDirForTest(dir: string) { cacheDir = dir; }

function cachePath(namespace: string, id: string) {
	return join(cacheDir, `${namespace}-${id}.json`);
}

export function readJsonCache<T>(namespace: string, id: string, toolVersion: string): T | null {
	const path = cachePath(namespace, id);
	if (!existsSync(path)) return null;
	try {
		const entry = JSON.parse(readFileSync(path, 'utf-8')) as Entry<T>;
		if (!entry || typeof entry.cachedAt !== 'string') return null;
		if (entry.toolVersion !== toolVersion) return null;
		if (Date.now() - new Date(entry.cachedAt).getTime() > (entry.ttlMs ?? DEFAULT_TTL_MS)) return null;
		return entry.payload;
	} catch {
		return null;
	}
}

export function writeJsonCache<T>(namespace: string, id: string, toolVersion: string, payload: T): void {
	if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
	const finalPath = cachePath(namespace, id);
	const tmp = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
	const entry: Entry<T> = { cachedAt: new Date().toISOString(), ttlMs: DEFAULT_TTL_MS, toolVersion, payload };
	writeFileSync(tmp, JSON.stringify(entry, null, 2));
	try {
		renameSync(tmp, finalPath);
	} catch (err) {
		try { unlinkSync(tmp); } catch { /* ignore */ }
		throw err;
	}
}
