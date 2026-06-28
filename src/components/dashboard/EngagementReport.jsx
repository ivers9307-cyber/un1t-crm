// P2-7 (Part B) — engagement→churn report body. Server-rendered presentational
// component (no client state): a headline comparison, adoption KPIs, and the
// friend-tier × churn-risk/attendance cross-tab. Shape comes from
// summarizeEngagementChurn (src/lib/engagement-analytics.js).

import { KpiCard, KpiRow, SectionHeader } from '@/components/dashboard/Cards'

function pct(n) { return n == null ? '—' : `${Math.round(n * 100)}%` }
function oneDp(n) { return n == null ? '—' : (Math.round(n * 10) / 10).toString() }
function months(days) { return days == null ? '—' : `${Math.round(days / 30)} mo` }

export default function EngagementReport({ report }) {
  const { totalMembers, withFriends, adoptionPct, buckets, headline } = report

  return (
    <>
      <SectionHeader title="The retention thesis" />
      <KpiRow>
        <KpiCard
          label="At-risk — no friends"
          value={pct(headline.lowAtRiskPct)}
          sublabel="members with 0 friends flagged at-risk"
          accent="text-red-500"
        />
        <KpiCard
          label="At-risk — 3+ friends"
          value={headline.insufficientData ? '—' : pct(headline.highAtRiskPct)}
          sublabel={headline.insufficientData
            ? `only ${headline.highSample} member${headline.highSample === 1 ? '' : 's'} with 3+ friends so far`
            : `${headline.highSample} members with 3+ friends`}
          accent="text-green-500"
        />
      </KpiRow>

      {headline.supported && headline.atRiskDelta != null && (
        <p className="text-sm text-un1t-text mt-1 px-1">
          Members with 3+ friends are{' '}
          <strong>{Math.round(headline.atRiskDelta * 100)} points</strong>{' '}
          less likely to be at risk than members with none — community is keeping people training.
        </p>
      )}
      {headline.insufficientData && (
        <p className="text-sm text-un1t-muted mt-1 px-1">
          Not enough members have connected with friends yet to prove the trend. Driving app +
          friend adoption is the first step — watch this number as the base grows.
        </p>
      )}

      <SectionHeader title="App &amp; social adoption" />
      <KpiRow>
        <KpiCard label="Active members" value={String(totalMembers)} sublabel="live membership base" />
        <KpiCard
          label="With ≥1 friend"
          value={String(withFriends)}
          sublabel={`${pct(adoptionPct)} of members`}
          accent={withFriends > 0 ? 'text-un1t-text' : 'text-un1t-muted'}
        />
      </KpiRow>

      <SectionHeader title="Friend tier vs churn-risk &amp; attendance" />
      <div className="overflow-hidden rounded-lg border border-un1t-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-un1t-surface text-un1t-subtle text-left">
              <th className="px-3 py-2 font-medium">Friend tier</th>
              <th className="px-3 py-2 font-medium text-right">Members</th>
              <th className="px-3 py-2 font-medium text-right">At-risk</th>
              <th className="px-3 py-2 font-medium text-right">Avg classes&nbsp;/&nbsp;30d</th>
              <th className="px-3 py-2 font-medium text-right">Avg tenure</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((b) => (
              <tr key={b.key} className="border-t border-un1t-border">
                <td className="px-3 py-2 text-un1t-text">{b.label}</td>
                <td className="px-3 py-2 text-right text-un1t-text">{b.members}</td>
                <td className="px-3 py-2 text-right text-un1t-text">{b.members ? pct(b.atRiskPct) : '—'}</td>
                <td className="px-3 py-2 text-right text-un1t-text">{oneDp(b.avgAttended30d)}</td>
                <td className="px-3 py-2 text-right text-un1t-text">{months(b.avgTenureDays)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-un1t-muted mt-2 px-1">
        At-risk = the churn radar&rsquo;s attendance signals firing. Friends = mutual connections in
        the member app (same studio).
      </p>
    </>
  )
}
