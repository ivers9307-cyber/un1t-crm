'use client'

// Lazy-loaded recharts chart for MembershipPanel (TREND-FLOWS.1;
// monthly buckets since TREND-FLOWS.2) — membership sales vs
// cancellations as grouped monthly bars. Same lazy-chunk pattern as
// before: MembershipPanel dynamic-imports this with { ssr: false } so
// recharts (~150KB) only ships when the section renders.
//
// Months where a series is null (before its data source existed)
// render as gaps, not zeroes — recharts skips null bars natively.

import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// 'YYYY-MM' → 'May' (or 'Jan 27' at a year boundary so multi-year
// windows stay readable). String math on the stored calendar month —
// never new Date(...) parsing.
function monthLabel(month) {
  if (typeof month !== 'string' || month.length < 7) return month
  const name = MONTHS[Number(month.slice(5, 7)) - 1]
  return month.endsWith('-01') ? `${name} ${month.slice(2, 4)}` : name
}

// Tooltip wants the unambiguous form: 'May 2026'.
function monthLabelFull(month) {
  if (typeof month !== 'string' || month.length < 7) return month
  return `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`
}

export default function MembershipFlowsChart({ months }) {
  return (
    <div style={{ width: '100%', height: 280 }}>
      <ResponsiveContainer>
        <BarChart data={months} margin={{ top: 8, right: 12, bottom: 4, left: -8 }} barGap={2}>
          <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" vertical={false} />
          <XAxis dataKey="month" stroke="#8b93a7" fontSize={12} tickLine={false} tickFormatter={monthLabel} />
          <YAxis stroke="#8b93a7" fontSize={12} tickLine={false} allowDecimals={false} width={40} />
          <Tooltip
            cursor={{ fill: 'rgba(139, 147, 167, 0.08)' }}
            contentStyle={{ background: '#171a21', border: '1px solid #2a2f3a', borderRadius: 8, fontSize: 12 }}
            labelStyle={{ color: '#e7e9ee' }}
            labelFormatter={monthLabelFull}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="sales" name="Memberships sold" fill="#10b981" radius={[3, 3, 0, 0]} />
          <Bar dataKey="cancellations" name="Cancellations" fill="#ef4444" radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
