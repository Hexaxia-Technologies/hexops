import { existsSync, mkdirSync, appendFileSync, statSync, renameSync, unlinkSync, readdirSync } from 'fs';
import { join } from 'path';

// Log levels
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// Log categories
export type LogCategory = 'patches' | 'projects' | 'git' | 'api' | 'system';

// Log entry structure
export interface LogEntry {
  ts: string;
  level: LogLevel;
  category: LogCategory;
  action: string;
  message: string;
  projectId?: string;
  meta?: Record<string, unknown>;
}

// Logger options
interface LogOptions {
  projectId?: string;
  meta?: Record<string, unknown>;
}

// Configuration
const LOGS_DIR = join(process.cwd(), '.hexops', 'logs');
const LOG_FILE = join(LOGS_DIR, 'hexops.log');
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB per file
const MAX_TOTAL_SIZE = 100 * 1024 * 1024; // 100MB total
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// Minimum log level (can be changed at runtime)
let minLogLevel: LogLevel = process.env.NODE_ENV === 'production' ? 'info' : 'debug';

/**
 * Ensure logs directory exists
 */
function ensureLogsDir(): void {
  if (!existsSync(LOGS_DIR)) {
    mkdirSync(LOGS_DIR, { recursive: true });
  }
}

/**
 * Get size of a file (0 if doesn't exist)
 */
function getFileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Get all log files sorted by number (oldest first)
 */
function getLogFiles(): string[] {
  ensureLogsDir();
  try {
    const files = readdirSync(LOGS_DIR)
      .filter(f => f.startsWith('hexops.log'))
      .sort((a, b) => {
        // hexops.log comes last (it's the current file)
        if (a === 'hexops.log') return 1;
        if (b === 'hexops.log') return -1;
        // Sort by number (hexops.log.1, hexops.log.2, etc.)
        const numA = parseInt(a.split('.').pop() || '0');
        const numB = parseInt(b.split('.').pop() || '0');
        return numB - numA; // Higher numbers are older
      });
    return files.map(f => join(LOGS_DIR, f));
  } catch {
    return [];
  }
}

/**
 * Calculate total size of all log files
 */
function getTotalLogSize(): number {
  return getLogFiles().reduce((total, file) => total + getFileSize(file), 0);
}

/**
 * Rotate log files when current file exceeds max size
 */
function rotateIfNeeded(): void {
  const currentSize = getFileSize(LOG_FILE);
  if (currentSize < MAX_FILE_SIZE) return;

  ensureLogsDir();

  // Find next rotation number
  const files = getLogFiles();
  let maxNum = 0;
  for (const file of files) {
    const match = file.match(/hexops\.log\.(\d+)$/);
    if (match) {
      maxNum = Math.max(maxNum, parseInt(match[1]));
    }
  }

  // Rotate current file
  const rotatedPath = join(LOGS_DIR, `hexops.log.${maxNum + 1}`);
  try {
    renameSync(LOG_FILE, rotatedPath);
  } catch {
    // Ignore rotation errors
  }

  // Clean up old files if total exceeds max
  cleanupOldLogs();
}

/**
 * Delete oldest log files to stay under max total size
 */
function cleanupOldLogs(): void {
  let totalSize = getTotalLogSize();
  const files = getLogFiles();

  // Delete oldest files (highest numbers) until under limit
  for (let i = 0; i < files.length && totalSize > MAX_TOTAL_SIZE; i++) {
    const file = files[i];
    // Don't delete current log file
    if (file === LOG_FILE) continue;

    const fileSize = getFileSize(file);
    try {
      unlinkSync(file);
      totalSize -= fileSize;
    } catch {
      // Ignore deletion errors
    }
  }
}

/**
 * Write a log entry to file
 */
function writeLog(entry: LogEntry): void {
  // Check log level
  if (LOG_LEVEL_PRIORITY[entry.level] < LOG_LEVEL_PRIORITY[minLogLevel]) {
    return;
  }

  ensureLogsDir();
  rotateIfNeeded();

  const line = JSON.stringify(entry) + '\n';
  try {
    appendFileSync(LOG_FILE, line, 'utf-8');
  } catch (err) {
    // Fallback to console if file write fails
    console.error('Failed to write log:', err);
    console.log(line);
  }
}

/**
 * Create a log entry
 */
function createLogEntry(
  level: LogLevel,
  category: LogCategory,
  action: string,
  message: string,
  options?: LogOptions
): LogEntry {
  return {
    ts: new Date().toISOString(),
    level,
    category,
    action,
    message,
    ...(options?.projectId && { projectId: options.projectId }),
    ...(options?.meta && { meta: options.meta }),
  };
}

/**
 * Logger instance
 */
export const logger = {
  debug(category: LogCategory, action: string, message: string, options?: LogOptions): void {
    writeLog(createLogEntry('debug', category, action, message, options));
  },

  info(category: LogCategory, action: string, message: string, options?: LogOptions): void {
    writeLog(createLogEntry('info', category, action, message, options));
  },

  warn(category: LogCategory, action: string, message: string, options?: LogOptions): void {
    writeLog(createLogEntry('warn', category, action, message, options));
  },

  error(category: LogCategory, action: string, message: string, options?: LogOptions): void {
    writeLog(createLogEntry('error', category, action, message, options));
  },

  /**
   * Set minimum log level
   */
  setLevel(level: LogLevel): void {
    minLogLevel = level;
  },

  /**
   * Get current minimum log level
   */
  getLevel(): LogLevel {
    return minLogLevel;
  },
};

// Export paths for log reader
export const LOG_PATHS = {
  dir: LOGS_DIR,
  file: LOG_FILE,
};
