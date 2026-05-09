'use client'

// RaceEventForm — operator create/edit form for a standalone race
// event (mig 082). Used by /events/new and /events/[id]/edit.
//
// Standalone from EventForm because races have a different shape:
// no recurring availability calendar, no slot generation, no
// duration_minutes — instead a single race_date + start_time, a
// registration window, capacity, and allowed team sizes.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Calendar, Clock, Users, Save, AlertCircle, Loader2, Plus, Trash2, BadgeEuro, ImagePlus, X as XIcon, Tv } from 'lucide-react'
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
  const [registrationOpensAt, setRegistrationOpensAt] = useState(
    race?.registration_opens_at ? toLocalInput(race.registration_opens_at) : ''
  )
  const [registrationClosesAt, setRegistrationClosesAt] = useState(
    race?.registration_closes_at ? toLocalInput(race.registration_closes_at) : ''
  )
  const [allowedTeamSizes, setAllowedTeamSizes] = useState(
    Array.isArray(race?.allowed_team_sizes) && race.allowed_team_sizes.length > 0
      ? race.allowed_team_sizes
      : [1, 2, 4]
  )
  // Waves (mig 083). Each: { id?, start_time (HH:MM), capacity (string), label (string) }
  // id is preserved for existing waves so the API's diff-and-apply
  // hits update vs insert. Unidentified rows (new waves added in
  // this session) get inserted server-side.
  const [waves, setWaves] = useState(() => {
    const incoming = Array.isArray(race?.waves) && race.waves.length > 0
      ? race.waves
      : [{ start_time: '09:00:00', capacity: null, label: null }]
    return incoming
      .slice()
      .sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''))
      .map((w) => ({
        id: w.id,
        start_time: (w.start_time || '').slice(0, 5),
        capacity: w.capacity != null ? String(w.capacity) : '',
        label: w.label || '',
      }))
  })
  const [active, setActive] = useState(race?.active ?? true)
  // Member pricing (mig 084). Stored as cents on the wire; the form
  // shows whole-euro inputs and converts on submit.
  const [memberPricingEnabled, setMemberPricingEnabled] = useState(!!race?.member_pricing_enabled)
  const [membersOnly, setMembersOnly] = useState(!!race?.members_only)
  const [memberFee, setMemberFee] = useState(
    race?.member_fee_cents != null ? String(race.member_fee_cents / 100) : ''
  )
  const [nonMemberFee, setNonMemberFee] = useState(
    race?.non_member_fee_cents != null ? String(race.non_member_fee_cents / 100) : ''
  )
  // Mig 092: TV-display logos. Each slot holds either a URL (already
  // uploaded + saved on the race) or null. Slot index is the
  // visual position; we pack out empties on save so tv_logos in the
  // DB is a contiguous array.
  const [logos, setLogos] = useState(() => {
    const incoming = Array.isArray(race?.tv_logos) ? race.tv_logos : []
    return [incoming[0] || null, incoming[1] || null, incoming[2] || null]
  })
  const [logoBusy, setLogoBusy] = useState(null) // slot index currently uploading
  const [logoError, setLogoError] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  function onNameChange(v) {
    setName(v)
    if (slugAuto) setSlug(toSlug(v))
  }

  // Mig 092: upload a single TV logo into the slot. Requires the
  // race to exist (POST /api/events/[id]/logo needs an id) — for new
  // races we hide the section until after first save.
  async function handleLogoUpload(slot, file) {
    if (!race?.id) {
      setLogoError('Save the race first, then add logos.')
      return
    }
    setLogoError(null)
    setLogoBusy(slot)
    try {
      const fd = new FormData()
      fd.append('file', file)
      fd.append('slot', String(slot))
      const r = await fetch(`/api/events/${race.id}/logo`, { method: 'POST', body: fd })
      const j = await r.json()
      if (!r.ok || j.success === false) {
        setLogoError(j.error || `Upload failed (${r.status})`)
        return
      }
      const next = [...logos]
      next[slot] = j.url
      setLogos(next)
    } catch (e) {
      setLogoError(e.message || 'Network error')
    } finally {
      setLogoBusy(null)
    }
  }

  async function handleLogoRemove(slot) {
    if (!race?.id) return
    setLogoError(null)
    setLogoBusy(slot)
    try {
      // Best-effort: clear bytes on storage AND clear the slot in
      // local state. Operator must still hit Save Changes to persist
      // the new tv_logos array.
      await fetch(`/api/events/${race.id}/logo?slot=${slot}`, { method: 'DELETE' })
      const next = [...logos]
      next[slot] = null
      setLogos(next)
    } finally {
      setLogoBusy(null)
    }
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)

    if (!name.trim()) { setError('Name is required.'); return }
    if (!raceDate) { setError('Race date is required.'); return }
    if (allowedTeamSizes.length === 0) { setError('Pick at least one allowed team size.'); return }
    if (waves.length === 0) { setError('Add at least one wave.'); return }
    // Surface duplicate wave times before the server complains.
    const seenTimes = new Set()
    for (const w of waves) {
      if (!w.start_time) { setError('Every wave needs a start time.'); return }
      if (seenTimes.has(w.start_time)) {
        setError(`Two waves can't share the same start time (${w.start_time}).`)
        return
      }
      seenTimes.add(w.start_time)
    }

    // Pricing validation. Empty input → null fee (free for that
    // category). Negative or non-numeric → error.
    const memberFeeCents = memberFee.trim() === '' ? null : Math.round(Number(memberFee) * 100)
    const nonMemberFeeCents = nonMemberFee.trim() === '' ? null : Math.round(Number(nonMemberFee) * 100)
    if (memberFeeCents != null && (!Number.isFinite(memberFeeCents) || memberFeeCents < 0)) {
      setError('Member fee must be a positive number (or empty for free).')
      return
    }
    if (nonMemberFeeCents != null && (!Number.isFinite(nonMemberFeeCents) || nonMemberFeeCents < 0)) {
      setError('Non-member fee must be a positive number (or empty for free).')
      return
    }

    setSaving(true)
    const sortedWaves = waves.slice().sort((a, b) => a.start_time.localeCompare(b.start_time))
    const payload = {
      ...(isEditing ? {} : { location_id: locationId }),
      name: name.trim(),
      ...(isEditing ? {} : { slug: slug.trim() || undefined }),
      description: description.trim() || null,
      race_date: raceDate,
      registration_opens_at: registrationOpensAt ? new Date(registrationOpensAt).toISOString() : null,
      registration_closes_at: registrationClosesAt ? new Date(registrationClosesAt).toISOString() : null,
      allowed_team_sizes: allowedTeamSizes,
      active,
      member_pricing_enabled: memberPricingEnabled,
      members_only: membersOnly,
      member_fee_cents: memberPricingEnabled ? memberFeeCents : null,
      non_member_fee_cents: nonMemberFeeCents,
      // Mig 092: pack out empty slots so tv_logos is a contiguous
      // array. The schema enforces max length so trim defensively.
      tv_logos: logos.filter((u) => typeof u === 'string' && u.length > 0).slice(0, 3),
      waves: sortedWaves.map((w, i) => ({
        ...(w.id ? { id: w.id } : {}),
        start_time: w.start_time,
        capacity: w.capacity ? Number(w.capacity) : null,
        label: w.label.trim() || null,
        display_order: i,
      })),
    }

    const url = isEditing ? `/api/events/${race.id}` : '/api/events'
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
    router.push('/events')
    router.refresh()
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <Link href="/events" className="inline-flex items-center gap-1.5 text-sm text-un1t-light hover:text-un1t-white">
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
            Public signup page is at <span className="font-mono">/event/{slug || 'your-slug'}</span>.
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
          <Calendar size={14} /> Race date
        </h3>
        <div>
          <input
            type="date"
            required
            value={raceDate}
            onChange={e => setRaceDate(e.target.value)}
            className="w-56 bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white"
          />
        </div>
      </div>

      <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light flex items-center gap-2">
            <Clock size={14} /> Waves
          </h3>
          <button
            type="button"
            onClick={() => setWaves(prev => [...prev, { start_time: '', capacity: '', label: '' }])}
            className="text-xs text-blue-400 hover:text-blue-300 inline-flex items-center gap-1"
          >
            <Plus size={11} /> Add wave
          </button>
        </div>
        <p className="text-[11px] text-un1t-light -mt-2">
          Multiple start times throughout the race day. Each wave has its own capacity. Teams pick a
          wave at signup. Per-wave capacity is soft-enforced at signup time (a fast-fingered team
          can in theory squeeze in over the cap during a near-simultaneous signup; acceptable for v1).
        </p>
        <div className="space-y-2">
          {waves.map((w, i) => (
            <div key={i} className="grid grid-cols-[110px_120px_1fr_auto] gap-2 items-center">
              <input
                type="time"
                required
                value={w.start_time}
                onChange={e => setWaves(prev => prev.map((x, j) => j === i ? { ...x, start_time: e.target.value } : x))}
                className="bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white"
              />
              <input
                type="number"
                min={1}
                placeholder="Unlimited"
                value={w.capacity}
                onChange={e => setWaves(prev => prev.map((x, j) => j === i ? { ...x, capacity: e.target.value } : x))}
                className="bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white"
                title="Max teams in this wave (empty = unlimited)"
              />
              <input
                type="text"
                placeholder="Label (optional, e.g. Morning)"
                value={w.label}
                onChange={e => setWaves(prev => prev.map((x, j) => j === i ? { ...x, label: e.target.value } : x))}
                className="bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white"
              />
              <button
                type="button"
                onClick={() => setWaves(prev => prev.length > 1 ? prev.filter((_, j) => j !== i) : prev)}
                disabled={waves.length === 1}
                className="text-un1t-light hover:text-red-700 disabled:opacity-30 p-1"
                title={waves.length === 1 ? 'A race must have at least one wave' : 'Remove this wave'}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
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

      <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5 space-y-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light flex items-center gap-2">
          <BadgeEuro size={14} /> Pricing
        </h3>
        <p className="text-[11px] text-un1t-light -mt-2">
          Per-person pricing. Mixed teams pay each head at their own rate (e.g. 2 members + 2
          non-members on a 4-person team = 2 × member fee + 2 × non-member fee). Leave a fee blank
          to make that category free. UN1T members are matched by the email on their member account.
        </p>

        <div>
          <label className="block text-sm text-un1t-light mb-1">Non-member fee (€ per person)</label>
          <input
            type="number"
            min={0}
            step="0.01"
            value={nonMemberFee}
            onChange={e => setNonMemberFee(e.target.value)}
            placeholder="Free"
            className="w-40 bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white"
          />
          <p className="text-[11px] text-un1t-mid mt-1">
            Charged per non-member entrant. Leave empty for a free race.
          </p>
        </div>

        <div className="flex items-center justify-between gap-3 pt-2 border-t border-un1t-gray">
          <div>
            <div className="text-sm text-un1t-white">Different pricing for UN1T members</div>
            <div className="text-[11px] text-un1t-light">When on, the signup form validates member emails and applies the member rate per verified head.</div>
          </div>
          <button
            type="button"
            onClick={() => setMemberPricingEnabled(v => !v)}
            className={`shrink-0 w-10 h-5 rounded-full ${memberPricingEnabled ? 'bg-emerald-500' : 'bg-un1t-gray'}`}
          >
            <div className={`w-4 h-4 rounded-full bg-white transition-transform ${memberPricingEnabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
        </div>

        {memberPricingEnabled && (
          <div className="pl-2">
            <label className="block text-sm text-un1t-light mb-1">Member fee (€ per person)</label>
            <input
              type="number"
              min={0}
              step="0.01"
              value={memberFee}
              onChange={e => setMemberFee(e.target.value)}
              placeholder="Free for members"
              className="w-40 bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white"
            />
            <p className="text-[11px] text-un1t-mid mt-1">
              Empty = members enter free. Members are matched against contacts with active membership at the race&apos;s location.
            </p>
          </div>
        )}

        <div className="flex items-center justify-between gap-3 pt-2 border-t border-un1t-gray">
          <div>
            <div className="text-sm text-un1t-white">Members only</div>
            <div className="text-[11px] text-un1t-light">Refuse signups containing any unverified members. Independent of pricing — a free members-only race is valid.</div>
          </div>
          <button
            type="button"
            onClick={() => setMembersOnly(v => !v)}
            className={`shrink-0 w-10 h-5 rounded-full ${membersOnly ? 'bg-amber-500' : 'bg-un1t-gray'}`}
          >
            <div className={`w-4 h-4 rounded-full bg-white transition-transform ${membersOnly ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
        </div>
      </div>

      {/* Mig 092: TV-display logos. Only shown after the race exists
          because the upload route needs a race id to namespace the
          storage path. For brand-new races we render a hint instead. */}
      <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5 space-y-4">
        <div className="flex items-start gap-3">
          <Tv size={18} className="text-un1t-light mt-0.5 shrink-0" />
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light">TV display logos</h3>
            <p className="text-[11px] text-un1t-light mt-1">
              Up to 3 logos rendered centred in the header of <code>/race/&lt;slug&gt;/display</code>. Use the same height across logos for the cleanest look. PNG/JPEG/WebP/SVG, max 2MB each.
            </p>
          </div>
        </div>

        {!isEditing ? (
          <div className="bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-[11px] text-un1t-light">
            Save the race first — you&apos;ll be able to add logos after it&apos;s created.
          </div>
        ) : (
          <>
            {logoError && (
              <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-xs rounded-md px-3 py-2">
                {logoError}
              </div>
            )}
            <div className="grid grid-cols-3 gap-3">
              {[0, 1, 2].map((slot) => (
                <LogoSlot
                  key={slot}
                  slot={slot}
                  url={logos[slot]}
                  busy={logoBusy === slot}
                  onPick={(file) => handleLogoUpload(slot, file)}
                  onRemove={() => handleLogoRemove(slot)}
                />
              ))}
            </div>
            <p className="text-[11px] text-un1t-mid">
              Logo bytes save immediately. The slot order doesn&apos;t persist until you click <strong>Save Changes</strong> below.
            </p>
          </>
        )}
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

// Mig 092: a single TV-logo slot. Empty state shows a dashed
// dropzone-style button; populated state shows the image with a
// remove (X) button. Clicking the slot opens the file picker.
function LogoSlot({ slot, url, busy, onPick, onRemove }) {
  const inputId = `race-logo-input-${slot}`
  if (url) {
    return (
      <div className="relative bg-un1t-black border border-un1t-gray rounded-md aspect-video flex items-center justify-center p-3 group">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt={`Logo ${slot + 1}`} className="max-h-full max-w-full object-contain" />
        <button
          type="button"
          onClick={onRemove}
          disabled={busy}
          className="absolute top-1 right-1 bg-un1t-dark/90 border border-un1t-gray rounded-full p-1 text-un1t-light hover:text-red-500 disabled:opacity-50"
          title="Remove logo"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <XIcon size={12} />}
        </button>
        <span className="absolute bottom-1 left-2 text-[10px] text-un1t-mid">Slot {slot + 1}</span>
      </div>
    )
  }
  return (
    <label
      htmlFor={inputId}
      className={`bg-un1t-black border-2 border-dashed border-un1t-gray hover:border-un1t-mid rounded-md aspect-video flex flex-col items-center justify-center text-un1t-light cursor-pointer ${busy ? 'opacity-50 pointer-events-none' : ''}`}
    >
      {busy ? <Loader2 size={20} className="animate-spin" /> : <ImagePlus size={20} />}
      <span className="text-[11px] mt-1">{busy ? 'Uploading…' : `Add logo ${slot + 1}`}</span>
      <input
        id={inputId}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/svg+xml"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onPick(f)
          e.target.value = '' // reset so re-picking the same file fires onChange
        }}
      />
    </label>
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
