'use client'

// RaceEventForm — operator create/edit form for a standalone race
// event (mig 082). Used by /races/new and /races/[id]/edit.
//
// Standalone from EventForm because races have a different shape:
// no recurring availability calendar, no slot generation, no
// duration_minutes — instead a single race_date + start_time, a
// registration window, capacity, and allowed team sizes.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Calendar, Clock, Users, Save, AlertCircle, Loader2 } from 'lucide-react'
import Link from 'next/link'
import { toSlug } from '@/lib/slug'

const ALL_SIZES = [1, 2, 3, 4, 5, 6, 8]

export default function RaceEventForm({ race, locationId }) {
  const router = useRouter()
  const isEditing = !!race

  const [name, setName] = useState(race?.name || '')
  const [slug, setSlug] = useState(race?.slug || '')
  const [slugAuto, setSlugAuto] = useState(!isEditing)
  const [description, setDescription] = useState(race?.description || '')
  const [raceDate, setRaceDate] = useState(race?.race_date || '')
  const [startTime, setStartTime] = useState(race?.start_time?.slice(0, 5) || '')
  const [registrationOpensAt, setRegistrationOpensAt] = useState(
    race?.registration_opens_at ? toLocalInput(race.registration_opens_at) : ''
  )
  const [registrationClosesAt, setRegistrationClosesAt] = useState(
    race?.registration_closes_at ? toLocalInput(race.registration_closes_at) : ''
  )
  const [capacity, setCapacity] = useState(race?.capacity != null ? String(race.capacity) : '')
  const [allowedTeamSizes, setAllowedTeamSizes] = useState(
    Array.isArray(race?.allowed_team_sizes) && race.allowed_team_sizes.length > 0
      ? race.allowed_team_sizes
      : [1, 2, 4]
  )
  const [active, setActive] = useState(race?.active ?? true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  function onNameChange(v) {
    setName(v)
    if (slugAuto) setSlug(toSlug(v))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)

    if (!name.trim()) { setError('Name is required.'); return }
    if (!raceDate) { setError('Race date is required.'); return }
    if (allowedTeamSizes.length === 0) { setError('Pick at least one allowed team size.'); return }

    setSaving(true)
    const payload = {
      ...(isEditing ? {} : { location_id: locationId }),
      name: name.trim(),
      ...(isEditing ? {} : { slug: slug.trim() || undefined }),
      description: description.trim() || null,
      race_date: raceDate,
      start_time: startTime || null,
      registration_opens_at: registrationOpensAt ? new Date(registrationOpensAt).toISOString() : null,
      registration_closes_at: registrationClosesAt ? new Date(registrationClosesAt).toISOString() : null,
      capacity: capacity ? Number(capacity) : null,
      allowed_team_sizes: allowedTeamSizes,
      active,
    }

    const url = isEditing ? `/api/races/${race.id}` : '/api/races'
    const method = isEditing ? 'PUT' : 'POST'
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const json = await res.json()
    setSaving(false)

    if (!res.ok || json.success === false) {
      setError(json.error || `Save failed (${res.status})`)
      return
    }
    router.push('/races')
    router.refresh()
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <Link href="/races" className="inline-flex items-center gap-1.5 text-sm text-un1t-light hover:text-un1t-white">
        <ArrowLeft size={16} /> Back to Races
      </Link>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-sm rounded-lg p-3 inline-flex items-start gap-2">
          <AlertCircle size={14} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}

      <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5 space-y-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light">Race details</h3>

        <div>
          <label className="block text-sm text-un1t-light mb-1">Name *</label>
          <input
            type="text"
            required
            value={name}
            onChange={e => onNameChange(e.target.value)}
            placeholder="Hyrox race sim — May 2026"
            className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white"
          />
        </div>

        <div>
          <label className="block text-sm text-un1t-light mb-1">
            Slug
            {slugAuto && <span className="ml-1 text-[10px] text-un1t-mid">(auto-derived)</span>}
          </label>
          <input
            type="text"
            value={slug}
            onChange={e => { setSlug(e.target.value.toLowerCase()); setSlugAuto(false) }}
            disabled={isEditing}
            pattern="^[a-z0-9]+(-[a-z0-9]+)*$"
            placeholder="hyrox-may-2026"
            className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white font-mono disabled:opacity-50"
          />
          <p className="text-[11px] text-un1t-mid mt-1">
            Public signup page is at <span className="font-mono">/race/{slug || 'your-slug'}</span>.
            {isEditing && ' Slug cannot be changed after creation (would break shared links).'}
          </p>
        </div>

        <div>
          <label className="block text-sm text-un1t-light mb-1">Description</label>
          <textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            rows={3}
            placeholder="Tell teams what to expect…"
            className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white"
          />
        </div>
      </div>

      <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5 space-y-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light flex items-center gap-2">
          <Calendar size={14} /> When
        </h3>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm text-un1t-light mb-1">Race date *</label>
            <input
              type="date"
              required
              value={raceDate}
              onChange={e => setRaceDate(e.target.value)}
              className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white"
            />
          </div>
          <div>
            <label className="block text-sm text-un1t-light mb-1">First wave start time</label>
            <input
              type="time"
              value={startTime}
              onChange={e => setStartTime(e.target.value)}
              className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white"
            />
          </div>
        </div>
      </div>

      <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5 space-y-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light flex items-center gap-2">
          <Clock size={14} /> Registration window
        </h3>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm text-un1t-light mb-1">Opens</label>
            <input
              type="datetime-local"
              value={registrationOpensAt}
              onChange={e => setRegistrationOpensAt(e.target.value)}
              className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white"
            />
            <p className="text-[11px] text-un1t-mid mt-1">Empty = open from now.</p>
          </div>
          <div>
            <label className="block text-sm text-un1t-light mb-1">Closes</label>
            <input
              type="datetime-local"
              value={registrationClosesAt}
              onChange={e => setRegistrationClosesAt(e.target.value)}
              className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white"
            />
            <p className="text-[11px] text-un1t-mid mt-1">Empty = open until race date.</p>
          </div>
        </div>
        <div>
          <label className="block text-sm text-un1t-light mb-1">Capacity (max teams)</label>
          <input
            type="number"
            min={1}
            value={capacity}
            onChange={e => setCapacity(e.target.value)}
            placeholder="Unlimited"
            className="w-40 bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white"
          />
          <p className="text-[11px] text-un1t-mid mt-1">Empty = unlimited. Soft-enforced at signup time.</p>
        </div>
      </div>

      <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5 space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light flex items-center gap-2">
          <Users size={14} /> Allowed team sizes
        </h3>
        <p className="text-[11px] text-un1t-light">
          The signup form shows a radio constrained to these sizes. For each size {`>`} 1, the form
          renders {'N−1'} additional name+email pairs. Hyrox formats: 1 (singles), 2 (doubles), 4 (relay).
        </p>
        <div className="flex flex-wrap gap-2">
          {ALL_SIZES.map(s => {
            const on = allowedTeamSizes.includes(s)
            return (
              <button
                key={s}
                type="button"
                onClick={() => setAllowedTeamSizes(prev =>
                  prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s].sort((a, b) => a - b)
                )}
                className={`text-xs px-3 py-1.5 rounded-md border ${
                  on
                    ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-700'
                    : 'bg-un1t-black border-un1t-gray text-un1t-light hover:border-un1t-mid'
                }`}
              >
                {s}-person
              </button>
            )
          })}
        </div>
      </div>

      {isEditing && (
        <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5 flex items-center justify-between">
          <div>
            <div className="text-sm text-un1t-white">Active</div>
            <div className="text-[11px] text-un1t-light">Inactive races are hidden from public signup but kept for history.</div>
          </div>
          <button
            type="button"
            onClick={() => setActive(v => !v)}
            className={`shrink-0 w-10 h-5 rounded-full ${active ? 'bg-emerald-500' : 'bg-un1t-gray'}`}
          >
            <div className={`w-4 h-4 rounded-full bg-white transition-transform ${active ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
        </div>
      )}

      <button
        type="submit"
        disabled={saving}
        className="w-full inline-flex items-center justify-center gap-2 bg-un1t-white text-un1t-black font-medium text-sm py-2.5 rounded-md hover:bg-un1t-accent disabled:opacity-50"
      >
        {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
        {saving ? 'Saving…' : isEditing ? 'Save Changes' : 'Create Race'}
      </button>
    </form>
  )
}

// Convert ISO timestamp to the local-datetime input format
// (YYYY-MM-DDTHH:MM, no timezone) the <input type="datetime-local">
// expects.
function toLocalInput(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
