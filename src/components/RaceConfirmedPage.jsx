'use client'

// RaceConfirmedPage — post-payment success page (mig 084).
//
// Polls the registration once on load. If the status is still
// pending_payment (webhook hasn't landed yet), polls every 2s for up
// to 20 seconds before showing a "we're working on it" message —
// in practice the webhook beats the redirect 99% of the time.

import { useEffect, useState, useRef } from 'react'
import Link from 'next/link'
import { Check, Loader2, AlertCircle, Calendar, Clock, MapPin, BadgeCheck, Users } from 'lucide-react'

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
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
        <div className="bg-white border border-gray-200 rounded-xl p-8 max-w-sm text-center">
          <AlertCircle size={32} className="mx-auto text-red-500 mb-3" />
          <p className="text-gray-700">{error}</p>
        </div>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
        <Loader2 size={28} className="animate-spin text-gray-400" />
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

  return (
    <div className="min-h-screen bg-gray-50 py-10 px-4">
      <div className="max-w-xl mx-auto bg-white border border-gray-200 rounded-2xl p-8 shadow-sm">
        <div className="text-center mb-6">
          {isConfirmed ? (
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-emerald-50 text-emerald-600 mb-4">
              <Check size={28} />
            </div>
          ) : (
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-amber-50 text-amber-600 mb-4">
              <Loader2 size={28} className={polling ? 'animate-spin' : ''} />
            </div>
          )}
          <h1 className="text-2xl font-bold text-gray-900">
            {isConfirmed ? 'You\'re in!' : 'Almost there…'}
          </h1>
          <p className="text-sm text-gray-600 mt-1">
            {isConfirmed
              ? <>Team <strong>{team.name}</strong> is registered for {race.name}.</>
              : 'Finalising your payment — this should only take a moment.'}
          </p>
        </div>

        <dl className="space-y-2 text-sm border-t border-gray-200 pt-4">
          <div className="flex items-start gap-2">
            <Calendar size={14} className="text-gray-400 mt-0.5 shrink-0" />
            <dt className="text-gray-500 w-20">Date</dt>
            <dd className="text-gray-900 font-medium">
              {race.race_date && new Date(race.race_date).toLocaleDateString('en-IE', {
                weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
              })}
            </dd>
          </div>
          {wave && (
            <div className="flex items-start gap-2">
              <Clock size={14} className="text-gray-400 mt-0.5 shrink-0" />
              <dt className="text-gray-500 w-20">Wave</dt>
              <dd className="text-gray-900 font-medium">
                {wave.label ? `${wave.label} · ` : ''}{(wave.start_time || '').slice(0, 5)}
              </dd>
            </div>
          )}
          {race.locations?.address && (
            <div className="flex items-start gap-2">
              <MapPin size={14} className="text-gray-400 mt-0.5 shrink-0" />
              <dt className="text-gray-500 w-20">Where</dt>
              <dd className="text-gray-900">{race.locations.address}</dd>
            </div>
          )}
          {team.size && (
            <div className="flex items-start gap-2">
              <Users size={14} className="text-gray-400 mt-0.5 shrink-0" />
              <dt className="text-gray-500 w-20">Team</dt>
              <dd className="text-gray-900 font-medium">{team.size}-person</dd>
            </div>
          )}
        </dl>

        {members.length > 0 && (
          <div className="mt-6 pt-4 border-t border-gray-200">
            <div className="text-[11px] uppercase tracking-wider text-gray-500 mb-2">Roster</div>
            <ul className="space-y-1 text-sm text-gray-800">
              {members.map((m) => (
                <li key={m.id} className="flex items-center gap-2">
                  <span>{m.name}</span>
                  {m.role === 'captain' && (
                    <span className="text-[10px] uppercase tracking-wider text-amber-700">Captain</span>
                  )}
                  {m.is_member && (
                    <span className="text-[10px] inline-flex items-center gap-0.5 text-emerald-700" title="Verified UN1T member">
                      <BadgeCheck size={11} /> Member
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="mt-6 p-4 rounded-md bg-gray-50 text-xs text-gray-600 leading-relaxed">
          <strong className="block text-gray-800 mb-1">What&apos;s next:</strong>
          We&apos;ll email a reminder the day before with parking + check-in details. Arrive 30 minutes
          before your wave. Bring water, a towel, and your race-day energy. See you on the start line.
        </div>

        <div className="mt-6 text-center">
          <Link href={`/event/${slug}`} className="text-sm text-gray-600 hover:text-gray-900 underline">
            ← Back to {race.name || 'race'} signup
          </Link>
        </div>
      </div>
    </div>
  )
}
