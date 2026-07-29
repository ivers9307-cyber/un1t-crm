'use client'
// InBodyCharts.jsx — CONSULTATIONS SP1
//
// Lazy-loaded recharts chunk for InBodyProgress. Split into its own
// module (same approach as MembershipFlowsChart.jsx) so recharts
// (~150KB) only ships when a contact has InBody scans to plot — the
// parent dynamic-imports this with { ssr: false }.
//
// Props:
//   series — Array<{ key, label, color, data: [{ x, y }] }> where x is
//            an ISO scanned_at and y the metric value (from scanSeries()).
//            One small line chart is rendered per series that has data.

import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts'

function tickDate(iso) {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return ''
  return d.toLocaleDateString('en-IE', { day: 'numeric', month: 'short' })
}

export default function InBodyCharts({ series = [] }) {
  const withData = series.filter((s) => Array.isArray(s.data) && s.data.length > 0)

  if (withData.length === 0) {
    return <p className="text-sm text-un1t-muted">No metric history to chart yet.</p>
  }

  return (
    <div className="space-y-4">
      {withData.map((s) => (
        <div key={s.key}>
          <p className="text-xs font-medium text-un1t-subtle mb-1">{s.label}</p>
          <div style={{ width: '100%', height: 180 }}>
            <ResponsiveContainer>
              <LineChart data={s.data} margin={{ top: 8, right: 12, bottom: 4, left: -12 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E2E5E9" vertical={false} />
                <XAxis dataKey="x" tickFormatter={tickDate} stroke="#94A3B8" fontSize={11} tickLine={false} />
                <YAxis stroke="#94A3B8" fontSize={11} tickLine={false} width={36} domain={['auto', 'auto']} />
                <Tooltip
                  labelFormatter={tickDate}
                  contentStyle={{ background: '#FFFFFF', border: '1px solid #E2E5E9', borderRadius: 8, fontSize: 12 }}
                  labelStyle={{ color: '#111827' }}
                />
                <Line
                  type="monotone"
                  dataKey="y"
                  name={s.label}
                  stroke={s.color}
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  activeDot={{ r: 5 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      ))}
    </div>
  )
}
