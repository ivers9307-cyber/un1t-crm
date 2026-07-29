'use client'

// Lazy-loaded recharts trend chart for MembershipPanel (TECH-DEBT.1).
//
// Split into its own chunk so recharts (~150KB) only ships when the
// membership trend actually renders — MembershipPanel dynamic-imports this
// with { ssr: false } instead of importing recharts at the top level, which
// previously pulled the whole charting lib into the dashboard bundle for
// every viewer regardless of whether trend data existed.
//
// TREND-DAILY.1 — two focused series (monthly recurring vs drop-in
// members) over daily snapshot points, replacing the three-line monthly
// chart that never accumulated enough points to read as a trend.

import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'

const SERIES = [
  { key: 'monthly_recurring', label: 'Monthly recurring', color: '#10b981' },
  { key: 'payg',              label: 'Drop-in members',   color: '#3b82f6' },
]

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// 'YYYY-MM-DD' → '29 Jul'. String math on the stored calendar date —
// never new Date(...) parsing, which shifts across the BST boundary.
function dayLabel(date) {
  if (typeof date !== 'string' || date.length < 10) return date
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]}`
}

export default function MembershipTrendChart({ trend }) {
  // Per-point dots read fine while the daily history is short but turn
  // into noise once a month-plus of points accumulates.
  const dots = (trend?.length || 0) <= 45
  return (
    <div style={{ width: '100%', height: 280 }}>
      <ResponsiveContainer>
        <LineChart data={trend} margin={{ top: 8, right: 12, bottom: 4, left: -8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" vertical={false} />
          <XAxis
            dataKey="date"
            stroke="#8b93a7"
            fontSize={12}
            tickLine={false}
            tickFormatter={dayLabel}
            minTickGap={28}
          />
          <YAxis stroke="#8b93a7" fontSize={12} tickLine={false} allowDecimals={false} width={40} />
          <Tooltip
            contentStyle={{ background: '#171a21', border: '1px solid #2a2f3a', borderRadius: 8, fontSize: 12 }}
            labelStyle={{ color: '#e7e9ee' }}
            labelFormatter={dayLabel}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {SERIES.map((s) => (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.label}
              stroke={s.color}
              strokeWidth={2}
              dot={dots ? { r: 3 } : false}
              activeDot={{ r: 5 }}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
