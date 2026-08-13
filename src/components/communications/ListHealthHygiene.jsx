'use client'

// HYGREL.1 — the roster behind the "Suppressed" number.
//
// That stat has been on this page since GAPS-P5 and has never been clickable.
// On 2026-08-12 it read 1,128 while the two tables below it accounted for 21 of
// them: everyone else was suppressed by the nightly engagement sweep, which
// writes no audit row, and could only be found or freed with hand-written SQL.
// This is the same undo affordance ListHealthEscalations gives the bounce
// cohort, pointed at the mechanism that never had one.
//
// CLIENT-FETCHED, unlike its neighbours, which take server-rendered rows as
// props. The population is ~1,100 and every PostgREST select stops at 1,000, so
// this list has to page — and a page control that reloads the whole
// list-health page (five RPCs and six counts) to advance an offset would be a
// poor trade. The endpoint is the single source of the row shape either way.
//
// BOTH MECHANISMS ARE LISTED, and the row says which one holds the stamp,
// because the answer changes what the operator should do. A bounce-owned row
// gets no Release button here: its audit row has to close WITH the release, so
// it belongs to the Restore control on the repeat-bounce table below, and the
// endpoint refuses it anyway. Showing it greyed with the reason beats hiding it
// and having the totals not add up.

import { useState, useEffect, useCallback } from 'react'
import { Button, Table } from '@/components/ui'

const PAGE_SIZE = 100

function dateLabel(iso) {
  if (!iso) return 'Not recorded'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'Not recorded'
  return d.toLocaleDateString('en-IE', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Europe/Dublin' })
}

// Chips use the bg-<c>-500/10 text-<c>-700 recipe. The -700 ramp is not
// decorative: these render on a light card, and the dark-theme recipe produced
// the unreadable green-on-green pill an operator reported in July.
const CHIP = 'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium'

function stageLabel(slug) {
  if (!slug) return 'No stage'
  return slug.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
}

export default function ListHealthHygiene() {
  const [rows, setRows] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [busyId, setBusyId] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(async (offset) => {
    const res = await fetch(`/api/communications/hygiene-suppressions?limit=${PAGE_SIZE}&offset=${offset}`)
    const body = await res.json().catch(() => ({}))
    if (!res.ok || !body.success) {
      throw new Error(body.error || 'Could not load the suppression list.')
    }
    return body.data
  }, [])

  useEffect(() => {
    let cancelled = false
    async function first() {
      try {
        const data = await load(0)
        if (cancelled) return
        setRows(data.rows || [])
        setTotal(data.total || 0)
      } catch (e) {
        if (!cancelled) setError(e?.message || 'Could not load the suppression list.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    first()
    return () => { cancelled = true }
  }, [load])

  async function loadMore() {
    setLoadingMore(true)
    setError(null)
    try {
      const data = await load(rows.length)
      setRows((prev) => [...prev, ...(data.rows || [])])
      setTotal(data.total || 0)
    } catch (e) {
      setError(e?.message || 'Could not load the next page.')
    } finally {
      setLoadingMore(false)
    }
  }

  async function release(contactId) {
    setBusyId(contactId)
    setError(null)
    try {
      const res = await fetch(`/api/communications/hygiene-suppressions/${contactId}/release`, { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || !body.success) {
        setError(body.error || 'Could not release that contact. Try again.')
        return
      }
      // Drop the row locally rather than refetching. A refetch would re-page
      // from zero and lose every "Load more" the operator has already pressed,
      // which on a 1,100-row list is the difference between a working screen
      // and a screen that fights back.
      setRows((prev) => prev.filter((r) => r.contact_id !== contactId))
      setTotal((t) => Math.max(t - 1, 0))
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
    {
      key: 'stage',
      header: 'Stage',
      render: (row) => (
        <span className={`${CHIP} bg-blue-500/10 text-blue-700`}>{stageLabel(row.pipeline_stage_slug)}</span>
      ),
    },
    {
      key: 'reason',
      header: 'Held back by',
      render: (row) => (
        <div>
          <span className={row.has_bounce_escalation
            ? `${CHIP} bg-amber-500/10 text-amber-700`
            : `${CHIP} bg-slate-500/10 text-slate-700`}
          >
            {row.has_bounce_escalation ? 'Repeat bounces' : 'No opens or clicks'}
          </span>
          {row.previously_released_at && (
            <div className="text-xs text-un1t-subtle mt-1">
              Released before on {dateLabel(row.previously_released_at)}
            </div>
          )}
        </div>
      ),
    },
    { key: 'status', header: 'Address', render: (row) => row.email_status || 'active' },
    { key: 'since', header: 'Suppressed', render: (row) => dateLabel(row.suppressed_at) },
    {
      key: 'action',
      header: '',
      align: 'right',
      render: (row) => (
        row.has_bounce_escalation ? (
          <span className="text-xs text-un1t-subtle">Restore from the repeat-bounce table</span>
        ) : (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            loading={busyId === row.contact_id}
            disabled={busyId != null && busyId !== row.contact_id}
            onClick={() => release(row.contact_id)}
            title="Put this contact back in the marketing audience, permanently"
          >
            Release
          </Button>
        )
      ),
    },
  ]

  return (
    <div>
      {error && <p className="mb-2 text-sm text-red-700">{error}</p>}
      <Table
        columns={columns}
        rows={rows}
        loading={loading}
        empty="No contacts are held back for list hygiene."
      />
      {rows.length < total && (
        <div className="mt-3 flex items-center gap-3">
          <Button type="button" variant="secondary" size="sm" loading={loadingMore} onClick={loadMore}>
            Load more
          </Button>
          <span className="text-xs text-un1t-subtle">
            Showing {rows.length.toLocaleString()} of {total.toLocaleString()}.
          </span>
        </div>
      )}
    </div>
  )
}
