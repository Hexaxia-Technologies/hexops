import pkg from '../../package.json';

/**
 * Application version — sourced from package.json to stay in sync automatically.
 */
export const APP_VERSION: string = pkg.version;

/**
 * Build date — set at startup.
 */
export const BUILD_DATE: string = new Date().toISOString().split('T')[0];
