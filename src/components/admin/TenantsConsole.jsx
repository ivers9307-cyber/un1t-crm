'use client'

// INTEG-D2 — /admin/tenants roster: stat tiles + one row per
// organization. Read-only (the wallet-adjust write lives on the
// drill-in). Rendered by src/app/admin/tenants/page.js with the
// getTenantsRoster() payload as props.

import Link from 'next/link'
import { useState } from 'react'
import { ChevronRight, Building2, ExternalLink, Eye, PencilLine } from 'lucide-react'
import { Card, Table } from '@/components/ui'
import { euro, num } from '@/components/admin/tenants-format'

// SUPPORT-ACCESS — per-row "View into ↗" with a small mode picker. Opens a
// support session against the org in the chosen mode, then lands the
// master on that tenant's /portfolio. Read-only is server-enforced at the
// proxy; act-on-behalf allows scoped writes.
function SupportAccessCell({ org }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function start(mode) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/support-session/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ organization_id: org.id, mode }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json?.success) {
        setError(json?.error || 'Failed to start')
        setBusy(false)
        return
      }
      // Hard navigation so every server component re-resolves getCurrentUser
      // with the new support + impersonation cookies.
      window.location.assign(json.data?.landing || '/portfolio')
    } catch {
      setError('Failed to start')
      setBusy(false)
    }
  }

  return (
    <div className="relative inline-block text-left">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-sm text-un1t-subtle hover:text-un1t-text"
      >
        View into <ExternalLink size={13} />
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-52 rounded-md border border-un1t-border bg-un1t-surface shadow-lg p-1">
          <button
            type="button"
            disabled={busy}
            onClick={() => start('read_only')}
            className="w-full flex items-center gap-2 px-2 py-1.5 text-left text-sm rounded hover:bg-un1t-bg disabled:opacity-50"
          >
            <Eye size={14} className="text-indigo-500 shrink-0" />
            <span>
              <span className="font-medium text-un1t-text">Read-only</span>
              <span className="block text-xs text-un1t-muted">View only — writes blocked</span>
            </span>
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => start('act_on_behalf')}
            className="w-full flex items-center gap-2 px-2 py-1.5 text-left text-sm rounded hover:bg-un1t-bg disabled:opacity-50"
          >
            <PencilLine size={14} className="text-amber-600 shrink-0" />
            <span>
              <span className="font-medium text-un1t-text">Act on behalf</span>
              <span className="block text-xs text-un1t-muted">Make changes — LIVE</span>
            </span>
          </button>
          {error && <div className="px-2 py-1 text-xs text-red-700">{error}</div>}
        </div>
      )}
    </div>
  )
}

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

function fmtWhen(iso) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('en-IE', { dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    return iso
  }
}

// SUPPORT-ACCESS — recent support-session audit panel (master-only data).
function SupportSessionsPanel({ sessions }) {
  if (!sessions || sessions.length === 0) return null
  return (
    <div className="mt-8">
      <h3 className="text-sm font-semibold text-un1t-text mb-2">Recent support sessions</h3>
      <p className="text-xs text-un1t-muted mb-3 max-w-3xl">
        Every time a master opened a support session into a tenant, in which mode, and when it ended.
      </p>
      <Card padding="none">
        <Table
          columns={[
            { key: 'tenant', header: 'Tenant', render: (s) => <span className="text-un1t-text">{s.organizationName || '—'}</span> },
            { key: 'master', header: 'Master', render: (s) => <span className="text-un1t-subtle">{s.masterName || '—'}</span> },
            {
              key: 'mode',
              header: 'Mode',
              render: (s) => s.mode === 'act_on_behalf'
                ? <span className="inline-block rounded-full px-2 py-0.5 text-xs bg-amber-500/10 text-amber-700">Act on behalf</span>
                : <span className="inline-block rounded-full px-2 py-0.5 text-xs bg-indigo-500/10 text-indigo-700">Read-only</span>,
            },
            { key: 'started', header: 'Started', render: (s) => <span className="text-xs text-un1t-subtle whitespace-nowrap">{fmtWhen(s.startedAt)}</span> },
            {
              key: 'ended',
              header: 'Ended',
              render: (s) => s.active
                ? <span className="inline-block rounded-full px-2 py-0.5 text-xs bg-green-500/10 text-green-700">active</span>
                : <span className="text-xs text-un1t-subtle whitespace-nowrap">{fmtWhen(s.endedAt)}{s.autoClosed ? ' (auto)' : ''}</span>,
            },
          ]}
          rows={sessions}
          empty="No support sessions yet."
        />
      </Card>
    </div>
  )
}

export default function TenantsConsole({ roster, supportSessions = [] }) {
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
      key: 'support',
      header: 'Support',
      align: 'right',
      render: (org) => <SupportAccessCell org={org} />,
    },
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

      <SupportSessionsPanel sessions={supportSessions} />
    </div>
  )
}
