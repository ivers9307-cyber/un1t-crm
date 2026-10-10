'use client'

// EntryManagePage — the person who booked an event entry changes its date
// themselves (EVENT-MOVE.6). Reached from the "Change your date" link in the
// confirmation and moved emails: /event/entry/[token]. The token is the only
// credential; every request carries it in the path.
//
// What it shows: the entry (event, date, time, where, people, status), then
// either why it cannot move (move_blocked_reason) or the dates it can move to.
// Options come from /move-options already reduced to times with room: this
// page never sees, and never shows, capacity or how many places remain.
//
// Picking a time opens a confirm sheet. Same price or cheaper → POST, then
// re-read the entry ("Moved. New tickets are on their way by email.").
// Dearer → POST answers a pay_url and the browser goes to the checkout,
// which returns here once paid. Refusals show the server's own sentence.
//
// Styling follows RaceConfirmedPage (the dark public event pages).

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, AlertCircle, BadgeCheck, CalendarClock } from 'lucide-react'
import { timeRowLabel } from '@/lib/event-time-slots'

// While a paid date change settles (the provider tells us within seconds),
// re-read the entry every 5 seconds, for about a minute at most.
const PENDING_POLL_MS = 5000
const PENDING_POLL_MAX = 12

function dateLabel(raceDate, opts = { weekday: 'short', day: 'numeric', month: 'short' }) {
  if (!raceDate) return ''
  const d = new Date(`${String(raceDate).slice(0, 10)}T00:00:00`)
  return Number.isNaN(d.getTime()) ? String(raceDate) : d.toLocaleDateString('en-IE', opts)
}

function timeText(t) {
  if (!t) return ''
  const hhmm = String(t.start_time || '').slice(0, 5)
  return t.label ? `${t.label} · ${hhmm}` : hhmm
}

function money(cents, currency = 'EUR') {
  const major = (Math.abs(Number(cents) || 0) / 100).toFixed(2)
  if (currency === 'EUR') return `€${major}`
  if (currency === 'GBP') return `£${major}`
  return `${major} ${currency}`
}

const STATUS_LABEL = {
  confirmed: 'Confirmed',
  pending_payment: 'Awaiting payment',
  cancelled: 'Cancelled',
  no_show: 'Did not attend',
}

async function readJson(res) {
  try { return await res.json() } catch { return null }
}

export default function EntryManagePage({ token, navigate = (url) => window.location.assign(url) }) {
  const base = `/api/public/entry/${encodeURIComponent(token || '')}`
  const [entry, setEntry] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [options, setOptions] = useState(null)
  const [optionsError, setOptionsError] = useState(null)
  const polls = useRef(0)
  const [choice, setChoice] = useState(null) // { option, time }
  const [busy, setBusy] = useState(false)
  const [moveError, setMoveError] = useState(null)
  const [notice, setNotice] = useState(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(base, { cache: 'no-store' })
      const j = await readJson(res)
      if (!res.ok || !j?.success) {
        setLoadError(j?.message || 'This page could not be loaded. Please try again.')
        return
      }
      setEntry(j.data)
      if (j.data.can_move) {
        const r2 = await fetch(`${base}/move-options`, { cache: 'no-store' })
        const j2 = await readJson(r2)
        if (r2.ok && j2?.success) {
          setOptionsError(null)
          setOptions(j2.data.options || [])
        } else {
          // Never "no other dates" for a read that failed: say what happened.
          setOptionsError(j2?.message || 'The dates could not be loaded. Please try again.')
          setOptions([])
        }
      } else {
        setOptions([])
      }
    } catch {
      setLoadError('This page could not be loaded. Check your connection and try again.')
    }
  }, [base])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (!entry?.date_change_pending || polls.current >= PENDING_POLL_MAX) return undefined
    const t = setTimeout(() => { polls.current += 1; load() }, PENDING_POLL_MS)
    return () => clearTimeout(t)
  }, [entry, load])

  async function confirmMove() {
    if (!choice) return
    setBusy(true)
    setMoveError(null)
    try {
      const res = await fetch(`${base}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_event_id: choice.option.event_id, target_wave_id: choice.time?.wave_id || null }),
      })
      const j = await readJson(res)
      if (!res.ok || !j?.success) {
        setMoveError(j?.message || 'Your date could not be changed. Please try again.')
        return
      }
      if (j.data?.pay_url) {
        navigate(j.data.pay_url)
        return
      }
      setChoice(null)
      setNotice('Moved. New tickets are on their way by email.')
      await load()
    } catch {
      setMoveError('Your date could not be changed. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  if (loadError) {
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center p-6">
        <div className="lp-card-glow rounded-2xl p-8 max-w-sm text-center">
          <AlertCircle size={32} className="mx-auto text-red-400 mb-3" />
          <p className="text-white/70">{loadError}</p>
        </div>
      </div>
    )
  }

  if (!entry) {
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center p-6">
        <Loader2 size={28} className="animate-spin text-white/40" aria-label="Loading" />
      </div>
    )
  }

  const race = entry.race || {}
  const team = entry.team || {}
  const members = (team.team_members || []).slice().sort((a, b) => (a.role === 'captain' ? 0 : 1) - (b.role === 'captain' ? 0 : 1))
  const whereLabel = race.locations?.name || race.locations?.address || ''
  const dearer = choice && choice.option.price_difference_cents > 0

  return (
    <div className="min-h-screen bg-black text-white px-4 pt-16 pb-20">
      <div className="max-w-md mx-auto">
        <div className="text-center mb-7">
          <p className="text-[11px] uppercase tracking-[0.2em] text-white/45 font-semibold mb-2">Your entry</p>
          <h1 className="text-3xl font-bold uppercase tracking-tight">{race.name || 'Your event'}</h1>
          <p className="text-sm text-white/60 mt-2">{STATUS_LABEL[entry.status] || entry.status}</p>
        </div>

        {notice && (
          // A dark page: the light ramp is the readable one here (as on
          // RaceConfirmedPage), so the text colour sits on the inner line.
          <div role="status" className="mb-5 p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30">
            <p className="text-sm text-emerald-300">{notice}</p>
          </div>
        )}
        {entry.date_change_failed && !notice && (
          <div role="status" className="mb-5 p-4 rounded-xl bg-amber-500/10 border border-amber-500/30">
            <p className="text-sm text-amber-200">
              We received your payment for a date change but could not move your entry. We are looking into your date change and will be in touch.
            </p>
          </div>
        )}
        {entry.date_change_pending && !notice && (
          <div role="status" className="mb-5 p-4 rounded-xl bg-amber-500/10 border border-amber-500/30">
            <p className="text-sm text-amber-200">
              A date change is waiting on its payment. If you have just paid, your new date will show here in a moment.
            </p>
          </div>
        )}

        <div className="lp-card-glow rounded-2xl overflow-hidden p-6">
          <dl className="grid grid-cols-2 gap-px bg-white/10 rounded-xl overflow-hidden">
            {race.race_date && (
              <div className="bg-black p-3">
                <dt className="text-[10px] uppercase tracking-[0.14em] text-white/45 font-semibold">Date</dt>
                <dd className="text-[15px] font-semibold mt-1">{dateLabel(race.race_date)}</dd>
              </div>
            )}
            {entry.wave && (
              <div className="bg-black p-3">
                <dt className="text-[10px] uppercase tracking-[0.14em] text-white/45 font-semibold">{timeRowLabel(race.kind)}</dt>
                <dd className="text-[15px] font-semibold mt-1">{timeText(entry.wave)}</dd>
              </div>
            )}
            {whereLabel && (
              <div className="bg-black p-3">
                <dt className="text-[10px] uppercase tracking-[0.14em] text-white/45 font-semibold">Where</dt>
                <dd className="text-[15px] font-semibold mt-1">{whereLabel}</dd>
              </div>
            )}
            {members.length > 0 && (
              <div className="bg-black p-3">
                <dt className="text-[10px] uppercase tracking-[0.14em] text-white/45 font-semibold">People</dt>
                <dd className="text-[15px] font-semibold mt-1">{members.length}</dd>
              </div>
            )}
          </dl>
          {members.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {members.map((m) => (
                <span key={m.id} className="inline-flex items-center gap-1.5 text-[13px] px-3 py-1.5 rounded-full bg-white/5 border border-white/12">
                  {m.is_member && <BadgeCheck size={13} className="text-emerald-400" />}
                  <span>{m.name}</span>
                </span>
              ))}
            </div>
          )}
        </div>

        <section className="mt-8" aria-labelledby="change-date">
          <h2 id="change-date" className="flex items-center gap-2 text-lg font-bold uppercase tracking-tight mb-3">
            <CalendarClock size={18} className="text-white/60" /> Change your date
          </h2>

          {!entry.can_move ? (
            <p className="p-4 rounded-xl bg-white/[0.03] border border-white/10 text-sm text-white/70">{entry.move_blocked_reason}</p>
          ) : options === null ? (
            <Loader2 size={22} className="animate-spin text-white/40" aria-label="Loading dates" />
          ) : optionsError ? (
            <p role="alert" className="p-4 rounded-xl bg-white/[0.03] border border-white/10 text-sm text-white/70">{optionsError}</p>
          ) : options.length === 0 ? (
            <p className="p-4 rounded-xl bg-white/[0.03] border border-white/10 text-sm text-white/70">
              There are no other dates you can move to right now.
            </p>
          ) : (
            <ul className="space-y-3">
              {options.map((o) => (
                <li key={o.event_id} className="p-4 rounded-xl bg-white/[0.03] border border-white/10">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="font-semibold">{o.name}</p>
                    <p className="text-[13px] text-white/60 shrink-0">{dateLabel(o.race_date)}</p>
                  </div>
                  {o.location_name && <p className="text-[13px] text-white/50 mt-0.5">{o.location_name}</p>}
                  <p className="text-[13px] text-white/70 mt-1">{o.price_note}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {o.times.length > 0 ? o.times.map((t) => (
                      <button
                        key={t.wave_id}
                        type="button"
                        onClick={() => { setChoice({ option: o, time: t }); setMoveError(null); setNotice(null) }}
                        className="text-[13px] font-semibold px-3 py-2 rounded-lg border border-white/18 bg-white/[0.03] hover:bg-white/[0.08] hover:border-white/40"
                      >
                        {timeText(t)}
                      </button>
                    )) : (
                      <button
                        type="button"
                        onClick={() => { setChoice({ option: o, time: null }); setMoveError(null); setNotice(null) }}
                        className="text-[13px] font-semibold px-3 py-2 rounded-lg border border-white/18 bg-white/[0.03] hover:bg-white/[0.08] hover:border-white/40"
                      >
                        Choose {o.name}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {choice && (
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-labelledby="confirm-move">
            <div data-confirm className="w-full max-w-md rounded-2xl bg-neutral-950 border border-white/15 p-6">
              <h3 id="confirm-move" className="text-lg font-bold">Move your entry?</h3>
              <p className="text-sm text-white/70 mt-2">
                To <strong className="text-white">{choice.option.name}</strong>, {dateLabel(choice.option.race_date, { weekday: 'long', day: 'numeric', month: 'long' })}
                {choice.time ? ` at ${timeText(choice.time)}` : ''}.
              </p>
              <p className="text-sm text-white/70 mt-2">
                {dearer
                  ? `${money(choice.option.price_difference_cents, choice.option.currency)} more. You pay the difference first, then your entry moves.`
                  : choice.option.price_note}
              </p>
              <p className="text-[13px] text-white/50 mt-2">Your current tickets stop working once it moves; new ones come by email.</p>
              {moveError && <p role="alert" className="mt-3 text-sm text-red-300">{moveError}</p>}
              <div className="mt-5 flex gap-3">
                <button type="button" onClick={() => { setChoice(null); setMoveError(null) }} disabled={busy}
                  className="flex-1 py-3 rounded-xl border border-white/18 text-sm font-semibold text-white/80 hover:bg-white/[0.06]">
                  Back
                </button>
                <button type="button" onClick={confirmMove} disabled={busy}
                  className="flex-1 py-3 rounded-xl bg-white text-black text-sm font-semibold hover:bg-white/90 disabled:opacity-60">
                  {busy ? 'Working…' : dearer ? `Pay ${money(choice.option.price_difference_cents, choice.option.currency)} and move` : 'Move my entry'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
