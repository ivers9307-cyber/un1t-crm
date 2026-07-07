'use client'

// RaceConfirmedPage — post-payment success page (mig 084).
//
// Polls the registration once on load. If the status is still
// pending_payment (webhook hasn't landed yet), polls every 2s for up
// to 20 seconds before showing a "we're working on it" message —
// in practice the webhook beats the redirect 99% of the time.

import { useEffect, useState, useRef } from 'react'
import Link from 'next/link'
import { Loader2, AlertCircle, Calendar, BadgeCheck, QrCode } from 'lucide-react'

export default function RaceConfirmedPage({ slug, registrationId }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [polling, setPolling] = useState(false)
  const stoppedAt = useRef(null)

  useEffect(() => {
    if (!registrationId) {
      setError('Missing registration reference. Check the link from your confirmation email.')
      return
    }
    let cancelled = false
    let pollTimer = null
    stoppedAt.current = Date.now() + 20_000 // 20s budget

    async function tick() {
      try {
        const r = await fetch(`/api/public/event-registrations/${registrationId}`, { cache: 'no-store' })
        const j = await r.json()
        if (cancelled) return
        if (!j.success) {
          setError(j.error || 'Could not load registration')
          return
        }
        setData(j.data)
        if (j.data.status === 'pending_payment' && Date.now() < stoppedAt.current) {
          setPolling(true)
          pollTimer = setTimeout(tick, 2000)
        } else {
          setPolling(false)
        }
      } catch (e) {
        if (!cancelled) setError(e.message || 'Network error')
      }
    }
    tick()
    return () => { cancelled = true; if (pollTimer) clearTimeout(pollTimer) }
  }, [registrationId])

  if (error) {
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center p-6">
        <div className="lp-card-glow rounded-2xl p-8 max-w-sm text-center">
          <AlertCircle size={32} className="mx-auto text-red-400 mb-3" />
          <p className="text-white/70">{error}</p>
        </div>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="min-h-screen bg-black text-white flex items-center justify-center p-6">
        <Loader2 size={28} className="animate-spin text-white/40" />
      </div>
    )
  }

  const isConfirmed = data.status === 'confirmed'
  const race = data.race || {}
  const team = data.team || {}
  const wave = data.wave
  const members = (team.team_members || []).slice().sort((a, b) =>
    (a.role === 'captain' ? 0 : 1) - (b.role === 'captain' ? 0 : 1)
  )
  // Per-attendee check-in QR URLs, minted server-side once confirmed.
  const membersWithQr = members.filter((m) => m.qr_url)

  // Client-side .ics — no backend. 2h default duration, TZ-safe (all
  // UTC getters so the host machine's offset never contaminates the
  // Dublin wall-clock start_time; emitted as floating local time).
  const calendarHref = (() => {
    if (!race.race_date) return null
    const pad = (n) => String(n).padStart(2, '0')
    const [y, mo, d] = String(race.race_date).slice(0, 10).split('-').map(Number)
    const [hh, mm] = String(wave?.start_time || '09:00').slice(0, 5).split(':').map(Number)
    const startMs = Date.UTC(y, (mo || 1) - 1, d || 1, hh || 0, mm || 0)
    const endMs = startMs + 2 * 60 * 60 * 1000
    const local = (ms) => {
      const dt = new Date(ms)
      return `${dt.getUTCFullYear()}${pad(dt.getUTCMonth() + 1)}${pad(dt.getUTCDate())}T${pad(dt.getUTCHours())}${pad(dt.getUTCMinutes())}00`
    }
    const now = new Date()
    const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`
    const esc = (s) => String(s || '').replace(/([\\,;])/g, '\\$1').replace(/\r?\n/g, '\\n')
    const where = race.locations?.address || race.locations?.name || ''
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//UN1T//Events//EN',
      'CALSCALE:GREGORIAN',
      'BEGIN:VEVENT',
      `UID:${data.id}@un1tdublin.com`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${local(startMs)}`,
      `DTEND:${local(endMs)}`,
      `SUMMARY:${esc(race.name || 'UN1T Event')}`,
      where ? `LOCATION:${esc(where)}` : null,
      team.name ? `DESCRIPTION:${esc(`Team ${team.name}`)}` : null,
      'END:VEVENT',
      'END:VCALENDAR',
    ].filter(Boolean).join('\r\n')
    return `data:text/calendar;charset=utf8,${encodeURIComponent(ics)}`
  })()

  const dateLabel = race.race_date
    ? new Date(`${String(race.race_date).slice(0, 10)}T00:00:00`).toLocaleDateString('en-IE', {
        weekday: 'short', day: 'numeric', month: 'short',
      })
    : null
  const whereLabel = race.locations?.name || race.locations?.address

  return (
    <div className="min-h-screen bg-black text-white px-4 pt-16 pb-20">
      <div className="max-w-md mx-auto">
        {/* ── Header ─────────────────────────────────────────────── */}
        <div className="text-center mb-7">
          {isConfirmed ? (
            <div className="w-[60px] h-[60px] mx-auto mb-5 rounded-full grid place-items-center bg-emerald-500/10 border border-emerald-500/30">
              <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-emerald-400">
                <path className="lp-check-path" d="M20 6 9 17l-5-5" />
              </svg>
            </div>
          ) : (
            <div className="w-[60px] h-[60px] mx-auto mb-5 rounded-full grid place-items-center bg-amber-500/10 border border-amber-500/30 text-amber-400">
              <Loader2 size={28} className={polling ? 'animate-spin' : ''} />
            </div>
          )}
          <h1 className="text-3xl font-bold uppercase tracking-tight">
            {isConfirmed ? 'You\'re in' : 'Almost there…'}
          </h1>
          <p className="text-sm text-white/60 mt-2">
            {isConfirmed
              ? <>Team <strong className="text-white font-semibold">{team.name}</strong> is registered for {race.name}.</>
              : 'Finalising your payment — this should only take a moment.'}
          </p>
        </div>

        {/* ── Ticket pass ────────────────────────────────────────── */}
        <div className="lp-card-glow rounded-2xl overflow-hidden">
          {/* top: event eyebrow + check-in QR */}
          <div className="p-6 pb-5 text-center">
            <p className="text-[11px] uppercase tracking-[0.2em] text-white/45 font-semibold mb-4">
              {race.name}
            </p>
            {membersWithQr.length > 0 ? (
              <>
                <div className={`grid gap-4 ${membersWithQr.length === 1 ? 'grid-cols-1 justify-items-center' : 'grid-cols-2'}`}>
                  {membersWithQr.map((m) => {
                    const dim = membersWithQr.length === 1 ? 150 : 128
                    return (
                      <div key={m.id} className="flex flex-col items-center">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={m.qr_url}
                          alt={`Check-in code for ${m.name}`}
                          width={dim}
                          height={dim}
                          style={{ width: dim, height: dim }}
                          className="rounded-2xl bg-white p-2.5"
                        />
                        <span className="mt-2 text-[12px] text-white/75 inline-flex items-center gap-1">
                          {m.is_member && <BadgeCheck size={12} className="text-emerald-400" />}
                          {m.name}
                          {m.role === 'captain' && (
                            <span className="text-[10px] uppercase tracking-wider text-amber-400 font-semibold">· Captain</span>
                          )}
                        </span>
                      </div>
                    )
                  })}
                </div>
                <p className="mt-4 text-[11px] uppercase tracking-[0.16em] text-white/45">
                  {membersWithQr.length > 1 ? 'Show each attendee’s code at the door' : 'Show at the door to check in'}
                </p>
              </>
            ) : (
              <>
                <div className="mx-auto w-[150px] h-[150px] rounded-2xl bg-white/[0.04] border border-white/12 grid place-items-center">
                  <QrCode size={54} strokeWidth={1.25} className="text-white/25" />
                </div>
                <p className="mt-3 text-[11px] uppercase tracking-[0.16em] text-white/45">
                  {isConfirmed
                    ? 'Your check-in QR is in your confirmation email'
                    : 'Your check-in code appears once payment is confirmed'}
                </p>
              </>
            )}
          </div>

          {/* perforated divider — notches clip against the card's overflow-hidden */}
          <div className="relative h-6">
            <div className="absolute top-1/2 left-4 right-4 -translate-y-1/2 border-t border-dashed border-white/15" />
            <div className="absolute top-1/2 -left-3 -translate-y-1/2 w-6 h-6 rounded-full bg-black" />
            <div className="absolute top-1/2 -right-3 -translate-y-1/2 w-6 h-6 rounded-full bg-black" />
          </div>

          {/* bottom: facts grid + roster + calendar */}
          <div className="p-6 pt-5">
            <dl className="grid grid-cols-2 gap-px bg-white/10 rounded-xl overflow-hidden">
              {dateLabel && (
                <div className="bg-black p-3">
                  <dt className="text-[10px] uppercase tracking-[0.14em] text-white/45 font-semibold">Date</dt>
                  <dd className="text-[15px] font-semibold mt-1">{dateLabel}</dd>
                </div>
              )}
              {wave && (
                <div className="bg-black p-3">
                  <dt className="text-[10px] uppercase tracking-[0.14em] text-white/45 font-semibold">Wave</dt>
                  <dd className="text-[15px] font-semibold mt-1">
                    {wave.label ? `${wave.label} · ` : ''}{(wave.start_time || '').slice(0, 5)}
                  </dd>
                </div>
              )}
              {whereLabel && (
                <div className="bg-black p-3">
                  <dt className="text-[10px] uppercase tracking-[0.14em] text-white/45 font-semibold">Where</dt>
                  <dd className="text-[15px] font-semibold mt-1">{whereLabel}</dd>
                </div>
              )}
              {team.size && (
                <div className="bg-black p-3">
                  <dt className="text-[10px] uppercase tracking-[0.14em] text-white/45 font-semibold">Team</dt>
                  <dd className="text-[15px] font-semibold mt-1">{team.size}-person</dd>
                </div>
              )}
            </dl>

            {members.length > 0 && membersWithQr.length === 0 && (
              <div className="mt-4 flex flex-wrap gap-2">
                {members.map((m) => (
                  <span key={m.id} className="inline-flex items-center gap-1.5 text-[13px] px-3 py-1.5 rounded-full bg-white/5 border border-white/12">
                    {m.is_member && (
                      <BadgeCheck size={13} className="text-emerald-400" title="Verified UN1T member" />
                    )}
                    <span>{m.name}</span>
                    {m.role === 'captain' && (
                      <span className="text-[10px] uppercase tracking-wider text-amber-400 font-semibold">Captain</span>
                    )}
                  </span>
                ))}
              </div>
            )}

            {race.race_date && calendarHref && (
              <a
                href={calendarHref}
                download="event.ics"
                className="mt-5 flex items-center justify-center gap-2 w-full text-[13px] font-semibold py-3 rounded-xl border border-white/18 text-white/90 bg-white/[0.03] hover:bg-white/[0.08] hover:border-white/40 transition-colors"
              >
                <Calendar size={15} /> Add to calendar
              </a>
            )}
          </div>
        </div>

        {/* ── What's next ────────────────────────────────────────── */}
        <div className="mt-6 p-4 rounded-xl bg-white/[0.03] border border-white/10 text-xs text-white/60 leading-relaxed">
          <strong className="block text-white/90 mb-1 font-semibold">What&apos;s next:</strong>
          We&apos;ll email a reminder the day before with parking + check-in details. Arrive 30 minutes
          before your wave. Bring water, a towel, and your race-day energy. See you on the start line.
        </div>

        <div className="mt-6 text-center">
          <Link href={`/event/${slug}`} className="text-sm text-white/60 hover:text-white underline underline-offset-4">
            ← Back to {race.name || 'race'} signup
          </Link>
        </div>
      </div>
    </div>
  )
}
