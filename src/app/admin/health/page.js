// SAAS4-O4 — /admin/health: the master "is every tenant OK" morning
// view (SaaS machinery plan §4). One row per active location, grouped
// by organisation: per-tenant cron heartbeats (mig 412), integrations
// registry connection state (INTEG-A2, maintained by the
// connection-health cron), month-to-date AI cost, and the live
// campaign backlog. Composes existing signals — builds none.
//
// Auth: inherits the master-only gate from /admin/layout.js.

import { createServerClient } from '@/lib/supabase'
import { getTenantHealth } from '@/lib/tenant-health'
import Link from 'next/link'
import { ArrowLeft, Activity } from 'lucide-react'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function fmtStale(seconds) {
  if (seconds == null) return '—'
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  if (seconds < 172800) return `${Math.round(seconds / 3600)}h`
  return `${Math.round(seconds / 86400)}d`
}

function HeartbeatChip({ hb }) {
  if (hb.muted) {
    return <span className="inline-block rounded-full px-2 py-0.5 text-xs bg-gray-500/10 text-gray-700">{hb.name} · muted</span>
  }
  return hb.is_stale ? (
    <span className="inline-block rounded-full px-2 py-0.5 text-xs bg-red-500/10 text-red-700">{hb.name} · stale {fmtStale(hb.stale_seconds)}</span>
  ) : (
    <span className="inline-block rounded-full px-2 py-0.5 text-xs bg-green-500/10 text-green-700">{hb.name} · {fmtStale(hb.stale_seconds)}</span>
  )
}

function ConnectionChip({ c }) {
  const ok = !c.status || c.status === 'connected'
  return ok ? (
    <span className="inline-block rounded-full px-2 py-0.5 text-xs bg-green-500/10 text-green-700">{c.platform}</span>
  ) : (
    <span className="inline-block rounded-full px-2 py-0.5 text-xs bg-red-500/10 text-red-700" title={c.last_error || undefined}>
      {c.platform} · {c.status}
    </span>
  )
}

export default async function TenantHealthPage() {
  const db = createServerClient()
  const orgs = await getTenantHealth(db)

  return (
    <div className="p-6 max-w-5xl">
      <Link href="/admin/matrix" className="inline-flex items-center gap-1.5 text-sm text-un1t-subtle hover:text-un1t-text mb-4">
        <ArrowLeft size={14} /> Admin
      </Link>

      <div className="flex items-center gap-2 mb-1">
        <Activity size={20} className="text-un1t-subtle" />
        <h1 className="text-2xl font-semibold">Tenant health</h1>
      </div>
      <p className="text-sm text-un1t-subtle mb-6">
        Per-tenant cron heartbeats, integration connections, AI spend (month to date, est.) and campaign
        backlog. Heartbeat rows appear after each cron&rsquo;s first per-tenant stamp.
      </p>

      {orgs.map((org) => (
        <div key={org.organizationId} className="mb-8">
          <div className="flex items-center gap-2 mb-3">
            <h2 className="text-lg font-semibold">{org.name}</h2>
            {org.needsAttention ? (
              <span className="inline-block rounded-full px-2 py-0.5 text-xs bg-red-500/10 text-red-700">needs attention</span>
            ) : (
              <span className="inline-block rounded-full px-2 py-0.5 text-xs bg-green-500/10 text-green-700">healthy</span>
            )}
          </div>
          <div className="space-y-2">
            {org.locations.map((loc) => (
              <div
                key={loc.id}
                className={`bg-un1t-surface border rounded-lg p-4 ${loc.needsAttention ? 'border-red-300' : 'border-un1t-border'}`}
              >
                <div className="flex items-baseline justify-between gap-4 flex-wrap mb-2">
                  <div className="font-medium">{loc.name}</div>
                  <div className="text-xs text-un1t-subtle tabular-nums">
                    Mia ${(loc.aiCostCentsMtd / 100).toFixed(2)} MTD
                    {loc.campaignBacklog > 0 && <> · {loc.campaignBacklog} campaign{loc.campaignBacklog > 1 ? 's' : ''} in queue</>}
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {loc.heartbeats.length === 0 && loc.connections.length === 0 && (
                    <span className="text-xs text-un1t-subtle">No per-tenant signals yet.</span>
                  )}
                  {loc.heartbeats.map((hb) => (
                    <HeartbeatChip key={hb.name} hb={hb} />
                  ))}
                  {loc.connections.map((c, i) => (
                    <ConnectionChip key={`${c.platform}-${i}`} c={c} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {orgs.length === 0 && <div className="text-sm text-un1t-subtle">No active locations.</div>}
    </div>
  )
}
