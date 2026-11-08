'use client'
// HOSTPAGE.2 — the host's ratings list on their event page: every rating
// (hidden ones included) with stars, comment, first name and date, and a
// Hide/Show toggle that calls PATCH /api/host/events/<id>/ratings/<rating id>.

import { useEffect, useState } from 'react'

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
      <h2 className="text-xs uppercase tracking-[0.15em] text-white/45 mb-1">Ratings</h2>
      <p className="text-xs text-white/35 mb-4">
        Attendees are asked the morning after. Your page shows the average and the newest comments once three or more are public; hide any you&rsquo;d rather not show.
      </p>
      {state.status === 'loading' && <p className="text-white/50 text-sm">Loading ratings…</p>}
      {state.status === 'error' && <p className="text-white/50 text-sm">Ratings unavailable right now.</p>}
      {state.status === 'ready' && state.ratings.length === 0 && (
        <p className="text-white/50 text-sm">No ratings yet. Attendees are asked the morning after the event.</p>
      )}
      {state.status === 'ready' && state.ratings.length > 0 && (
        <>
          {state.summary && (
            <p className="mb-3 text-sm text-white/70">
              <span className="text-yellow-300">★</span> {state.summary.average} · {state.summary.count} public rating{state.summary.count === 1 ? '' : 's'}
            </p>
          )}
          <ul className="space-y-2">
            {state.ratings.map((r) => (
              <li key={r.id} className={`flex items-start justify-between gap-4 rounded-lg border border-white/10 px-4 py-3 ${r.is_public ? 'bg-white/[0.02]' : 'bg-white/[0.01] opacity-70'}`}>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-yellow-300 tracking-tight" aria-label={`${r.rating} out of 5`}>{stars(r.rating)}</span>
                    {r.author && <span className="text-white/80">{r.author}</span>}
                    <span className="text-white/35 text-xs">{when(r.created_at)}</span>
                    {!r.is_public && <span className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] text-white/60">Hidden</span>}
                  </div>
                  {r.comment && <p className="mt-1 text-sm text-white/75">{r.comment}</p>}
                </div>
                <button
                  type="button"
                  onClick={() => toggle(r)}
                  disabled={busyId === r.id}
                  className="shrink-0 rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white/80 hover:bg-white/5 disabled:opacity-50"
                >
                  {r.is_public ? 'Hide' : 'Show'}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
    </section>
  )
}
