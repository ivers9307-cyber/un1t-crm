// ADS-FUNNEL — the /start booking-funnel drop-off panel for /dashboard/ads.
// Shows where visitors fall out of the wizard (landed → entered details → saw
// the times → booked), read from funnel_events. The single
// biggest between-stage drop is highlighted amber — the step most worth fixing.
// Presentational only (RSC-compatible, no directive).

import { Card } from '@/components/ui'

export default function AdsFunnelPanel({ funnel }) {
  const stages = funnel?.stages || []
  const total = funnel?.total || 0

  let worstIdx = -1
  let worstDrop = 0
  stages.forEach((s, i) => {
    if (i > 0 && s.dropFromPrev > worstDrop) { worstDrop = s.dropFromPrev; worstIdx = i }
  })

  return (
    <Card padding="md">
      <div className="flex items-baseline justify-between mb-4">
        <div>
          <div className="text-sm font-bold text-un1t-text">Booking funnel</div>
          <div className="text-xs text-un1t-subtle">Where /start visitors drop off — last 30 days</div>
        </div>
        <div className="text-xs text-un1t-subtle tabular-nums">{total.toLocaleString('en-IE')} visits</div>
      </div>

      {total === 0 ? (
        <p className="text-sm text-un1t-subtle">
          No funnel data yet — this fills in as ad traffic reaches the /start page.
        </p>
      ) : (
        <div className="space-y-2.5">
          {stages.map((s, i) => (
            <div key={s.key}>
              <div className="flex items-center justify-between text-sm mb-1">
                <span className="text-un1t-text">{s.label}</span>
                <span className="tabular-nums text-un1t-subtle">
                  {s.sessions.toLocaleString('en-IE')} · {s.pctOfTop}%
                </span>
              </div>
              <div className="h-2.5 rounded-full bg-black/5 overflow-hidden">
                <div
                  className={`h-full rounded-full ${i === worstIdx ? 'bg-amber-500' : 'bg-blue-500'}`}
                  style={{ width: `${Math.max(s.pctOfTop, 1)}%` }}
                />
              </div>
              {i > 0 && s.dropFromPrev > 0 && (
                <div className={`text-xs mt-0.5 ${i === worstIdx ? 'text-amber-700 font-medium' : 'text-un1t-subtle'}`}>
                  −{s.dropFromPrev}% from previous{i === worstIdx ? ' — biggest drop' : ''}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}
