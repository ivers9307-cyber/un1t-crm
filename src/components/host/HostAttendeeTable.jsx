'use client'
// HostAttendeeTable — EVENT-MOVE.2. The host event page's roster, one row per
// ENTRY (a team or a single person), with a Move action for paid entries.
// Dark host-portal styling like HostPromoCodes; the move dialog itself keeps
// its light panel (the shared Modal primitive). An entry awaiting payment
// shows "Pay first": a host cannot collect or waive money, and the host route
// refuses it anyway.
//
// `entries` and `movedOut` are built server-side by the page (it holds the
// tenancy gate) as JSON-safe plain objects; this component only renders and
// opens the dialog. After a move the roster refreshes with router.refresh(),
// NOT window.location.reload(): the dialog raises its "could not be emailed"
// notice just before onMoved, a full reload would wipe it, and the moved entry
// leaves this event's rows so no chip would carry it either. refresh()
// re-renders the server page (table + moves-out footer) and keeps this
// component's state, so the notice stays up. No money is shown here: the price-gap chip is not on the
// host table in PR 2 (the dialog already showed the gap before the move).

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import MoveEntryDialog, { NOT_EMAILED_MESSAGE } from '@/components/MoveEntryDialog'

const STATUS_LABEL = { confirmed: 'Confirmed', pending_payment: 'Awaiting payment', cancelled: 'Cancelled', no_show: 'No-show' }
const th = 'px-3 py-2 font-medium'
const td = 'px-3 py-2'

// Date-only and pinned to noon, so the server render and the browser agree
// whatever their time zones (no hydration mismatch).
function fmtDate(d) {
  if (!d) return ''
  try { return new Date(`${String(d).slice(0, 10)}T12:00:00`).toLocaleDateString('en-IE', { day: 'numeric', month: 'short' }) } catch { return d }
}

export default function HostAttendeeTable({ entries, movedOut }) {
  const [moving, setMoving] = useState(null) // the entry being moved
  const [notice, setNotice] = useState(null)
  const router = useRouter()
  const rows = Array.isArray(entries) ? entries : []
  const out = Array.isArray(movedOut) ? movedOut : []

  return (
    <section className="mt-8">
      {notice && (
        <div role="status" className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-200 text-sm px-3 py-2 flex items-start gap-2">
          <span className="flex-1">{notice}</span>
          <button type="button" onClick={() => setNotice(null)} className="text-amber-200/70 hover:text-amber-100" aria-label="Dismiss notice">×</button>
        </div>
      )}
      {rows.length === 0 ? (
        <p className="text-white/50 text-sm">No attendees yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-white/10">
          <table className="w-full text-sm whitespace-nowrap">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-white/40 border-b border-white/10">
                <th className={th}>Entry</th>
                <th className={th}>People</th>
                <th className={th}>Time</th>
                <th className={th}>Status</th>
                <th className={th}>Phone</th>
                <th className={th}><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} className="border-b border-white/5 last:border-0">
                  <td className={td}>
                    <span className="text-white">{e.label}</span>
                    {e.last_move && (
                      <span className="ml-2 text-[11px] text-sky-300" title={`Moved in from ${e.last_move.from_event?.name || 'another event'} on ${fmtDate(e.last_move.created_at)} by ${e.last_move.actor_name || 'staff'}${e.last_move.forced ? ' (time was full)' : ''}`}>
                        moved in from {e.last_move.from_event?.name || 'another event'} {fmtDate(e.last_move.created_at)}
                      </span>
                    )}
                    {e.last_move && e.last_move.notified_at === null && (
                      <span className="ml-2 text-[11px] text-amber-300" title="The customer was not emailed about this move. Tell them yourself.">Not emailed</span>
                    )}
                  </td>
                  <td className={`${td} text-white/70 whitespace-normal`}>
                    {(e.people || []).filter((p) => p.name || p.email).length === 0 ? '—' : (e.people || []).filter((p) => p.name || p.email).map((p, i) => (
                      <div key={i}>
                        {p.name || '—'}
                        {p.email && <span className="text-white/55 text-xs"> · {p.email}</span>}
                      </div>
                    ))}
                  </td>
                  <td className={`${td} text-white/70`}>{e.wave || '—'}</td>
                  <td className={`${td} text-white/70`}>{STATUS_LABEL[e.status] || e.status}</td>
                  <td className={`${td} text-white/60`}>{e.phone || ''}</td>
                  <td className={`${td} text-right`}>
                    {e.status === 'confirmed' && (
                      <button type="button" onClick={() => { setNotice(null); setMoving(e) }} className="rounded-md border border-white/20 text-white text-xs px-2.5 py-1 hover:bg-white/5">Move</button>
                    )}
                    {e.status === 'pending_payment' && <span className="text-xs text-white/55">Pay first</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {out.length > 0 && (
        <details className="mt-3 text-sm text-white/50">
          <summary className="cursor-pointer select-none">{out.length} {out.length === 1 ? 'move' : 'moves'} to other events</summary>
          <ul className="mt-2 space-y-1 pl-4">
            {out.map((m) => (
              <li key={m.id}>{m.label} → {m.to_event?.name || 'another event'}{m.to_event?.race_date ? ` (${fmtDate(m.to_event.race_date)})` : ''} · {fmtDate(m.created_at)} · {m.actor_name || 'staff'}</li>
            ))}
          </ul>
        </details>
      )}

      {moving && (
        // `moving` is captured by these closures, so the notice can name the
        // entry even though onMoved clears it right after: the moved row
        // leaves this event's list on refresh.
        <MoveEntryDialog
          open
          registration={moving.registration}
          targetsUrl={`/api/host/registrations/${moving.id}/move-targets`}
          moveUrl={`/api/host/registrations/${moving.id}/move`}
          onClose={() => setMoving(null)}
          onNotice={(msg) => setNotice(`${moving.label}: ${msg || NOT_EMAILED_MESSAGE}`)}
          onMoved={() => { setMoving(null); router.refresh() }}
        />
      )}
    </section>
  )
}
