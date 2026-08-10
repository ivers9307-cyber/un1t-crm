'use client'

// GAPS-P5 — the undo control on the list health page.
//
// Every escalation is reversible from here. A suppressed contact is restored
// (the audit row closes and contacts.email_suppressed_at is cleared, putting
// them back in the marketing audience); a review row is dismissed (nothing was
// ever applied to it, so dismissing only records that someone looked).
//
// Dates arrive pre-formatted from the server. Formatting them here would
// render under the server's UTC clock during SSR and the browser's Dublin
// clock on hydration, which is a mismatch for no benefit.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Table } from '@/components/ui'

export default function ListHealthEscalations({ rows = [], mode = 'suppress' }) {
  const router = useRouter()
  const [busyId, setBusyId] = useState(null)
  const [error, setError] = useState(null)

  const actionLabel = mode === 'suppress' ? 'Restore' : 'Dismiss'

  async function release(id) {
    setBusyId(id)
    setError(null)
    try {
      const res = await fetch(`/api/communications/list-health/${id}/release`, { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || !body.success) {
        setError(body.error || 'Could not update that contact. Try again.')
        return
      }
      router.refresh()
    } catch {
      setError('Could not reach the server. Try again.')
    } finally {
      setBusyId(null)
    }
  }

  const columns = [
    {
      key: 'contact',
      header: 'Contact',
      render: (row) => (
        <div>
          <div className="text-un1t-text">{row.name || 'Unnamed contact'}</div>
          <div className="text-xs text-un1t-subtle">{row.email || 'No email on file'}</div>
        </div>
      ),
    },
    { key: 'campaigns', header: 'Campaigns bounced', accessor: 'bounced_campaign_count', align: 'right' },
    { key: 'events', header: 'Bounce events', accessor: 'bounce_events', align: 'right' },
    { key: 'types', header: 'Types', accessor: 'bounce_types_label' },
    { key: 'delivered', header: 'Delivered to', accessor: 'successful_deliveries', align: 'right' },
    { key: 'last', header: 'Last bounce', accessor: 'last_bounce_label' },
    { key: 'since', header: mode === 'suppress' ? 'Suppressed' : 'Flagged', accessor: 'since_label' },
    {
      key: 'action',
      header: '',
      align: 'right',
      render: (row) => (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          loading={busyId === row.id}
          disabled={busyId != null && busyId !== row.id}
          onClick={() => release(row.id)}
        >
          {actionLabel}
        </Button>
      ),
    },
  ]

  return (
    <div>
      {error && (
        <p className="mb-2 text-sm text-red-700">{error}</p>
      )}
      <Table
        columns={columns}
        rows={rows}
        empty={mode === 'suppress'
          ? 'No contacts are suppressed for repeat bounces.'
          : 'No contacts are waiting to be reviewed.'}
      />
    </div>
  )
}
