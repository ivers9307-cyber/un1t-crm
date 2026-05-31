'use client'

// MembershipPanel — DASH-MEMBERSHIP.2.
//
// Business-board membership section: live breakdown KPI cards (read
// from contacts on each load, always current) + a 12-month trend chart
// (read from membership_snapshots, grows one point per month).
//
// Receives already-fetched data from the server page so it stays a thin
// presentation component. Recharts is the charting lib (DASH-MEMBERSHIP
// recommendation — scales to the further board panels).

import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'
import { KpiCard, KpiRow, SectionHeader } from './Cards'

const SERIES = [
  { key: 'monthly_recurring', label: 'Monthly recurring', color: '#10b981' },
  { key: 'class_packs',       label: 'Class packs',       color: '#3b82f6' },
  { key: 'payg',             label: 'Pay-as-you-go',      color: '#a78bfa' },
]

export function MembershipPanel({ live, trend }) {
  const l = live || {}
  const hasTrend = Array.isArray(trend) && trend.length > 0

  return (
    <>
      <SectionHeader title="Membership" />

      <KpiRow>
        <KpiCard
          label="Monthly recurring"
          value={l.monthly_recurring ?? 0}
          sublabel={`${l.active_recurring ?? 0} active subscriptions`}
          accent="text-green-500"
        />
        <KpiCard
          label="Class packs"
          value={l.class_packs ?? 0}
          sublabel={`${l.dead_packs ?? 0} with no credits left`}
          accent={(l.dead_packs ?? 0) > 0 ? 'text-amber-500' : 'text-un1t-text'}
        />
      </KpiRow>
      <KpiRow>
        <KpiCard
          label="Pay-as-you-go"
          value={l.payg ?? 0}
          sublabel="drop-in credit buyers"
        />
        <KpiCard
          label="Total members"
          value={l.total_members ?? 0}
          sublabel="all Glofox member records"
        />
      </KpiRow>

      <SectionHeader title="Membership trend (12 months)" />
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-4">
        {hasTrend ? (
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
        ) : (
          <p className="text-sm text-un1t-muted py-8 text-center">
            Trend starts building from the first monthly snapshot. Check back next month
            for the first data point.
          </p>
        )}
      </div>
    </>
  )
}
