import type { ScanSource } from '../types';
import { PnpmAuditSource } from './pnpm-audit';
import { GrypeSource } from './grype';
import { CveLiteSource } from './cve-lite';
import { DependencyHealthSource } from './dependency-health';
import { OverrideHygieneSource } from './override-hygiene';

export const SOURCES: ScanSource[] = [
  PnpmAuditSource,
  GrypeSource,
  CveLiteSource,
  DependencyHealthSource,
  OverrideHygieneSource,
];
