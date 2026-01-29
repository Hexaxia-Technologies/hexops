import { existsSync, readFileSync, statSync, readdirSync } from 'fs';
import { join } from 'path';
import type { LogEntry, LogLevel, LogCategory } from './logger';
import { LOG_PATHS } from './logger';

// Query options for filtering logs
export interface LogQuery {
  level?: LogLevel;
  category?: LogCategory;
  projectId?: string;
  search?: string;
  limit?: number;
  before?: string; // ISO timestamp for pagination
}

// Stats about logs
export interface LogStats {
  totalEntries: number;
  byLevel: Record<LogLevel, number>;
  byCategory: Record<LogCategory, number>;
  totalSizeBytes: number;
  oldestEntry?: string;
  newestEntry?: string;
}

/**
 * Get all log files in order (newest first for reading)
 */
function getLogFilesNewestFirst(): string[] {
  if (!existsSync(LOG_PATHS.dir)) return [];

  try {
    const files = readdirSync(LOG_PATHS.dir)
      .filter(f => f.startsWith('hexops.log'))
      .map(f => ({
        name: f,
        path: join(LOG_PATHS.dir, f),
        // Current file has no number, treat as 0
        num: f === 'hexops.log' ? 0 : parseInt(f.split('.').pop() || '999'),
      }))
      // Sort by number ascending (0 = current, then 1, 2, etc.)
      .sort((a, b) => a.num - b.num);

    return files.map(f => f.path);
  } catch {
    return [];
  }
}

/**
 * Parse a log line into LogEntry
 */
function parseLine(line: string): LogEntry | null {
  try {
    const entry = JSON.parse(line);
    // Validate required fields
    if (entry.ts && entry.level && entry.category && entry.message) {
      return entry as LogEntry;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Check if entry matches query filters
 */
function matchesQuery(entry: LogEntry, query: LogQuery): boolean {
  // Level filter
  if (query.level && entry.level !== query.level) return false;

  // Category filter
  if (query.category && entry.category !== query.category) return false;

  // Project filter
  if (query.projectId && entry.projectId !== query.projectId) return false;

  // Pagination - only entries before this timestamp
  if (query.before && entry.ts >= query.before) return false;

  // Search filter - check message and meta
  if (query.search) {
    const searchLower = query.search.toLowerCase();
    const messageMatch = entry.message.toLowerCase().includes(searchLower);
    const actionMatch = entry.action.toLowerCase().includes(searchLower);
    const metaMatch = entry.meta
      ? JSON.stringify(entry.meta).toLowerCase().includes(searchLower)
      : false;
    const projectMatch = entry.projectId
      ? entry.projectId.toLowerCase().includes(searchLower)
      : false;

    if (!messageMatch && !actionMatch && !metaMatch && !projectMatch) {
      return false;
    }
  }

  return true;
}

/**
 * Read logs with filtering (newest first)
 */
export function readLogs(query: LogQuery = {}): LogEntry[] {
  const limit = query.limit || 100;
  const results: LogEntry[] = [];
  const files = getLogFilesNewestFirst();

  // Read each file, starting with current (newest entries)
  for (const filePath of files) {
    if (results.length >= limit) break;
    if (!existsSync(filePath)) continue;

    try {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);

      // Process lines in reverse order (newest first within file)
      for (let i = lines.length - 1; i >= 0 && results.length < limit; i--) {
        const entry = parseLine(lines[i]);
        if (entry && matchesQuery(entry, query)) {
          results.push(entry);
        }
      }
    } catch {
      // Skip files that can't be read
    }
  }

  return results;
}

/**
 * Get log statistics
 */
export function getLogStats(): LogStats {
  const stats: LogStats = {
    totalEntries: 0,
    byLevel: { debug: 0, info: 0, warn: 0, error: 0 },
    byCategory: { patches: 0, projects: 0, git: 0, api: 0, system: 0 },
    totalSizeBytes: 0,
  };

  const files = getLogFilesNewestFirst();

  for (const filePath of files) {
    if (!existsSync(filePath)) continue;

    try {
      // Add file size
      stats.totalSizeBytes += statSync(filePath).size;

      // Count entries
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);

      for (const line of lines) {
        const entry = parseLine(line);
        if (!entry) continue;

        stats.totalEntries++;

        if (entry.level in stats.byLevel) {
          stats.byLevel[entry.level]++;
        }

        if (entry.category in stats.byCategory) {
          stats.byCategory[entry.category]++;
        }

        // Track oldest/newest
        if (!stats.oldestEntry || entry.ts < stats.oldestEntry) {
          stats.oldestEntry = entry.ts;
        }
        if (!stats.newestEntry || entry.ts > stats.newestEntry) {
          stats.newestEntry = entry.ts;
        }
      }
    } catch {
      // Skip files that can't be read
    }
  }

  return stats;
}

/**
 * Get unique project IDs from logs
 */
export function getLoggedProjects(): string[] {
  const projects = new Set<string>();
  const files = getLogFilesNewestFirst();

  for (const filePath of files) {
    if (!existsSync(filePath)) continue;

    try {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);

      for (const line of lines) {
        const entry = parseLine(line);
        if (entry?.projectId) {
          projects.add(entry.projectId);
        }
      }
    } catch {
      // Skip files that can't be read
    }
  }

  return Array.from(projects).sort();
}
