'use client'
// HostSeriesActions — HOSTSERIES.1. On a host's event page: an event in a
// series shows the series and its public page link; one that is not offers
// "Make this a series": a name (default the event's), a list of dates (add /
// remove, with weekly ×4 / fortnightly ×4 / monthly ×3 helpers counted from
// the event's date), posted to /api/host/events/<id>/series. Each date
// becomes a draft copy; the host submits them for review as usual.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { CalendarRange, Loader2, X } from 'lucide-react'
import { weeklyDates, monthlyDates } from '@/lib/series-dates'

const input = 'bg-white/[0.04] border border-white/12 rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/40 focus:outline-none focus:border-white/30 [color-scheme:dark]'
const label = 'block text-xs uppercase tracking-wide text-white/45 mb-1'
const ghost = 'rounded-lg border border-white/20 text-white text-sm px-3 py-1.5 hover:bg-white/5'

export default function HostSeriesActions({ eventId, eventName, raceDate, seriesId, seriesName = '', seriesSlug = '' }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(eventName || '')
  const [dates, setDates] = useState([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [done, setDone] = useState(null) // { slug, count }

  if (seriesId) {
    return (
      <p className="text-sm text-white/60 inline-flex items-center gap-2">
        <CalendarRange size={14} className="text-white/40" />
        <span>Part of series <a href={`/event/series/${seriesSlug}`} target="_blank" rel="noopener noreferrer" className="text-white underline underline-offset-2 hover:text-white/80">{seriesName || 'series'}</a></span>
      </p>
    )
  }

  function append(list) {
    setDates((prev) => {
      const seen = new Set(prev)
      return [...prev, ...list.filter((d) => !seen.has(d) && (seen.add(d), true))].slice(0, 24)
    })
  }
  const setDate = (i, value) => setDates((prev) => prev.map((d, j) => (j === i ? value : d)))
  const removeDate = (i) => setDates((prev) => prev.filter((_, j) => j !== i))

  async function submit(e) {
    e.preventDefault()
    if (busy) return
    const clean = dates.filter(Boolean)
    if (clean.length === 0) { setError('Add at least one date.'); return }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/host/events/${eventId}/series`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim(), dates: clean }) })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) {
        setError(json.message || json.error || 'The series could not be created. Try again.')
        return
      }
      setDone({ slug: json.data.series.slug, count: (json.data.created || []).length })
      router.refresh()
    } catch (err) {
      setError(err?.message || 'Network error. Try again.')
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
        Series created: {done.count} {done.count === 1 ? 'date' : 'dates'} created as drafts. Submit each one for review when it is ready.{' '}
        <a href={`/event/series/${done.slug}`} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-white">Open the series page →</a>
      </div>
    )
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={`${ghost} inline-flex items-center gap-1.5`} title="Copy this event onto more dates with one shared page">
        <CalendarRange size={13} /> Make this a series
      </button>
    )
  }

  return (
    <form onSubmit={submit} className="rounded-xl border border-white/10 bg-white/[0.02] p-4 space-y-4 w-full">
      <div>
        <label htmlFor="series-name" className={label}>Series name</label>
        <input id="series-name" type="text" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required className={`${input} w-full sm:max-w-md`} />
      </div>
      <div>
        <span className={label}>Dates</span>
        <div className="flex flex-wrap gap-2 mb-3">
          <button type="button" onClick={() => append(weeklyDates(raceDate, 4))} className={ghost}>+ weekly ×4</button>
          <button type="button" onClick={() => append(weeklyDates(raceDate, 4, 14))} className={ghost}>+ fortnightly ×4</button>
          <button type="button" onClick={() => append(monthlyDates(raceDate, 3))} className={ghost}>+ monthly ×3</button>
          <button type="button" onClick={() => append([''])} className={ghost}>+ a date</button>
        </div>
        {dates.length === 0 && <p className="text-xs text-white/40">No dates yet. Use a helper or add one.</p>}
        <ul className="space-y-2">
          {dates.map((d, i) => (
            <li key={i} className="flex items-center gap-2">
              <label htmlFor={`series-date-${i}`} className="sr-only">Date {i + 1}</label>
              <input id={`series-date-${i}`} type="date" value={d} onChange={(e) => setDate(i, e.target.value)} required className={input} />
              <button type="button" onClick={() => removeDate(i)} aria-label={`Remove date ${i + 1}`} className="p-1.5 rounded-md text-white/50 hover:text-white hover:bg-white/5"><X size={14} /></button>
            </li>
          ))}
        </ul>
      </div>
      {error && <p role="alert" className="text-sm text-amber-200">{error}</p>}
      <div className="flex items-center gap-3">
        <button type="submit" disabled={busy} className="rounded-lg bg-white text-black text-sm font-semibold px-4 py-2 hover:bg-white/90 disabled:opacity-60 inline-flex items-center gap-1.5">
          {busy && <Loader2 size={13} className="animate-spin" />} Create series
        </button>
        <button type="button" onClick={() => { setOpen(false); setError(null) }} className="text-xs text-white/50 hover:text-white">Cancel</button>
      </div>
      <p className="text-xs text-white/35">Each date becomes a draft copy of this event (same sessions, price and copy). One link lists every published date.</p>
    </form>
  )
}
