// /settings/integration-health — one pane consolidating integration status
// (FEAT-INTEG-HEALTH.1). Server-rendered from the shared aggregator so there's
// no client round-trip; the same data is available at /api/integrations/health.

import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { getIntegrationHealth, worstStatus } from '@/lib/integration-health'
import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

// Light-theme status chips (un1t-* palette — text on the -700 ramp per the
// check:guardrails no-low-contrast-chip rule).
const STATUS = {
  ok: { label: 'Healthy', chip: 'bg-green-500/10 text-green-700', dot: '#059669' },
  warn: { label: 'Degraded', chip: 'bg-amber-500/10 text-amber-700', dot: '#D97706' },
  down: { label: 'Down', chip: 'bg-red-500/10 text-red-700', dot: '#DC2626' },
  unknown: { label: 'Unknown', chip: 'bg-slate-500/10 text-slate-700', dot: '#64748B' },
}

function ago(iso) {
  if (!iso) return '—'
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (secs < 90) return 'just now'
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`
  return `${Math.round(secs / 86400)}d ago`
}

export default async function IntegrationHealthPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'settings')) redirect('/')
  const locationId = user.activeLocation?.id

  const db = createServerClient()
  const rows = locationId ? await getIntegrationHealth(db, locationId) : []
  const overall = worstStatus(rows)
  const o = STATUS[overall] || STATUS.unknown

  return (
    <div className="p-6 max-w-3xl">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-bold text-un1t-text">Integration health</h1>
        <span className={`text-xs font-medium px-2 py-0.5 rounded ${o.chip}`}>{o.label}</span>
      </div>
      <p className="text-sm text-un1t-subtle mb-6">
        One place to see whether anything is silently broken — scheduled jobs, WhatsApp, and webhook processing.
      </p>

      <div className="rounded-lg border border-un1t-border overflow-hidden">
        {rows.length === 0 ? (
          <div className="p-6 text-center text-sm text-un1t-subtle">No integrations to report.</div>
        ) : (
          rows.map((r) => {
            const s = STATUS[r.status] || STATUS.unknown
            return (
              <div key={r.key} className="flex items-center gap-3 px-4 py-3 border-b border-un1t-border last:border-b-0 bg-un1t-surface">
                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: s.dot }} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-un1t-text truncate">{r.name}</div>
                  <div className="text-xs text-un1t-subtle truncate">{r.detail}</div>
                </div>
                {r.lastSuccess ? (
                  <span className="text-xs text-un1t-subtle shrink-0 hidden sm:inline">last ok {ago(r.lastSuccess)}</span>
                ) : null}
                <span className={`text-[11px] font-medium px-2 py-0.5 rounded shrink-0 ${s.chip}`}>{s.label}</span>
              </div>
            )
          })
        )}
      </div>

      <p className="text-xs text-un1t-muted mt-4">
        Signals consolidated from cron heartbeats, WhatsApp number quality/token status, and the webhook dead-letter queue.
      </p>
    </div>
  )
}
