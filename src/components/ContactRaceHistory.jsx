'use client'

// ContactRaceHistory — the "Events" card on the /contacts/[id] profile
// page (mig 086). Lists every race event this contact has competed in
// (as captain or member), with team name, wave, finish time and — for
// host-run events (HOST-MASTER.6b) — the hosting party.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Loader2, AlertCircle, Flag, Star, BadgeCheck, Clock } from 'lucide-react'

export default function ContactRaceHistory({ contactId }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/contacts/${contactId}/events`, { cache: 'no-store' })
      .then(r => r.json())
      .then(j => {
        if (cancelled) return
        if (!j.success) setError(j.error || 'Could not load race history')
        else setData(j.data)
      })
      .catch(e => { if (!cancelled) setError(e.message || 'Network error') })
    return () => { cancelled = true }
  }, [contactId])

  if (error) {
    return (
      <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-sm rounded-md p-3 inline-flex items-start gap-2">
        <AlertCircle size={14} className="mt-0.5 shrink-0" /> {error}
      </div>
    )
  }
  if (!data) {
    return (
      <div className="text-sm text-un1t-subtle inline-flex items-center gap-2 px-3 py-2">
        <Loader2 size={14} className="animate-spin" /> Loading races…
      </div>
    )
  }
  if (data.length === 0) {
    return (
      <div className="text-sm text-un1t-subtle italic px-3 py-3">
        No race history yet.
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {data.map((r) => {
        const elapsed = formatElapsed(r.elapsed_seconds)
        const dateLabel = r.race?.race_date
          ? new Date(r.race.race_date).toLocaleDateString('en-IE', {
              day: 'numeric', month: 'short', year: 'numeric',
            })
          : ''
        const waveLabel = r.wave
          ? `${r.wave.label ? `${r.wave.label} · ` : ''}${(r.wave.start_time || '').slice(0, 5)}`
          : ''
        return (
          <div
            key={r.registration_id}
            className="bg-un1t-surface border border-un1t-border rounded-md p-3 flex items-start justify-between gap-3"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <Flag size={12} className="text-un1t-subtle" />
                <Link
                  href={`/events/${r.race?.id}/teams`}
                  className="text-sm font-medium text-un1t-text hover:text-un1t-accent truncate"
                >
                  {r.race?.name || '(unknown race)'}
                </Link>
                <StatusPill status={r.registration_status} />
                {r.member_role === 'captain' && (
                  <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-700 inline-flex items-center gap-1">
                    <Star size={10} /> Captain
                  </span>
                )}
                {r.is_member && (
                  <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-700 inline-flex items-center gap-1">
                    <BadgeCheck size={10} /> Member
                  </span>
                )}
              </div>
              {/* HOST-MASTER.6b — hosting party (NULL host = internal UN1T event). */}
              {r.hostName && (
                <div className="text-xs text-un1t-muted mt-0.5">Hosted by {r.hostName}</div>
              )}
              <div className="text-[11px] text-un1t-subtle mt-1">
                {dateLabel}
                {r.team?.name && <> · Team {r.team.name} ({r.team.size}-person)</>}
                {waveLabel && (
                  <> · <Clock size={10} className="inline" /> {waveLabel}</>
                )}
              </div>
            </div>
            <div className="text-right shrink-0">
              {elapsed ? (
                <div className="font-mono text-sm font-semibold text-emerald-700 tabular-nums">{elapsed}</div>
              ) : r.race_started_at ? (
                <div className="text-[11px] text-amber-700">On course</div>
              ) : (
                <div className="text-[11px] text-un1t-muted">Not started</div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function StatusPill({ status }) {
  const map = {
    confirmed: 'bg-emerald-500/15 text-emerald-700',
    pending_payment: 'bg-amber-500/15 text-amber-700',
    cancelled: 'bg-gray-500/15 text-gray-600',
    no_show: 'bg-red-500/15 text-red-700',
  }
  return (
    <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full ${map[status] || 'bg-un1t-border/30 text-un1t-subtle'}`}>
      {status?.replaceAll('_', ' ')}
    </span>
  )
}

function formatElapsed(seconds) {
  if (!Number.isFinite(seconds)) return ''
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}
