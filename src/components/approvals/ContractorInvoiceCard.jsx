'use client'

// APPROVALSQ.4 — a contractor invoice decided on /approvals. The roster-versus-
// invoice check is loaded on mount (GET /api/invoices/[id], the same read the
// invoice panel uses) and shown on the card; Approve stays disabled until it has
// loaded. If the check cannot be loaded Approve stays disabled and Retry reloads
// it. The approve route itself refuses with a 503 when the roster cannot be
// read; that text is shown like any other failure.
import { useCallback, useEffect, useState } from 'react'
import { rosterComparisonSummary } from '@shared/contractor-invoice-review'
import { loadInvoiceRosterCheck } from '@/lib/approvals/team-actions'
import { RosterCheckNotes } from '../RosterCheckNotes'
import TeamDecideCard from './TeamDecideCard'

export default function ContractorInvoiceCard({ item, ...rest }) {
  const [check, setCheck] = useState({ state: 'loading', data: null })

  const load = useCallback(async () => {
    setCheck({ state: 'loading', data: null })
    try {
      const r = await loadInvoiceRosterCheck({ id: item.id, studioId: item.studioId })
      // An answer that says the roster was unavailable and carries no stored
      // comparison has nothing to judge the invoice by: same as a failed load.
      const unusable = !r?.ok || !r.data || (r.data.roster_unavailable && !r.data.review_comparison)
      setCheck(unusable ? { state: 'failed', data: null } : { state: 'ready', data: r.data })
    } catch {
      setCheck({ state: 'failed', data: null })
    }
  }, [item.id, item.studioId])

  useEffect(() => { load() }, [load])

  const comparison = check.data?.review_comparison?.primary?.comparison
  const extra = (
    <div className="space-y-2">
      {check.state === 'ready' && comparison && (
        <div className={`text-sm rounded-md px-3 py-2 ${comparison.verdict === 'matches' ? 'bg-green-500/10 text-green-700' : 'bg-amber-500/10 text-amber-700'}`}>
          Roster check: {rosterComparisonSummary(comparison)}
        </div>
      )}
      {check.state === 'ready' && <RosterCheckNotes data={check.data} />}
      {check.state === 'failed' && (
        <div className="text-xs rounded-md px-3 py-2 bg-red-500/10 text-red-700 flex items-center gap-3">
          <span>The roster check could not be loaded.</span>
          <button type="button" onClick={load} className="underline font-medium">Retry</button>
        </div>
      )}
    </div>
  )

  return (
    <TeamDecideCard
      item={item}
      providerKey="contractor_invoices"
      {...rest}
      extra={extra}
      approveDisabledReason={check.state === 'ready' ? undefined : (check.state === 'loading' ? 'Checking the roster…' : 'Approve is off until the roster check loads.')}
    />
  )
}
