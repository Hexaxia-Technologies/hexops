'use client'

import { useState } from 'react'
import { ChevronDown, ChevronRight, Clock, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import type { PatchQueueItem } from '@/lib/types'

interface AcceptedRiskPanelProps {
  projectId: string
  items: PatchQueueItem[]   // items where escalationStatus === 'accepted_risk' or 'accepted_risk_expired'
  onReverse: (item: PatchQueueItem) => void
}

export function AcceptedRiskPanel({ projectId, items, onReverse }: AcceptedRiskPanelProps) {
  const [expanded, setExpanded] = useState(false)
  const [reversing, setReversing] = useState<string | null>(null)

  if (items.length === 0) return null

  const expired = items.filter(i => i.escalationStatus === 'accepted_risk_expired')
  const active = items.filter(i => i.escalationStatus === 'accepted_risk')

  async function handleReverse(item: PatchQueueItem) {
    if (!item.escalationId) return
    setReversing(item.escalationId)
    try {
      const res = await fetch(`/api/projects/${item.projectId}/escalate`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ escalationId: item.escalationId }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error((data as { error?: string }).error ?? 'Failed to reverse escalation')
      }
      onReverse(item)
    } catch (err) {
      console.error('Reverse escalation failed:', err)
    } finally {
      setReversing(null)
    }
  }

  function daysUntilExpiry(expiresAt: string) {
    const diff = new Date(expiresAt).getTime() - Date.now()
    return Math.ceil(diff / (1000 * 60 * 60 * 24))
  }

  return (
    <div className="mt-2 rounded-lg border border-orange-200 dark:border-orange-900 bg-orange-50/50 dark:bg-orange-950/20">
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-sm font-medium text-orange-700 dark:text-orange-400"
        onClick={() => setExpanded(e => !e)}
      >
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        Accepted Risk ({items.length})
        {expired.length > 0 && (
          <Badge variant="destructive" className="ml-1 text-xs h-4">
            {expired.length} expired
          </Badge>
        )}
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-2">
          {/* Expired items first, then active */}
          {[...expired, ...active].map(item => {
            const isExpired = item.escalationStatus === 'accepted_risk_expired'
            const days = item.escalationExpiresAt ? daysUntilExpiry(item.escalationExpiresAt) : null

            return (
              <div
                key={item.escalationId ?? item.package}
                className={`flex items-start justify-between gap-3 rounded p-2 text-sm ${
                  isExpired
                    ? 'bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800'
                    : 'bg-white dark:bg-gray-900/50'
                }`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-xs font-medium">{item.package}</span>
                    {isExpired && (
                      <Badge variant="destructive" className="text-xs h-4">Expired</Badge>
                    )}
                    {!isExpired && days !== null && (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        Expires in {days}d
                      </span>
                    )}
                  </div>
                  {item.escalationReason && (
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">{item.escalationReason}</p>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-xs shrink-0"
                  disabled={!item.escalationId || reversing === item.escalationId}
                  onClick={() => handleReverse(item)}
                >
                  {reversing === item.escalationId ? '…' : 'Reverse'}
                </Button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
