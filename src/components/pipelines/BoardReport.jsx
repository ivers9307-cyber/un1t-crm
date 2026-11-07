'use client'
// PIPEBUILD.6-4 — the report card on a board's settings page.
import { useEffect, useState } from 'react'
import { Card } from '@/components/ui'

const EUR = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' })
const BROKEN = "Couldn't load this part."

function Broken() {
  return <p className="text-sm text-un1t-subtle">{BROKEN}</p>
}

function Th({ children, right }) {
  return <th className={`py-1 pr-3 font-medium text-un1t-subtle ${right ? 'text-right' : 'text-left'}`}>{children}</th>
}
function Td({ children, right }) {
  return <td className={`py-1 pr-3 text-un1t-text ${right ? 'text-right' : 'text-left'}`}>{children}</td>
}

export default function BoardReport({ boardId, stages: boardStages = [] }) {
  const [state, setState] = useState({ loading: true, error: null, report: null })

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      let res
      let json = null
      try {
        res = await fetch(`/api/pipelines/${boardId}/report`)
        try { json = await res.json() } catch { /* generic message below */ }
      } catch {
        if (!cancelled) setState({ loading: false, error: 'Could not reach the server. Try again.', report: null })
        return
      }
      if (cancelled) return
      if (!res.ok || !json?.success) setState({ loading: false, error: json?.error || 'Could not load the report.', report: null })
      else setState({ loading: false, error: null, report: json.data && typeof json.data === 'object' ? json.data : {} })
    })()
    return () => { cancelled = true }
  }, [boardId])

  const { loading, error, report } = state
  const stageName = (id) => (
    report?.funnel?.stages?.find((s) => s.id === id)?.name
    || boardStages.find((s) => s.id === id)?.name
    || 'Unknown stage'
  )

  let body
  if (loading) body = <p className="text-sm text-un1t-subtle">Loading…</p>
  else if (error) body = <p className="text-sm text-red-700" role="alert">{error}</p>
  else {
    const { funnel, conversion, revenue, followups, health } = report
    body = (
      <div className="space-y-5">
        {Array.isArray(health) && health.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {health.map((h, i) => (
              <span key={`${h.code}-${h.stageId || i}`} className="rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700">{h.message}</span>
            ))}
          </div>
        )}

        <div>
          <h3 className="mb-1 text-sm font-semibold text-un1t-text">Funnel</h3>
          {!funnel ? <Broken /> : (
            <>
              <table className="w-full text-sm">
                <thead><tr><Th>Stage</Th><Th right>Now</Th><Th right>Moved in 7 days</Th><Th right>Moved in 30 days</Th></tr></thead>
                <tbody>
                  {funnel.stages.map((s) => (
                    <tr key={s.id}><Td>{s.name}</Td><Td right>{s.now}</Td><Td right>{s.movedIn7}</Td><Td right>{s.movedIn30}</Td></tr>
                  ))}
                </tbody>
              </table>
              {funnel.historyNote && <p className="mt-1 text-xs text-un1t-subtle">{funnel.historyNote}</p>}
            </>
          )}
        </div>

        <div>
          <h3 className="mb-1 text-sm font-semibold text-un1t-text">Conversion</h3>
          {!conversion ? <Broken /> : (
            <dl className="grid grid-cols-3 gap-3 text-sm">
              <div><dt className="text-un1t-subtle">Entered in 30 days</dt><dd className="text-un1t-text">{conversion.entered30}</dd></div>
              <div><dt className="text-un1t-subtle">Converted</dt><dd className="text-un1t-text">{conversion.converted30}</dd></div>
              <div><dt className="text-un1t-subtle">Conversion rate</dt><dd className="text-un1t-text">{conversion.rate == null ? '—' : `${Math.round(conversion.rate * 100)}%`}</dd></div>
            </dl>
          )}
        </div>

        {revenue && (
          <p className="text-sm text-un1t-text">
            {revenue.offerCents == null
              ? `${revenue.purchases} ${revenue.purchases === 1 ? 'purchase' : 'purchases'}`
              : `Offer revenue ${EUR.format(revenue.offerCents / 100)} from ${revenue.purchases} ${revenue.purchases === 1 ? 'purchase' : 'purchases'}`}
          </p>
        )}

        <div>
          <h3 className="mb-1 text-sm font-semibold text-un1t-text">Follow-ups</h3>
          {!followups ? <Broken /> : followups.length === 0 ? (
            <p className="text-sm text-un1t-subtle">No follow-ups yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead><tr><Th>Stage</Th><Th right>Sent</Th><Th right>Failed</Th><Th right>Delivered</Th><Th right>Read</Th><Th right>Replied</Th><Th right>Class booked within 14 days</Th></tr></thead>
              <tbody>
                {followups.map((f) => (
                  <tr key={`${f.stageId}-${f.packKey}`}>
                    <Td>{stageName(f.stageId)}</Td><Td right>{f.sent}</Td><Td right>{f.failed}</Td><Td right>{f.delivered}</Td><Td right>{f.read}</Td><Td right>{f.replied}</Td><Td right>{f.bookedAfter}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    )
  }

  return (
    <Card>
      <h2 className="mb-3 text-lg font-semibold text-un1t-text">Report</h2>
      {body}
    </Card>
  )
}
