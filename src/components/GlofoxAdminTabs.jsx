'use client'

// GLOFOX3.6 — tab wrapper around the existing GlofoxImportClient
// (pull/re-sync) + the new GlofoxPushReviewTab (push events needing
// review). Lives client-side so we can switch tabs without a server
// round-trip; the underlying components own their own data fetching.
//
// The tab indicator on the Review tab shows the outstanding count
// fetched on mount + after each retry/dismiss action. Counter
// auto-refreshes lazily — operators bouncing between tabs see fresh
// numbers without hammering the API.

import { useEffect, useState, useCallback } from 'react'
import { Inbox, AlertTriangle, Receipt } from 'lucide-react'
import GlofoxImportClient from './GlofoxImportClient'
import GlofoxPushReviewTab from './GlofoxPushReviewTab'
import GlofoxInvoiceBackfillTab from './GlofoxInvoiceBackfillTab'

const TABS = [
  { id: 'import',   label: 'Import',          Icon: Inbox },
  { id: 'review',   label: 'Review',          Icon: AlertTriangle },
  { id: 'invoices', label: 'Invoice backfill', Icon: Receipt },
]

export default function GlofoxAdminTabs(props) {
  const [active, setActive] = useState('import')
  const [reviewCount, setReviewCount] = useState(null)

  const refreshCount = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/glofox-push-events?limit=200')
      const j = await r.json()
      if (j.success !== false) setReviewCount(j.count ?? (j.events?.length || 0))
    } catch {
      // Silent — count is decorative; absence just hides the badge.
    }
  }, [])

  useEffect(() => { refreshCount() }, [refreshCount])
  // Re-fetch count when the operator switches BACK to import — that
  // implies they just acted in Review and we want the badge fresh.
  useEffect(() => {
    if (active === 'import') refreshCount()
  }, [active, refreshCount])

  return (
    <div className="space-y-4">
      <div className="border-b border-un1t-gray flex items-center gap-1">
        {TABS.map(({ id, label, Icon }) => {
          const on = active === id
          const showBadge = id === 'review' && reviewCount > 0
          return (
            <button
              key={id}
              type="button"
              onClick={() => setActive(id)}
              className={`relative px-4 py-2 text-sm font-medium border-b-2 -mb-px inline-flex items-center gap-1.5 transition-colors ${
                on
                  ? 'border-emerald-500 text-un1t-white'
                  : 'border-transparent text-un1t-light hover:text-un1t-white'
              }`}
            >
              <Icon size={14} />
              {label}
              {showBadge && (
                <span className="ml-1 inline-flex items-center justify-center min-w-[18px] px-1.5 py-0.5 text-[10px] font-semibold rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40">
                  {reviewCount}
                </span>
              )}
            </button>
          )
        })}
      </div>

      {active === 'import'   && <GlofoxImportClient {...props} />}
      {active === 'review'   && <GlofoxPushReviewTab />}
      {active === 'invoices' && <GlofoxInvoiceBackfillTab />}
    </div>
  )
}
