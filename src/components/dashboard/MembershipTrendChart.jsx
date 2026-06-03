'use client'

// Lazy-loaded recharts trend chart for MembershipPanel (TECH-DEBT.1).
//
// Split into its own chunk so recharts (~150KB) only ships when the
// membership trend actually renders — MembershipPanel dynamic-imports this
// with { ssr: false } instead of importing recharts at the top level, which
// previously pulled the whole charting lib into the dashboard bundle for
// every viewer regardless of whether trend data existed.

import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'

const SERIES = [
  { key: 'monthly_recurring', label: 'Monthly recurring', color: '#10b981' },
  { key: 'class_packs',       label: 'Class packs',       color: '#3b82f6' },
  { key: 'payg',             label: 'Pay-as-you-go',      color: '#a78bfa' },
]

export default function MembershipTrendChart({ trend }) {
  return (
    <div style={{ width: '100%', height: 280 }}>
      <ResponsiveContainer>
        <LineChart data={trend} margin={{ top: 8, right: 12, bottom: 4, left: -8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" vertical={false} />
          <XAxis dataKey="month" stroke="#8b93a7" fontSize={12} tickLine={false} />
          <YAxis stroke="#8b93a7" fontSize={12} tickLine={false} allowDecimals={false} width={40} />
          <Tooltip
            contentStyle={{ background: '#171a21', border: '1px solid #2a2f3a', borderRadius: 8, fontSize: 12 }}
            labelStyle={{ color: '#e7e9ee' }}
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
              dot={{ r: 3 }}
              activeDot={{ r: 5 }}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
