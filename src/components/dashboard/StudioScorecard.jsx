// STUDIO-KPI.1 — presentational pieces for the Studio scorecard.
// Server-component-safe (no state, no effects); data shaping happens in
// shared/studio-kpi-math.js + the page's per-location loader.

import Link from 'next/link'
import { formatCurrency } from '@/components/dashboard/Cards'

// Compact KPI cell — the scorecard packs 6+ per location column, so
// these are denser than the full-width KpiCard. href follows the
// KpiCard rule: hover affordance only when the cell actually links.
export function ScoreCell({ label, value, sublabel, accent, estimated, href }) {
  const Wrap = href ? Link : 'div'
  const wrapProps = href ? { href } : {}
  const interactive = href
    ? 'hover:border-un1t-muted/50 hover:bg-un1t-border/10 transition-colors cursor-pointer'
    : ''
  return (
    <Wrap {...wrapProps} className={`block bg-un1t-surface border border-un1t-border rounded-2xl p-3 ${interactive}`}>
      <div className="text-[11px] uppercase tracking-wider text-un1t-subtle">{label}</div>
      <div className={`text-2xl font-bold mt-0.5 ${accent || 'text-un1t-text'}`}>
        {value ?? '—'}
        {estimated ? <span className="text-xs font-normal text-un1t-subtle ml-1">est.</span> : null}
      </div>
      {sublabel ? (
        <div className="text-[11px] text-un1t-subtle mt-0.5">{sublabel}</div>
      ) : null}
    </Wrap>
  )
}

export function ScoreGrid({ children }) {
  return <div className="grid grid-cols-2 gap-2 mb-1">{children}</div>
}

export function RoleSection({ title, hint, children }) {
  return (
    <div className="mt-5">
      <div className="flex items-baseline justify-between mb-2 px-1">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">{title}</h3>
        {hint ? <span className="text-[11px] text-un1t-muted">{hint}</span> : null}
      </div>
      {children}
    </div>
  )
}

// Floor breakdown table (by coach when Glofox sends instructor names,
// else by class) — staff-facing raw counts are fine here (the
// no-capacity-to-customers rule binds customer surfaces, not the CRM).
export function FloorTable({ rows, groupedBy }) {
  if (!rows || rows.length === 0) {
    return (
      <div className="bg-un1t-surface border border-un1t-border rounded-2xl p-4 text-center">
        <p className="text-sm text-un1t-subtle">No class data in the last 28 days.</p>
      </div>
    )
  }
  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-2xl overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[11px] uppercase tracking-wider text-un1t-subtle border-b border-un1t-border">
            <th className="text-left font-semibold px-4 py-2">{groupedBy === 'coach' ? 'Coach' : 'Class'}</th>
            <th className="text-right font-semibold px-2 py-2">Classes</th>
            <th className="text-right font-semibold px-2 py-2">Fill</th>
            <th className="text-right font-semibold px-4 py-2">No-show</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((g, i) => (
            <tr key={g.label} className={i < rows.length - 1 ? 'border-b border-un1t-border' : ''}>
              <td className="px-4 py-2 text-un1t-text truncate max-w-[12rem]">{g.label}</td>
              <td className="px-2 py-2 text-right text-un1t-text">{g.classes}</td>
              <td className="px-2 py-2 text-right text-un1t-text">{g.fillPct != null ? `${g.fillPct}%` : '—'}</td>
              <td className="px-4 py-2 text-right text-un1t-text">{g.noShowPct != null ? `${g.noShowPct}%` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {groupedBy === 'class' ? (
        <p className="text-[11px] text-un1t-muted px-4 py-2 border-t border-un1t-border">
          Split by class — per-coach arrives once Glofox trainer names are mapped.
        </p>
      ) : null}
    </div>
  )
}

export function LocationEmptyState({ name }) {
  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-2xl p-6 text-center">
      <p className="text-sm font-medium text-un1t-text">{name} isn't connected to Glofox yet</p>
      <p className="text-xs text-un1t-subtle mt-1">
        The scorecard fills in automatically once the location's Glofox sync goes live.
      </p>
    </div>
  )
}

// The KPIs the framework calls for that have no instrumentation yet —
// rendered as an honest single line, never as fake zeros.
export function NotTrackedYet() {
  return (
    <p className="text-[11px] text-un1t-muted mt-6 px-1">
      Not tracked yet (instrumentation pending): referral rate · speed-to-lead ·
      cancellation save rate · arrears 14-day recovery rate.
    </p>
  )
}

export function euros(cents) {
  return cents == null ? null : formatCurrency(cents / 100)
}
