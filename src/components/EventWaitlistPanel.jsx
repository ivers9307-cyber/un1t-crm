'use client'

// EventWaitlistPanel — EVENT-WAITLIST.1. The waitlist of one event, for staff
// (the teams page, light theme, with Remove) and hosts (their event page, dark
// host-portal theme, read-only). Both can "Offer now": run the offer round for
// this event at once instead of waiting for the 10-minute cron.
//
// Staff and host data: the count and the list are never shown to the public.
// Status is plain text (no chip), so one component serves both themes.
//
// Props:
//   listUrl       GET → { rows, waiting }
//   offerUrl      POST → the round's counts
//   removeUrlFor  (rowId) => DELETE url, or null for read-only (hosts)
//   dark          host-portal styling

import { useEffect, useState } from 'react'

const STATUS_LABEL = { waiting: 'Waiting', offered: 'Offered', claimed: 'Booked', expired: 'Expired', removed: 'Removed' }

function fmtWhen(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleString('en-IE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  } catch {
    return iso
  }
}

/** One sentence for staff about what an offer round did. Exported for the tests. */
export function offerResultMessage(counts) {
  if (!counts) return ''
  if (counts.no_room > 0) return 'Every time is still full, so nobody was offered.'
  const n = Number(counts.offered) || 0
  const base = n === 0 ? 'Nobody was due an offer.' : `Offered to ${n} ${n === 1 ? 'person' : 'people'}.`
  const skipped = Number(counts.skipped) || 0
  const failed = Number(counts.failed) || 0
  const extra = []
  if (skipped > 0) extra.push(`${skipped} skipped (offered in the last 24 hours, or opted out)`)
  if (failed > 0) extra.push(`${failed} could not be sent and will be retried`)
  return extra.length ? `${base} ${extra.join('; ')}.` : base
}

export default function EventWaitlistPanel({ listUrl, offerUrl, removeUrlFor = null, dark = false }) {
  const [rows, setRows] = useState(null)
  const [waiting, setWaiting] = useState(0)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [busy, setBusy] = useState(null) // 'offer' | rowId

  async function load() {
    try {
      const r = await fetch(listUrl, { cache: 'no-store' })
      const j = await r.json()
      if (!r.ok || j.success === false) {
        setError(j.message || j.error || `Could not load the waitlist (${r.status})`)
        return
      }
      setRows(j.data?.rows || [])
      setWaiting(Number(j.data?.waiting) || 0)
      setError(null)
    } catch (e) {
      setError(e.message || 'Network error')
    }
  }

  useEffect(() => { load() }, [listUrl]) // eslint-disable-line react-hooks/exhaustive-deps

  async function offerNow() {
    if (!confirm('Offer the spot to everyone waiting now? They are all told at once and the first to book gets it.')) return
    setBusy('offer')
    setNotice(null)
    try {
      const r = await fetch(offerUrl, { method: 'POST' })
      const j = await r.json()
      if (!r.ok || j.success === false) {
        setError(j.message || j.error || `Offer failed (${r.status})`)
      } else {
        setNotice(offerResultMessage(j.data))
        await load()
      }
    } catch (e) {
      setError(e.message || 'Network error')
    } finally {
      setBusy(null)
    }
  }

  async function remove(row) {
    if (!removeUrlFor) return
    if (!confirm(`Take ${row.name} off the waitlist?`)) return
    setBusy(row.id)
    try {
      const r = await fetch(removeUrlFor(row.id), { method: 'DELETE' })
      const j = await r.json()
      if (!r.ok || j.success === false) setError(j.message || j.error || `Remove failed (${r.status})`)
      else await load()
    } catch (e) {
      setError(e.message || 'Network error')
    } finally {
      setBusy(null)
    }
  }

  const c = dark
    ? {
        section: 'mt-8',
        heading: 'text-lg font-semibold text-white',
        sub: 'text-white/55 text-sm',
        table: 'overflow-x-auto rounded-xl border border-white/10',
        thead: 'text-left text-xs uppercase tracking-wide text-white/40 border-b border-white/10',
        row: 'border-b border-white/5 last:border-0',
        cell: 'px-3 py-2 text-white/75',
        strong: 'text-white',
        button: 'rounded-md border border-white/20 text-white text-xs px-2.5 py-1 hover:bg-white/5 disabled:opacity-50',
        error: 'text-sm text-red-300',
        notice: 'text-sm text-white/75',
      }
    : {
        section: 'mt-6 pt-4 border-t border-un1t-border',
        heading: 'text-sm font-semibold text-un1t-text',
        sub: 'text-sm text-un1t-subtle',
        table: 'overflow-x-auto rounded-md border border-un1t-border',
        thead: 'text-left text-xs uppercase tracking-wide text-un1t-subtle border-b border-un1t-border',
        row: 'border-b border-un1t-border last:border-0',
        cell: 'px-3 py-2 text-un1t-text',
        strong: 'text-un1t-text font-medium',
        button: 'text-xs border border-un1t-border text-un1t-text px-2.5 py-1 rounded-md hover:bg-un1t-bg disabled:opacity-50',
        error: 'text-sm text-red-700',
        notice: 'text-sm text-un1t-text',
      }

  const list = Array.isArray(rows) ? rows : []

  return (
    <section className={c.section} aria-label="Waitlist">
      <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
        <h2 className={c.heading}>Waitlist{rows ? ` (${waiting} waiting)` : ''}</h2>
        {waiting > 0 && (
          <button type="button" onClick={offerNow} disabled={busy === 'offer'} className={c.button}>
            {busy === 'offer' ? 'Offering…' : 'Offer now'}
          </button>
        )}
      </div>
      {error && <p role="alert" className={`${c.error} mb-2`}>{error}</p>}
      {notice && <p role="status" className={`${c.notice} mb-2`}>{notice}</p>}
      {rows === null && !error && <p className={c.sub}>Loading the waitlist…</p>}
      {rows !== null && list.length === 0 && <p className={c.sub}>Nobody is waiting. When the event sells out, people can join from its page.</p>}
      {list.length > 0 && (
        <div className={c.table}>
          <table className="w-full text-sm whitespace-nowrap">
            <thead>
              <tr className={c.thead}>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Email</th>
                <th className="px-3 py-2 font-medium">Phone</th>
                <th className="px-3 py-2 font-medium">Size</th>
                <th className="px-3 py-2 font-medium">Joined</th>
                <th className="px-3 py-2 font-medium">Last offered</th>
                <th className="px-3 py-2 font-medium">Status</th>
                {removeUrlFor && <th className="px-3 py-2 font-medium"><span className="sr-only">Actions</span></th>}
              </tr>
            </thead>
            <tbody>
              {list.map((row) => {
                const onList = row.status === 'waiting' || row.status === 'offered'
                return (
                  <tr key={row.id} className={c.row}>
                    <td className={c.cell}><span className={c.strong}>{row.name}</span></td>
                    <td className={c.cell}>{row.email}</td>
                    <td className={c.cell}>{row.phone || ''}</td>
                    <td className={c.cell}>{row.headcount || 1}</td>
                    <td className={c.cell}>{fmtWhen(row.created_at)}</td>
                    <td className={c.cell}>{row.last_offered_at ? `${fmtWhen(row.last_offered_at)}${row.offer_count > 1 ? ` (${row.offer_count}x)` : ''}` : ''}</td>
                    <td className={c.cell}>
                      {STATUS_LABEL[row.status] || row.status}
                      {row.status === 'removed' && row.removed_by_name ? ` by ${row.removed_by_name}` : ''}
                    </td>
                    {removeUrlFor && (
                      <td className={`${c.cell} text-right`}>
                        {onList && (
                          <button type="button" onClick={() => remove(row)} disabled={busy === row.id} className={c.button}>
                            Remove
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
