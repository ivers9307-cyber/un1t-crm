// src/components/dashboard/BusinessBlocks.jsx
//
// DASH-REBUILD — presentational pieces for the rebuilt Business
// dashboard. Server-component-safe (no state). Data shapes come from
// shared/dashboard-data.js fetchers + src/lib/dashboard/business-rail.
import Link from 'next/link'

export function BriefingLine({ text }) {
  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-lg px-4 py-3 text-sm text-un1t-text mb-4">
      {text}
    </div>
  )
}

export function FunnelMini({ funnel }) {
  const max = Math.max(1, ...funnel.stages.map(s => s.count))
  const LABELS = { new_lead: 'New', first_class: '1st', second_class: '2nd', trial_done: 'Trial', converted: 'Won' }
  return (
    <div>
      <div className="flex items-end gap-1.5 h-20">
        {funnel.stages.map(s => (
          <div key={s.slug} className="flex-1 flex flex-col justify-end items-center gap-1">
            <span className="text-[10px] text-un1t-muted">{s.count}</span>
            <div
              className="w-full rounded-t bg-purple-500/60"
              style={{ height: `${Math.max(6, (s.count / max) * 60)}px` }}
            />
            <span className="text-[10px] text-un1t-subtle">{LABELS[s.slug] || s.slug}</span>
          </div>
        ))}
      </div>
      <p className="text-xs text-un1t-muted mt-2">
        {funnel.entered} entered this month → {funnel.converted} converted
        {funnel.conversionPct != null ? ` · ${funnel.conversionPct}%` : ''}
      </p>
      <Link href="/pipeline" className="text-xs text-un1t-muted underline hover:text-un1t-text mt-2 inline-block">
        Open pipeline
      </Link>
    </div>
  )
}

export function AdsSummaryPanel({ ads }) {
  return (
    <div>
      <p className="text-lg font-semibold text-un1t-text">
        €{Math.round(ads.spend).toLocaleString('en-IE')} spend · {ads.results} results
      </p>
      <p className="text-xs text-un1t-muted mt-1">
        {ads.costPerResult != null ? `€${ads.costPerResult.toFixed(2)} per result` : 'no results yet'}
        {' · '}{ads.attributedContacts} contact{ads.attributedContacts === 1 ? '' : 's'} attributed (7d)
      </p>
      <Link href="/dashboard/ads" className="text-xs text-un1t-muted underline hover:text-un1t-text mt-2 inline-block">
        Full ads report
      </Link>
    </div>
  )
}

export function TodayStrip({ ops, locationName }) {
  const items = [
    [String(ops.bookedToday), `booked · ${ops.classesToday} classes`],
    [String(ops.staffToday), 'staff on'],
    [`€${Math.round(ops.labourWeekCents / 100).toLocaleString('en-IE')}`, `labour this week · ${ops.hoursWeek}h`],
  ]
  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-lg px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-1">
      <span className="text-xs text-un1t-muted">Today{locationName ? ` at ${locationName}` : ''}</span>
      {items.map(([v, label]) => (
        <span key={label} className="text-sm text-un1t-text">
          <span className="font-semibold">{v}</span>{' '}
          <span className="text-un1t-subtle">{label}</span>
        </span>
      ))}
    </div>
  )
}

const RAIL_TONES = {
  purple: 'bg-purple-500/10 text-purple-700',
  red: 'bg-red-500/10 text-red-700',
  amber: 'bg-amber-500/10 text-amber-700',
  teal: 'bg-teal-500/10 text-teal-700',
}

export function NeedsYouRail({ rows }) {
  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-lg px-3 py-3">
      <p className="text-xs font-semibold text-un1t-muted mb-1">
        Needs you{rows.length ? ` · ${rows.length}` : ''}
      </p>
      {rows.length === 0 && (
        <p className="text-sm text-un1t-subtle py-2">Nothing waiting on you.</p>
      )}
      {rows.map(row => (
        <Link
          key={row.key}
          href={row.href}
          className="flex items-start gap-2 border-t border-un1t-border/50 py-2 text-sm text-un1t-text hover:bg-un1t-border/10 -mx-1 px-1 rounded"
        >
          <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full shrink-0 mt-0.5 ${RAIL_TONES[row.tone] || RAIL_TONES.purple}`}>
            {row.chip}
          </span>
          <span>{row.text}</span>
        </Link>
      ))}
    </div>
  )
}

export function BlockSkeleton({ lines = 3 }) {
  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-lg px-4 py-3 animate-pulse">
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className="h-3 bg-un1t-border/40 rounded my-2" style={{ width: `${80 - i * 15}%` }} />
      ))}
    </div>
  )
}

export function BlockError({ label }) {
  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-lg px-4 py-3">
      <p className="text-xs text-un1t-muted">{label} couldn&apos;t load — refresh to retry.</p>
    </div>
  )
}
