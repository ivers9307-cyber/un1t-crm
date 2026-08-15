// Web-side KPI card primitives. Pure presentational — no data
// fetching here, no mobile-specific styling. Visual parity with the
// mobile dashboard cards via the shared un1t-* Tailwind tokens.

import Link from 'next/link'

export function KpiCard({ label, value, sublabel, accent, href }) {
  const Wrap = href ? Link : 'div'
  const wrapProps = href ? { href } : {}
  // Only signal "clickable" when the card actually links somewhere —
  // a static KPI shouldn't get a hover cue it can't act on.
  const interactive = href
    ? 'hover:border-un1t-muted/50 hover:bg-un1t-border/10 transition-colors cursor-pointer'
    : ''
  return (
    <Wrap
      {...wrapProps}
      className={`block flex-1 bg-un1t-surface border border-un1t-border rounded-2xl p-4 ${interactive}`}
    >
      <div className="text-xs uppercase tracking-wider text-un1t-subtle">{label}</div>
      <div className={`text-3xl font-bold mt-1 ${accent || 'text-un1t-text'}`}>
        {value ?? '—'}
      </div>
      {sublabel ? (
        <div className="text-xs text-un1t-subtle mt-0.5">{sublabel}</div>
      ) : null}
    </Wrap>
  )
}

export function KpiRow({ children }) {
  // Stack vertically below sm (640px) so each KPI gets full width
  // on a phone — values like "€12.4k" no longer wrap mid-character.
  // sm+ retains the original side-by-side row.
  return <div className="flex flex-col sm:flex-row gap-3 mb-3">{children}</div>
}

export function SectionHeader({ title, count, action }) {
  // HOME.3 — `count` is a number everywhere except the home-queue badge,
  // which can pass a capped-total string like "30+" (queueCountLabel in
  // src/lib/home-queue.js). `count > 0` string-coerces "30+" to NaN and
  // silently drops the badge, so the guard checks non-zero instead of
  // positive — every existing numeric caller only ever passes null or a
  // positive length (never an explicit 0), so this is behaviour-preserving
  // for them.
  const showBadge = count != null && count !== 0 && count !== '0'
  return (
    <div className="flex items-center justify-between mt-6 mb-2 px-1">
      <div className="flex items-center">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">{title}</h3>
        {showBadge ? (
          <span className="ml-2 min-w-[20px] h-5 px-1.5 rounded-full bg-un1t-text text-un1t-bg text-[11px] font-semibold flex items-center justify-center">
            {count}
          </span>
        ) : null}
      </div>
      {action}
    </div>
  )
}

export function ListCard({ children, empty, emptyText }) {
  if (empty) {
    return (
      <div className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 text-center">
        <p className="text-sm text-un1t-subtle">{emptyText || 'Nothing pending.'}</p>
      </div>
    )
  }
  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-2xl overflow-hidden">
      {children}
    </div>
  )
}

export function PendingRow({ icon, title, subtitle, time, href, isLast }) {
  const Wrap = href ? Link : 'div'
  const wrapProps = href ? { href } : {}
  return (
    <Wrap
      {...wrapProps}
      className={`flex items-center px-4 py-3 ${
        !isLast ? 'border-b border-un1t-border' : ''
      } ${href ? 'hover:bg-un1t-border/30' : ''}`}
    >
      {icon ? <span className="mr-3 text-un1t-subtle">{icon}</span> : null}
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-un1t-text truncate">{title}</div>
        {subtitle ? (
          <div className="text-xs text-un1t-subtle truncate">{subtitle}</div>
        ) : null}
      </div>
      {time ? <div className="text-xs text-un1t-subtle ml-2">{time}</div> : null}
    </Wrap>
  )
}

export function formatCurrency(n) {
  if (n == null) return '—'
  if (n >= 1000) return `€${(n / 1000).toFixed(1)}k`
  return `€${Math.round(n)}`
}

export function formatPercent(n) {
  if (n == null) return '—'
  return `${n}%`
}
