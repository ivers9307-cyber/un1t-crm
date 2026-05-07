// Web-side KPI card primitives. Pure presentational — no data
// fetching here, no mobile-specific styling. Visual parity with the
// mobile dashboard cards via the shared un1t-* Tailwind tokens.

import Link from 'next/link'

export function KpiCard({ label, value, sublabel, accent, href }) {
  const Wrap = href ? Link : 'div'
  const wrapProps = href ? { href } : {}
  return (
    <Wrap
      {...wrapProps}
      className="block flex-1 bg-un1t-dark border border-un1t-gray rounded-2xl p-4 hover:border-un1t-mid/50 transition-colors"
    >
      <div className="text-xs uppercase tracking-wider text-un1t-light">{label}</div>
      <div className={`text-3xl font-bold mt-1 ${accent || 'text-un1t-white'}`}>
        {value ?? '—'}
      </div>
      {sublabel ? (
        <div className="text-xs text-un1t-light mt-0.5">{sublabel}</div>
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
  return (
    <div className="flex items-center justify-between mt-6 mb-2 px-1">
      <div className="flex items-center">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light">{title}</h3>
        {count != null && count > 0 ? (
          <span className="ml-2 min-w-[20px] h-5 px-1.5 rounded-full bg-un1t-white text-un1t-black text-[11px] font-semibold flex items-center justify-center">
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
      <div className="bg-un1t-dark border border-un1t-gray rounded-2xl p-4 text-center">
        <p className="text-sm text-un1t-light">{emptyText || 'Nothing pending.'}</p>
      </div>
    )
  }
  return (
    <div className="bg-un1t-dark border border-un1t-gray rounded-2xl overflow-hidden">
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
        !isLast ? 'border-b border-un1t-gray' : ''
      } ${href ? 'hover:bg-un1t-gray/30' : ''}`}
    >
      {icon ? <span className="mr-3 text-un1t-light">{icon}</span> : null}
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-un1t-white truncate">{title}</div>
        {subtitle ? (
          <div className="text-xs text-un1t-light truncate">{subtitle}</div>
        ) : null}
      </div>
      {time ? <div className="text-xs text-un1t-light ml-2">{time}</div> : null}
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
