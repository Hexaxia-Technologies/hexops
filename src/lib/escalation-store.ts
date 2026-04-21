import fs from 'fs'
import path from 'path'
import type { EscalateRecord, EscalationStore } from './types'

const ESCALATIONS_PATH = path.join(process.cwd(), '.hexops', 'patches', 'escalations.json')

function readStore(): EscalationStore {
  if (!fs.existsSync(ESCALATIONS_PATH)) {
    return { records: [] }
  }
  try {
    return JSON.parse(fs.readFileSync(ESCALATIONS_PATH, 'utf-8')) as EscalationStore
  } catch {
    return { records: [] }
  }
}

function writeStore(store: EscalationStore): void {
  fs.mkdirSync(path.dirname(ESCALATIONS_PATH), { recursive: true })
  fs.writeFileSync(ESCALATIONS_PATH, JSON.stringify(store, null, 2))
}

export function getAllEscalations(): EscalateRecord[] {
  return readStore().records
}

export function getEscalationsForProject(projectId: string): EscalateRecord[] {
  return readStore().records.filter(r => r.projectId === projectId)
}

export function addEscalation(record: EscalateRecord): void {
  const store = readStore()
  // Remove any existing record for same project+package (one active record per package per project)
  store.records = store.records.filter(
    r => !(r.projectId === record.projectId && r.package === record.package && !r.resolvedAt)
  )
  store.records.push(record)
  writeStore(store)
}

export function removeEscalation(id: string): boolean {
  const store = readStore()
  const before = store.records.length
  store.records = store.records.filter(r => r.id !== id)
  if (store.records.length === before) return false
  writeStore(store)
  return true
}

export function resolveEscalation(id: string): void {
  const store = readStore()
  const record = store.records.find(r => r.id === id)
  if (record) {
    record.resolvedAt = new Date().toISOString()
    writeStore(store)
  }
}

export function getEscalationConfig(projectConfig: { escalation?: { acceptedRiskMaxDays?: number; autoCommit?: boolean; autoPush?: boolean } }): {
  acceptedRiskMaxDays: number
  autoCommit: boolean
  autoPush: boolean
} {
  return {
    acceptedRiskMaxDays: projectConfig.escalation?.acceptedRiskMaxDays ?? 90,
    autoCommit: projectConfig.escalation?.autoCommit ?? false,
    autoPush: projectConfig.escalation?.autoPush ?? false,
  }
}
