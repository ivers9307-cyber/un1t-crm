'use client'
// HOSTPAGE.2 — the host's ratings list on their event page: every rating
// (hidden ones included) with stars, comment, first name and date, and a
// Hide/Show toggle that calls PATCH /api/host/events/<id>/ratings/<rating id>.

import { useEffect, useState } from 'react'
import { HOST_CHIP, HOST_CHIP_TONE, HOST_HINT, HOST_SECTION, HOST_SECTION_DESC } from '@/components/host/host-ui'

const stars = (n) => '★'.repeat(n) + '☆'.repeat(5 - n)
const when = (iso) => { try { return new Date(iso).toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric' }) } catch { return '' } }

export default function HostEventRatings({ eventId }) {
  const [state, setState] = useState({ status: 'loading', ratings: [], summary: null })
  const [busyId, setBusyId] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    fetch(`/api/host/events/${eventId}/ratings`, { cache: 'no-store' })
      .then(async (res) => {
        const j = await res.json().catch(() => ({}))
        if (!alive) return
        if (!res.ok || !j.success) { setState({ status: 'error', ratings: [], summary: null }); return }
        setState({ status: 'ready', ratings: j.data.ratings || [], summary: j.data.summary || null })
      })
      .catch(() => { if (alive) setState({ status: 'error', ratings: [], summary: null }) })
    return () => { alive = false }
  }, [eventId])

  async function toggle(r) {
    setBusyId(r.id)
    setError(null)
    try {
      const res = await fetch(`/api/host/events/${eventId}/ratings/${r.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ is_public: !r.is_public }),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || !j.success) throw new Error(j.error || 'Could not update the rating.')
      setState((s) => ({ ...s, ratings: s.ratings.map((x) => (x.id === r.id ? { ...x, is_public: j.data.is_public } : x)) }))
    } catch (e) {
      setError(e.message)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <section className="mt-10">
      <h2 className={HOST_SECTION}>Ratings</h2>
      <p className={`${HOST_SECTION_DESC} mb-4`}>
        Attendees are asked the morning after. Your page shows the average and the newest comments once three or more are public; hide any you&rsquo;d rather not show.
      </p>
      {state.status === 'loading' && <p className={HOST_HINT}>Loading ratings…</p>}
      {state.status === 'error' && <p className={HOST_HINT}>Ratings unavailable right now.</p>}
      {state.status === 'ready' && state.ratings.length === 0 && (
        <p className={HOST_HINT}>No ratings yet. Attendees are asked the morning after the event.</p>
      )}
      {state.status === 'ready' && state.ratings.length > 0 && (
        <>
          {state.summary && (
            <p className="mb-3 text-sm text-host-label">
              <span className="text-host-star">★</span> {state.summary.average} · {state.summary.count} public rating{state.summary.count === 1 ? '' : 's'}
            </p>
          )}
          <ul className="space-y-2">
            {state.ratings.map((r) => (
              <li key={r.id} className={`flex items-start justify-between gap-4 rounded-lg border border-host-border px-4 py-3 ${r.is_public ? 'bg-host-panel' : 'bg-host-well'}`}>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-host-star tracking-tight" aria-label={`${r.rating} out of 5`}>{stars(r.rating)}</span>
                    {r.author && <span className="text-host-label">{r.author}</span>}
                    <span className="text-host-hint text-xs">{when(r.created_at)}</span>
                    {!r.is_public && <span className={`${HOST_CHIP} ${HOST_CHIP_TONE.neutral}`}>Hidden</span>}
                  </div>
                  {r.comment && <p className="mt-1 text-sm text-host-label">{r.comment}</p>}
                </div>
                <button
                  type="button"
                  onClick={() => toggle(r)}
                  disabled={busyId === r.id}
                  className="shrink-0 rounded-lg border border-host-edge bg-host-panel px-3 py-1.5 text-xs text-host-text hover:bg-host-hover disabled:opacity-50"
                >
                  {r.is_public ? 'Hide' : 'Show'}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {error && <p className="mt-3 text-sm text-host-bad">{error}</p>}
    </section>
  )
}
