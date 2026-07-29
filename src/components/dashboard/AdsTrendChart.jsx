'use client'

// ADS-REPORT.3 — lazy-loaded recharts trend chart for /dashboard/ads.
//
// Mirrors MembershipFlowsChart.jsx: its own chunk so recharts only
// ships when the ads trend actually renders — the page dynamic-imports
// this with { ssr: false } instead of importing recharts at the top
// level.

import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'

export default function AdsTrendChart({ data }) {
  if (!Array.isArray(data) || data.length === 0) {
    return <p className="text-sm text-un1t-muted py-6 text-center">No trend yet.</p>
  }

  return (
    <div style={{ width: '100%', height: 280 }}>
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: -8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" vertical={false} />
          <XAxis dataKey="date" stroke="#8b93a7" fontSize={12} tickLine={false} />
          <YAxis yAxisId="spend" stroke="#8b93a7" fontSize={12} tickLine={false} width={48} />
          <YAxis yAxisId="bookings" orientation="right" stroke="#8b93a7" fontSize={12} tickLine={false} allowDecimals={false} width={40} />
          <Tooltip
            contentStyle={{ background: '#171a21', border: '1px solid #2a2f3a', borderRadius: 8, fontSize: 12 }}
            labelStyle={{ color: '#e7e9ee' }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Line
            yAxisId="spend"
            type="monotone"
            dataKey="spend"
            name="Spend (€)"
            stroke="#3b82f6"
            strokeWidth={2}
            dot={{ r: 3 }}
            activeDot={{ r: 5 }}
          />
          <Line
            yAxisId="bookings"
            type="monotone"
            dataKey="bookings"
            name="Bookings"
            stroke="#10b981"
            strokeWidth={2}
            dot={{ r: 3 }}
            activeDot={{ r: 5 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
