'use client'
// HOSTPAGE.2 — the rate page: five stars, an optional comment, one submission
// per entry. A rated link shows what was given; a bad or expired link says so.
// Everything it knows comes from /api/public/event-rating/<token>.

import { useEffect, useState } from 'react'

const LABEL = { 1: '1 star', 2: '2 stars', 3: '3 stars', 4: '4 stars', 5: '5 stars' }

export default function EventRatingPage({ token }) {
  const [state, setState] = useState({ status: 'loading' })
  const [rating, setRating] = useState(0)
  const [hover, setHover] = useState(0)
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    fetch(`/api/public/event-rating/${encodeURIComponent(token)}`, { cache: 'no-store' })
      .then(async (res) => {
        const j = await res.json().catch(() => ({}))
        if (!alive) return
        if (!res.ok || !j.success) { setState({ status: 'invalid' }); return }
        setState({ status: 'ready', event: j.data.event, given: j.data.existing || null })
      })
      .catch(() => { if (alive) setState({ status: 'invalid' }) })
    return () => { alive = false }
  }, [token])

  async function submit(e) {
    e.preventDefault()
    if (!rating || busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/public/event-rating/${encodeURIComponent(token)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating, comment: comment.trim() }),
      })
      const j = await res.json().catch(() => ({}))
      if (res.status === 409) { setState((s) => ({ ...s, given: { rating, comment: comment.trim() || null } })); return }
      if (!res.ok || !j.success) throw new Error(j.error || 'Could not save your rating — try again shortly.')
      setState((s) => ({ ...s, given: j.data }))
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const shell = (children) => (
    <main className="mx-auto max-w-md px-6 py-16">
      {children}
    </main>
  )

  if (state.status === 'loading') return shell(<p className="text-white/60">Loading…</p>)
  if (state.status === 'invalid') {
    return shell(<>
      <h1 className="text-2xl font-bold">This link has expired or isn&apos;t valid.</h1>
      <p className="mt-3 text-white/60">Rating links last 30 days and work once per booking.</p>
    </>)
  }
  const { event, given } = state
  if (given) {
    return shell(<>
      <p className="text-xs uppercase tracking-[0.2em] text-white/50">{event.host_name}</p>
      <h1 className="mt-2 text-2xl font-bold">Thanks, you gave {given.rating} star{given.rating === 1 ? '' : 's'}.</h1>
      <p className="mt-2 text-white/60">{event.name} · {event.date_label}</p>
      {given.comment && <blockquote className="mt-6 rounded-xl border border-white/10 bg-white/[0.03] p-4 text-white/80">{given.comment}</blockquote>}
    </>)
  }
  const shown = hover || rating
  return shell(
    <form onSubmit={submit}>
      <p className="text-xs uppercase tracking-[0.2em] text-white/50">{event.host_name}</p>
      <h1 className="mt-2 text-2xl font-bold">How was {event.name}?</h1>
      <p className="mt-2 text-white/60">{event.date_label}</p>
      <div className="mt-8 flex gap-2" role="radiogroup" aria-label="Your rating">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            aria-label={LABEL[n]}
            aria-pressed={rating === n}
            onClick={() => setRating(n)}
            onMouseEnter={() => setHover(n)}
            onMouseLeave={() => setHover(0)}
            className={`text-4xl leading-none transition ${n <= shown ? 'text-yellow-300' : 'text-white/25'}`}
          >
            ★
          </button>
        ))}
      </div>
      <label htmlFor="rating-comment" className="mt-8 block text-sm text-white/70">Anything to add? (optional)</label>
      <textarea
        id="rating-comment"
        rows={4}
        maxLength={600}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        className="mt-2 w-full rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-white placeholder:text-white/30 focus:border-white/40 focus:outline-none"
        placeholder="What stood out?"
      />
      {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
      <button
        type="submit"
        disabled={!rating || busy}
        className="mt-6 rounded-xl bg-white px-6 py-3 font-semibold text-black hover:bg-white/90 disabled:opacity-40"
      >
        {busy ? 'Sending…' : 'Send'}
      </button>
    </form>,
  )
}
