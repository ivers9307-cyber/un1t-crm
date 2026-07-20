'use client'

// INTEG-D2 — /admin/tenants roster: stat tiles + one row per
// organization. Read-only (the wallet-adjust write lives on the
// drill-in). Rendered by src/app/admin/tenants/page.js with the
// getTenantsRoster() payload as props.

import Link from 'next/link'
import { ChevronRight, Building2 } from 'lucide-react'
import { Card, Table } from '@/components/ui'
import { euro, num } from '@/components/admin/tenants-format'

function StatTile({ label, value, hint }) {
  return (
    <Card padding="sm">
      <div className="text-xs uppercase tracking-wider text-un1t-subtle font-semibold">{label}</div>
      <div className="text-xl font-bold text-un1t-text mt-1">{value}</div>
      {hint && <div className="text-xs text-un1t-muted mt-0.5">{hint}</div>}
    </Card>
  )
}

function HealthCell({ health }) {
  const { attentionCount, staleHeartbeatCount } = health || {}
  if (!attentionCount && !staleHeartbeatCount) {
    return <span className="inline-block rounded-full px-2 py-0.5 text-xs bg-green-500/10 text-green-700">OK</span>
  }
  return (
    <span className="inline-flex flex-wrap gap-1">
      {attentionCount > 0 && (
        <span className="inline-block rounded-full px-2 py-0.5 text-xs bg-amber-500/10 text-amber-700">
          {attentionCount} integration{attentionCount === 1 ? '' : 's'}
        </span>
      )}
      {staleHeartbeatCount > 0 && (
        <span className="inline-block rounded-full px-2 py-0.5 text-xs bg-red-500/10 text-red-700">
          {staleHeartbeatCount} stale heartbeat{staleHeartbeatCount === 1 ? '' : 's'}
        </span>
      )}
    </span>
  )
}

function UsageCell({ usage }) {
  const u = usage || {}
  return (
    <span className="text-xs text-un1t-subtle whitespace-nowrap">
      WA {num(u.wa_template_send)} · Email {num(u.email_send)} · AI {num(u.ai_message)}
    </span>
  )
}

export default function TenantsConsole({ roster }) {
  const { stats, orgs } = roster

  const columns = [
    {
      key: 'name',
      header: 'Tenant',
      render: (org) => (
        <span className="inline-flex items-center gap-2">
          <Building2 size={14} className="text-un1t-muted shrink-0" />
          <span>
            <span className="font-medium text-un1t-text">{org.name}</span>
            {org.active === false && (
              <span className="ml-2 inline-block rounded-full px-2 py-0.5 text-xs bg-gray-500/10 text-gray-700">suspended</span>
            )}
          </span>
        </span>
      ),
    },
    { key: 'locations', header: 'Locations', align: 'center', render: (org) => num(org.locationsCount) },
    {
      key: 'plan',
      header: 'Plan',
      render: (org) => org.planSummary
        ? <span className="text-un1t-text">{org.planSummary}</span>
        : <span className="text-un1t-muted">—</span>,
    },
    {
      key: 'wallet',
      header: 'Wallet',
      align: 'right',
      render: (org) => org.walletBalanceCents == null
        ? <span className="text-un1t-muted">—</span>
        : (
          <span className={Number(org.walletBalanceCents) < 0 ? 'text-red-700 font-medium' : 'text-un1t-text'}>
            {euro(org.walletBalanceCents)}
          </span>
        ),
    },
    { key: 'usage', header: 'Usage MTD', render: (org) => <UsageCell usage={org.usage} /> },
    { key: 'health', header: 'Health', render: (org) => <HealthCell health={org.health} /> },
    {
      key: 'open',
      header: '',
      align: 'right',
      render: (org) => (
        <Link
          href={`/admin/tenants/${org.id}`}
          className="inline-flex items-center gap-1 text-sm text-un1t-subtle hover:text-un1t-text"
        >
          Open <ChevronRight size={14} />
        </Link>
      ),
    },
  ]

  return (
    <div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <StatTile label="MRR" value={euro(stats.mrrCents)} hint="Active pinned tier prices" />
        <StatTile
          label="Trials"
          value={num(stats.trials?.count || 0)}
          hint={stats.trials?.live ? undefined : 'Trial machinery not live yet'}
        />
        <StatTile label="Past due" value={num(stats.pastDueCount)} hint="Locations with a negative wallet" />
        <StatTile label="Top-ups MTD" value={euro(stats.topupsMtdCents)} hint="Wallet top-ups this month" />
      </div>

      <Card padding="none">
        <Table
          columns={columns}
          rows={orgs}
          empty="No organizations yet."
        />
      </Card>
    </div>
  )
}
