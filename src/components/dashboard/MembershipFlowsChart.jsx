'use client'

// Lazy-loaded recharts chart for MembershipPanel (TREND-FLOWS.1) —
// weekly membership sales vs cancellations as grouped bars. Same
// lazy-chunk pattern as the previous trend chart: MembershipPanel
// dynamic-imports this with { ssr: false } so recharts (~150KB) only
// ships when the section renders.
//
// Weeks where a series is null (before its data source existed) render
// as gaps, not zeroes — recharts skips null bars natively.

import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// 'YYYY-MM-DD' → '12 May'. String math on the stored calendar date —
// never new Date(...) parsing, which shifts across the BST boundary.
function weekLabel(week) {
  if (typeof week !== 'string' || week.length < 10) return week
  return `${Number(week.slice(8, 10))} ${MONTHS[Number(week.slice(5, 7)) - 1]}`
}

export default function MembershipFlowsChart({ weeks }) {
  return (
    <div style={{ width: '100%', height: 280 }}>
      <ResponsiveContainer>
        <BarChart data={weeks} margin={{ top: 8, right: 12, bottom: 4, left: -8 }} barGap={2}>
          <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" vertical={false} />
          <XAxis dataKey="week" stroke="#8b93a7" fontSize={12} tickLine={false} tickFormatter={weekLabel} />
          <YAxis stroke="#8b93a7" fontSize={12} tickLine={false} allowDecimals={false} width={40} />
          <Tooltip
            cursor={{ fill: 'rgba(139, 147, 167, 0.08)' }}
            contentStyle={{ background: '#171a21', border: '1px solid #2a2f3a', borderRadius: 8, fontSize: 12 }}
            labelStyle={{ color: '#e7e9ee' }}
            labelFormatter={(w) => `Week of ${weekLabel(w)}`}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="sales" name="Memberships sold" fill="#10b981" radius={[3, 3, 0, 0]} />
          <Bar dataKey="cancellations" name="Cancellations" fill="#ef4444" radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
