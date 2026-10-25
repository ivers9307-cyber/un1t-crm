// INTEGONE.3 — the body of the retired /settings/integration-health page
// (FEAT-INTEG-HEALTH.1), now the hub's Health view
// (/settings/integrations-hub?view=health). Pure render: the hub page runs
// getIntegrationHealth for ONE studio out of its own org-scoped location list
// and hands the rows in, so this component never reads anything and a location
// outside the viewer's scope can never reach it.
//
// Server component (no state). The studio picker is server-rendered Links, the
// same shape as the section strip on /settings/locations/[id], so each studio
// is a shareable URL.

import Link from 'next/link'
import { hubViewHref } from '@/lib/integrations-hub-links'

// Light-theme status chips (un1t-* palette — text on the -700 ramp per the
// check:guardrails no-low-contrast-chip rule).
export const HEALTH_STATUS = {
  ok: { label: 'Healthy', chip: 'bg-green-500/10 text-green-700', dot: '#059669' },
  warn: { label: 'Degraded', chip: 'bg-amber-500/10 text-amber-700', dot: '#D97706' },
  down: { label: 'Down', chip: 'bg-red-500/10 text-red-700', dot: '#DC2626' },
  unknown: { label: 'Unknown', chip: 'bg-slate-500/10 text-slate-700', dot: '#64748B' },
}

export function ago(iso, now = Date.now()) {
  if (!iso) return '—'
  const secs = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (secs < 90) return 'just now'
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`
  return `${Math.round(secs / 86400)}d ago`
}

/**
 * @param {object} props
 * @param {Array}  props.rows                getIntegrationHealth() rows for the selected studio
 * @param {string} props.overall             worstStatus(rows)
 * @param {string|null} props.locationName   the selected studio's name
 * @param {Array<{id: string, name: string}>} props.locations  the studios in scope (the hub's own list)
 * @param {string|null} props.selectedLocationId
 */
export default function IntegrationHealthPanel({ rows = [], overall = 'unknown', locationName = null, locations = [], selectedLocationId = null }) {
  const o = HEALTH_STATUS[overall] || HEALTH_STATUS.unknown
  return (
    <div className="max-w-3xl" data-testid="integration-health-panel">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-xl font-bold text-un1t-text">
          Integration health{locationName ? <span className="text-un1t-subtle font-medium"> · {locationName}</span> : null}
        </h2>
        <span className={`text-xs font-medium px-2 py-0.5 rounded ${o.chip}`}>{o.label}</span>
      </div>
      <p className="text-sm text-un1t-subtle mb-4">
        One place to see whether anything is silently broken — scheduled jobs, WhatsApp, webhook processing, Glofox, Xero, and email delivery. Anything degraded shows what to do about it.
      </p>

      {locations.length > 1 ? (
        <div className="flex flex-wrap items-center gap-2 mb-4" role="group" aria-label="Studio">
          <span className="text-[10px] uppercase tracking-wider text-un1t-muted">Location</span>
          <div className="inline-flex gap-0.5 rounded-lg border border-un1t-border bg-white p-0.5">
            {locations.map((l) => {
              const selected = l.id === selectedLocationId
              return (
                <Link
                  key={l.id}
                  href={hubViewHref('health', l.id)}
                  aria-current={selected ? 'page' : undefined}
                  className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                    selected ? 'bg-un1t-accent text-white' : 'text-un1t-subtle hover:text-un1t-text'
                  }`}
                >
                  {l.name}
                </Link>
              )
            })}
          </div>
        </div>
      ) : null}

      <div className="rounded-lg border border-un1t-border overflow-hidden">
        {rows.length === 0 ? (
          <div className="p-6 text-center text-sm text-un1t-subtle">No integrations to report.</div>
        ) : (
          rows.map((r) => {
            const s = HEALTH_STATUS[r.status] || HEALTH_STATUS.unknown
            return (
              <div key={r.key} className="flex items-start gap-3 px-4 py-3 border-b border-un1t-border last:border-b-0 bg-un1t-surface">
                <span className="w-2.5 h-2.5 rounded-full shrink-0 mt-1.5" style={{ backgroundColor: s.dot }} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-un1t-text truncate">{r.name}</div>
                  <div className="text-xs text-un1t-subtle truncate">{r.detail}</div>
                  {r.remedy ? (
                    <div className="text-xs text-un1t-muted mt-1">
                      {r.remedy}
                      {r.href ? (
                        <>{' '}<Link href={r.href} className="text-mia hover:underline font-medium">Fix →</Link></>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                {r.lastSuccess ? (
                  <span className="text-xs text-un1t-subtle shrink-0 hidden sm:inline mt-0.5">last ok {ago(r.lastSuccess)}</span>
                ) : null}
                <span className={`text-[11px] font-medium px-2 py-0.5 rounded shrink-0 mt-0.5 ${s.chip}`}>{s.label}</span>
              </div>
            )
          })
        )}
      </div>

      <p className="text-xs text-un1t-muted mt-4">
        Signals consolidated from cron heartbeats, WhatsApp number quality/token status, the webhook dead-letter queue, the Glofox &amp; Xero connections, and Postmark bounce/complaint rates (last 24h).
      </p>
    </div>
  )
}
