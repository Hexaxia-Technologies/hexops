'use client'

import { useState, useEffect } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Switch } from '@/components/ui/switch'
import { AlertTriangle, Zap } from 'lucide-react'
import type { PatchQueueItem, EscalateAction, EscalationConfig } from '@/lib/types'

interface EscalateModalProps {
  open: boolean
  item: PatchQueueItem | null
  projectEscalationConfig?: Partial<EscalationConfig>
  onClose: () => void
  onSuccess: (item: PatchQueueItem) => void
}

export function EscalateModal({ open, item, projectEscalationConfig, onClose, onSuccess }: EscalateModalProps) {
  const [action, setAction] = useState<EscalateAction>('force_override')
  const [reason, setReason] = useState('')
  const [overrideVersion, setOverrideVersion] = useState(item?.targetVersion ?? '')
  const [targetVersion, setTargetVersion] = useState(item?.targetVersion ?? '')
  const [expiresAt, setExpiresAt] = useState('')
  const [autoCommit, setAutoCommit] = useState(projectEscalationConfig?.autoCommit ?? false)
  const [autoPush, setAutoPush] = useState(projectEscalationConfig?.autoPush ?? false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset field state when the modal opens for a new item
  useEffect(() => {
    if (!item) return
    setAction('force_override')
    setReason('')
    setOverrideVersion(item.targetVersion ?? '')
    setTargetVersion(item.targetVersion ?? '')
    setExpiresAt('')
    setAutoCommit(projectEscalationConfig?.autoCommit ?? false)
    setAutoPush(projectEscalationConfig?.autoPush ?? false)
    setError(null)
  }, [item?.package, item?.projectId, open])

  const maxDays = projectEscalationConfig?.acceptedRiskMaxDays ?? 90
  const maxDate = new Date()
  maxDate.setDate(maxDate.getDate() + maxDays)

  async function submit(emergency = false) {
    if (!item || !reason.trim()) return
    setLoading(true)
    setError(null)

    try {
      const res = await fetch(`/api/projects/${item.projectId}/escalate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          package: item.package,
          action,
          reason: reason.trim(),
          ...(action === 'force_override' && { overrideVersion, autoCommit, autoPush }),
          ...(action === 'force_major' && { targetVersion }),
          ...(action === 'accepted_risk' && expiresAt && { expiresAt }),
          ...(emergency && { emergency: true }),
        }),
      })

      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Escalation failed')

      onSuccess(item)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  if (!item) return null

  return (
    <Dialog open={open} onOpenChange={open => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            Escalate: {item.package}
          </DialogTitle>
          {item.url && (
            <a href={item.url} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-500 hover:underline">
              View advisory ↗
            </a>
          )}
        </DialogHeader>

        <div className="space-y-4 py-2">
          <RadioGroup value={action} onValueChange={v => setAction(v as EscalateAction)}>
            {/* Force Override */}
            <div
              className={`rounded-lg border p-3 cursor-pointer ${action === 'force_override' ? 'border-blue-500 bg-blue-50 dark:bg-blue-950' : ''}`}
              onClick={() => setAction('force_override')}
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem value="force_override" id="force_override" />
                <Label htmlFor="force_override" className="font-medium cursor-pointer">Force Override</Label>
              </div>
              <p className="text-xs text-muted-foreground mt-1 ml-6">
                Pin transitive dep via package.json overrides + regenerate lockfile
              </p>
              {action === 'force_override' && (
                <div className="mt-3 ml-6 space-y-3">
                  <div>
                    <Label className="text-xs">Pin to version</Label>
                    <Input
                      className="mt-1 h-8 text-sm"
                      value={overrideVersion}
                      onChange={e => setOverrideVersion(e.target.value)}
                      placeholder="e.g. 2.17.3"
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <Label className="text-xs">Auto-commit</Label>
                    <Switch
                      checked={autoCommit}
                      onCheckedChange={val => {
                        setAutoCommit(val)
                        if (!val) setAutoPush(false)
                      }}
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <Label className="text-xs text-muted-foreground">Auto-push (requires auto-commit)</Label>
                    <Switch checked={autoPush} disabled={!autoCommit} onCheckedChange={setAutoPush} />
                  </div>
                </div>
              )}
            </div>

            {/* Force Major Bump */}
            <div
              className={`rounded-lg border p-3 cursor-pointer ${action === 'force_major' ? 'border-amber-500 bg-amber-50 dark:bg-amber-950' : ''}`}
              onClick={() => setAction('force_major')}
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem value="force_major" id="force_major" />
                <Label htmlFor="force_major" className="font-medium cursor-pointer">Force Major Bump</Label>
              </div>
              <p className="text-xs text-muted-foreground mt-1 ml-6">
                Updates package.json only. <strong>Never auto-commits.</strong> Review and commit manually.
              </p>
              {action === 'force_major' && (
                <div className="mt-3 ml-6">
                  <Label className="text-xs">Target version</Label>
                  <Input
                    className="mt-1 h-8 text-sm"
                    value={targetVersion}
                    onChange={e => setTargetVersion(e.target.value)}
                    placeholder="e.g. 4.0.0"
                  />
                  <p className="text-xs text-amber-600 mt-2">
                    ⚠ Breaking changes likely. Test thoroughly before merging.
                  </p>
                </div>
              )}
            </div>

            {/* Accept Risk */}
            <div
              className={`rounded-lg border p-3 cursor-pointer ${action === 'accepted_risk' ? 'border-orange-500 bg-orange-50 dark:bg-orange-950' : ''}`}
              onClick={() => setAction('accepted_risk')}
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem value="accepted_risk" id="accepted_risk" />
                <Label htmlFor="accepted_risk" className="font-medium cursor-pointer">Accept Risk</Label>
              </div>
              <p className="text-xs text-muted-foreground mt-1 ml-6">
                Suppress this vuln from the queue. Max {maxDays} days. Will re-surface on expiry.
              </p>
              {action === 'accepted_risk' && (
                <div className="mt-3 ml-6 space-y-2">
                  <Label className="text-xs">Expiry date (max {maxDate.toLocaleDateString()})</Label>
                  <Input
                    type="date"
                    className="h-8 text-sm"
                    max={maxDate.toISOString().split('T')[0]}
                    value={expiresAt ? expiresAt.split('T')[0] : ''}
                    onChange={e => setExpiresAt(e.target.value ? new Date(e.target.value).toISOString() : '')}
                  />
                </div>
              )}
            </div>
          </RadioGroup>

          {/* Reason — always required */}
          <div>
            <Label className="text-sm">
              Reason <span className="text-red-500">*</span>
            </Label>
            <Textarea
              className="mt-1 text-sm"
              rows={2}
              placeholder="Why is this being escalated rather than patched normally?"
              value={reason}
              onChange={e => setReason(e.target.value)}
            />
          </div>

          {error && (
            <p className="text-xs text-red-500 bg-red-50 dark:bg-red-950 rounded p-2">{error}</p>
          )}
        </div>

        <DialogFooter className="flex items-center justify-between">
          <div>
            {action === 'force_override' && (
              <Button
                variant="destructive"
                size="sm"
                disabled={!reason.trim() || !overrideVersion || loading}
                onClick={() => submit(true)}
                className="gap-1"
              >
                <Zap className="h-3 w-3" />
                Patch Now
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onClose} disabled={loading}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!reason.trim() || (action === 'force_override' && !overrideVersion) || loading}
              onClick={() => submit(false)}
            >
              {loading ? 'Working…' : 'Escalate'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
