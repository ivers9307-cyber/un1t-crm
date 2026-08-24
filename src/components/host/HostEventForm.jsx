'use client'

// HOST-PORTAL.3 — host self-serve event create/edit form. Dark UN1T host-portal
// styling (bg-black surface, translucent-white inputs). Builds the exact strict
// HostEventSchema body (only the schema keys) and POSTs (create) / PUTs (edit)
// the host-scoped /api/host/events routes. Ticket price is entered in EUROS and
// converted to integer cents on submit. registration_opens_at/closes_at are not
// editable here — they're passed through unchanged (normalized to ISO) so an
// edit never silently wipes a reg window.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ImagePlus, Loader2, X } from 'lucide-react'
import { HOST_EVENT_KINDS } from '@/lib/host-events'
import { compressImageForUpload, parseUploadResponse } from '@/lib/landing-media-upload'

const KIND_LABELS = {
  workshop: 'Workshop',
  seminar: 'Seminar',
  masterclass: 'Masterclass',
  open_day: 'Open day',
  race: 'Race',
}

const ACCENT_RE = /^#[0-9a-fA-F]{6}$/

// Normalize a DB timestamp to a clean ISO-Z string zod's .datetime() accepts,
// or null. PostgREST returns "+00:00"-offset timestamps that plain .datetime()
// rejects, so round-trip through Date to force the "…Z" form.
function normalizeIso(v) {
  if (!v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function centsToEuros(cents) {
  if (cents == null) return ''
  return (Number(cents) / 100).toFixed(2)
}

const input =
  'w-full bg-white/[0.04] border border-white/12 rounded-lg px-3 py-2.5 text-sm text-white placeholder:text-white/40 focus:outline-none focus:border-white/30'
const labelCls = 'block text-xs uppercase tracking-wide text-white/45 mb-1.5'
const sectionCls = 'text-xs uppercase tracking-[0.15em] text-white/45 mb-3'

export default function HostEventForm({ mode = 'create', initial = null, eventId = null }) {
  const router = useRouter()
  const isEdit = mode === 'edit'

  const [kind, setKind] = useState(initial?.kind || 'workshop')
  const [name, setName] = useState(initial?.name || '')
  const [venueName, setVenueName] = useState(initial?.venue_name || '')
  const [venueAddress, setVenueAddress] = useState(initial?.venue_address || '')
  const [raceDate, setRaceDate] = useState(initial?.race_date || '')
  const [sessionStartTime, setSessionStartTime] = useState(initial?.session_start_time || '')
  const [sessionCapacity, setSessionCapacity] = useState(
    initial?.session_capacity != null ? String(initial.session_capacity) : ''
  )
  const [sessionLabel, setSessionLabel] = useState(initial?.session_label || '')
  const [teamSizes, setTeamSizes] = useState(
    Array.isArray(initial?.allowed_team_sizes) && initial.allowed_team_sizes.length
      ? [...initial.allowed_team_sizes].sort((a, b) => a - b)
      : [1]
  )
  const [priceEuros, setPriceEuros] = useState(
    initial?.non_member_fee_cents != null ? centsToEuros(initial.non_member_fee_cents) : ''
  )
  const [description, setDescription] = useState(initial?.description || '')
  const [heroImageUrl, setHeroImageUrl] = useState(initial?.hero_image_url || '')
  // HOST-PORTAL.11 — direct hero upload (edit mode only; the upload route
  // namespaces storage by event id, which doesn't exist until first save).
  const [heroBusy, setHeroBusy] = useState(false)
  const [heroError, setHeroError] = useState(null)
  const [accentHex, setAccentHex] = useState(initial?.accent_hex || '')

  const [confirmSubject, setConfirmSubject] = useState(initial?.confirmation_email_subject || '')
  const [confirmIntro, setConfirmIntro] = useState(initial?.confirmation_email_intro || '')
  const [reminderSubject, setReminderSubject] = useState(initial?.reminder_email_subject || '')
  const [reminderIntro, setReminderIntro] = useState(initial?.reminder_email_intro || '')

  const hasEmailCopy = !!(
    initial?.confirmation_email_subject ||
    initial?.confirmation_email_intro ||
    initial?.reminder_email_subject ||
    initial?.reminder_email_intro
  )
  const [showEmail, setShowEmail] = useState(hasEmailCopy)

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const [issues, setIssues] = useState([])

  // Reg window isn't editable here — preserve whatever the event already has.
  const regOpensAt = initial?.registration_opens_at ?? null
  const regClosesAt = initial?.registration_closes_at ?? null

  function toggleTeamSize(n) {
    setTeamSizes((prev) =>
      prev.includes(n) ? prev.filter((x) => x !== n) : [...prev, n].sort((a, b) => a - b)
    )
  }

  // HOST-PORTAL.11 — upload the hero bytes through the host-scoped mirror of
  // the staff hero route. The returned URL lands in the hero field and
  // persists onto the event via the normal PUT on save (the upload route only
  // owns the bytes, not the race_events row — same contract as staff).
  async function handleHeroUpload(file) {
    if (!isEdit || !eventId) return
    setHeroError(null)
    setHeroBusy(true)
    try {
      // Downscale in the browser first — a photo straight off a phone is
      // often over Vercel's ~4.5MB body cap, which rejects with a
      // plain-text 413 before the route (and its 5MB check) ever runs.
      const toSend = await compressImageForUpload(file)
      const fd = new FormData()
      fd.append('file', toSend, toSend.name || file.name || 'hero')
      const res = await fetch(`/api/host/events/${eventId}/hero`, { method: 'POST', body: fd })
      const out = await parseUploadResponse(res)
      if (!out.success) {
        setHeroError(out.error)
        return
      }
      setHeroImageUrl(out.url)
    } catch (err) {
      setHeroError(err?.message || 'Network error — please try again.')
    } finally {
      setHeroBusy(false)
    }
  }

  async function handleHeroRemove() {
    if (!isEdit || !eventId) return
    setHeroError(null)
    setHeroBusy(true)
    try {
      const res = await fetch(`/api/host/events/${eventId}/hero`, { method: 'DELETE' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || json.success === false) {
        setHeroError(json.error || `Remove failed (${res.status})`)
        return
      }
      // Clear the field too — hero_image_url persists as null on next save.
      setHeroImageUrl('')
    } catch (err) {
      setHeroError(err?.message || 'Network error — please try again.')
    } finally {
      setHeroBusy(false)
    }
  }

  function clientValidate() {
    if (!name.trim()) return 'Please give your event a name.'
    if (!venueName.trim()) return 'Please add a venue name.'
    if (!raceDate) return 'Please pick a date.'
    if (!sessionStartTime) return 'Please set a start time.'
    const cap = parseInt(sessionCapacity, 10)
    if (!Number.isFinite(cap) || cap < 1) return 'Capacity must be at least 1.'
    if (teamSizes.length === 0) return 'Pick at least one team size.'
    if (accentHex.trim() && !ACCENT_RE.test(accentHex.trim())) {
      return 'Accent colour must be a hex like #1a2b3c (or leave it blank).'
    }
    return null
  }

  function buildBody() {
    const trimmedText = (v) => {
      const t = (v || '').trim()
      return t === '' ? null : t
    }
    return {
      kind,
      name: name.trim(),
      description: trimmedText(description),
      race_date: raceDate,
      registration_opens_at: normalizeIso(regOpensAt),
      registration_closes_at: normalizeIso(regClosesAt),
      allowed_team_sizes: [...teamSizes].sort((a, b) => a - b),
      ticket_price_cents: Math.round((parseFloat(priceEuros) || 0) * 100),
      session_start_time: sessionStartTime,
      session_capacity: parseInt(sessionCapacity, 10),
      session_label: trimmedText(sessionLabel),
      hero_image_url: trimmedText(heroImageUrl),
      accent_hex: trimmedText(accentHex),
      venue_name: venueName.trim(),
      venue_address: trimmedText(venueAddress),
      confirmation_email_subject: trimmedText(confirmSubject),
      confirmation_email_intro: trimmedText(confirmIntro),
      reminder_email_subject: trimmedText(reminderSubject),
      reminder_email_intro: trimmedText(reminderIntro),
    }
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (submitting) return
    setError(null)
    setIssues([])

    const clientErr = clientValidate()
    if (clientErr) {
      setError(clientErr)
      return
    }

    setSubmitting(true)
    try {
      const url = isEdit ? `/api/host/events/${eventId}` : '/api/host/events'
      const method = isEdit ? 'PUT' : 'POST'
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBody()),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) {
        setError(json.error || 'Something went wrong. Please try again.')
        setIssues(Array.isArray(json.issues) ? json.issues : [])
        setSubmitting(false)
        return
      }
      const id = isEdit ? eventId : json.data?.id
      router.push(`/host/events/${id}`)
      router.refresh()
    } catch (err) {
      setError(err?.message || 'Network error. Please try again.')
      setSubmitting(false)
    }
  }

  const cancelHref = isEdit && eventId ? `/host/events/${eventId}` : '/host'

  return (
    <form onSubmit={handleSubmit} className="space-y-10">
      {/* Basics */}
      <section>
        <h2 className={sectionCls}>Basics</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="he-kind" className={labelCls}>Type</label>
            <select
              id="he-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              className={`${input} appearance-none`}
            >
              {HOST_EVENT_KINDS.map((k) => (
                <option key={k} value={k} className="bg-black text-white">
                  {KIND_LABELS[k] || k}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="he-name" className={labelCls}>Event name</label>
            <input
              id="he-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Spring Strength Workshop"
              className={input}
              required
            />
          </div>
          <div>
            <label htmlFor="he-venue" className={labelCls}>Venue name</label>
            <input
              id="he-venue"
              type="text"
              value={venueName}
              onChange={(e) => setVenueName(e.target.value)}
              placeholder="e.g. UN1T Stillorgan"
              className={input}
              required
            />
          </div>
          <div>
            <label htmlFor="he-venue-addr" className={labelCls}>Venue address <span className="text-white/30 normal-case">(optional)</span></label>
            <input
              id="he-venue-addr"
              type="text"
              value={venueAddress}
              onChange={(e) => setVenueAddress(e.target.value)}
              placeholder="Street, city"
              className={input}
            />
          </div>
        </div>
      </section>

      {/* Schedule */}
      <section>
        <h2 className={sectionCls}>Schedule</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label htmlFor="he-date" className={labelCls}>Date</label>
            <input
              id="he-date"
              type="date"
              value={raceDate}
              onChange={(e) => setRaceDate(e.target.value)}
              className={`${input} [color-scheme:dark]`}
              required
            />
          </div>
          <div>
            <label htmlFor="he-start" className={labelCls}>Start time</label>
            <input
              id="he-start"
              type="time"
              value={sessionStartTime}
              onChange={(e) => setSessionStartTime(e.target.value)}
              className={`${input} [color-scheme:dark]`}
              required
            />
          </div>
          <div>
            <label htmlFor="he-cap" className={labelCls}>Capacity</label>
            <input
              id="he-cap"
              type="number"
              min={1}
              step={1}
              value={sessionCapacity}
              onChange={(e) => setSessionCapacity(e.target.value)}
              placeholder="e.g. 30"
              className={input}
              required
            />
          </div>
        </div>
        <div className="mt-4">
          <label htmlFor="he-slabel" className={labelCls}>Session label <span className="text-white/30 normal-case">(optional)</span></label>
          <input
            id="he-slabel"
            type="text"
            value={sessionLabel}
            onChange={(e) => setSessionLabel(e.target.value)}
            placeholder="e.g. Morning session"
            className={`${input} sm:max-w-xs`}
          />
        </div>
      </section>

      {/* Tickets & teams */}
      <section>
        <h2 className={sectionCls}>Tickets &amp; teams</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="he-price" className={labelCls}>Ticket price (EUR)</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-white/40">€</span>
              <input
                id="he-price"
                type="number"
                min={0}
                step="0.01"
                value={priceEuros}
                onChange={(e) => setPriceEuros(e.target.value)}
                placeholder="0.00"
                className={`${input} pl-7`}
              />
            </div>
            <p className="mt-1.5 text-xs text-white/35">Set 0.00 for a free event.</p>
          </div>
          <div>
            <span className={labelCls}>Allowed team sizes</span>
            <div className="flex flex-wrap gap-2">
              {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => {
                const on = teamSizes.includes(n)
                return (
                  <label
                    key={n}
                    className={`cursor-pointer select-none rounded-lg border px-3 py-1.5 text-sm transition ${
                      on
                        ? 'border-white/40 bg-white/10 text-white'
                        : 'border-white/12 bg-white/[0.02] text-white/50 hover:text-white/80'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => toggleTeamSize(n)}
                      className="sr-only"
                    />
                    {n}
                  </label>
                )
              })}
            </div>
            <p className="mt-1.5 text-xs text-white/35">Pick every team size a booking may have.</p>
          </div>
        </div>
      </section>

      {/* Presentation */}
      <section>
        <h2 className={sectionCls}>Presentation</h2>
        <div>
          <label htmlFor="he-desc" className={labelCls}>Description <span className="text-white/30 normal-case">(optional)</span></label>
          <textarea
            id="he-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
            placeholder="What can attendees expect?"
            className={`${input} resize-y`}
          />
        </div>
        {/* Hero image — HOST-PORTAL.11. Edit mode uploads bytes directly via
            /api/host/events/[id]/hero (host-scoped mirror of the staff hero
            route); the returned URL fills the field below and persists via
            the normal PUT on save. The URL input stays as a secondary
            paste-a-link option. Create mode is URL-paste only — the upload
            route namespaces storage by event id, which doesn't exist yet. */}
        <div className="mt-4">
          {isEdit && eventId ? (
            <div>
              <span className={labelCls}>Hero image <span className="text-white/30 normal-case">(optional)</span></span>
              <div className="space-y-3">
                {heroError && (
                  <div className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                    {heroError}
                  </div>
                )}
                {heroImageUrl.trim() ? (
                  <div className="relative overflow-hidden rounded-lg border border-white/12 bg-white/[0.02]">
                    <img src={heroImageUrl} alt="Event hero" className="w-full max-h-56 object-cover" />
                    <button
                      type="button"
                      onClick={handleHeroRemove}
                      disabled={heroBusy}
                      title="Remove hero image"
                      className="absolute top-2 right-2 rounded-full border border-white/15 bg-black/70 p-1.5 text-white/60 hover:text-red-400 disabled:opacity-50"
                    >
                      {heroBusy ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />}
                    </button>
                  </div>
                ) : (
                  <label
                    htmlFor="he-hero-file"
                    className={`flex h-36 cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-white/12 bg-white/[0.02] text-white/45 transition hover:border-white/30 hover:text-white/70 ${heroBusy ? 'pointer-events-none opacity-50' : ''}`}
                  >
                    {heroBusy ? <Loader2 size={22} className="animate-spin" /> : <ImagePlus size={22} />}
                    <span className="mt-1.5 text-xs">{heroBusy ? 'Uploading…' : 'Upload hero image'}</span>
                    <span className="mt-0.5 text-[11px] text-white/30">PNG, JPEG or WebP · max 5MB</span>
                    <input
                      id="he-hero-file"
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0]
                        if (f) handleHeroUpload(f)
                        e.target.value = '' // reset so re-picking the same file fires onChange
                      }}
                    />
                  </label>
                )}
                <div>
                  <label htmlFor="he-hero" className="mb-1.5 block text-[11px] text-white/35">Or paste an image URL</label>
                  <input
                    id="he-hero"
                    type="url"
                    value={heroImageUrl}
                    onChange={(e) => setHeroImageUrl(e.target.value)}
                    placeholder="https://…"
                    className={input}
                  />
                </div>
                <p className="text-xs text-white/35">
                  Uploads save straight away — press “Save changes” to update your event page.
                </p>
              </div>
            </div>
          ) : (
            <div>
              <label htmlFor="he-hero" className={labelCls}>Hero image URL <span className="text-white/30 normal-case">(optional)</span></label>
              <input
                id="he-hero"
                type="url"
                value={heroImageUrl}
                onChange={(e) => setHeroImageUrl(e.target.value)}
                placeholder="https://…"
                className={input}
              />
              <p className="mt-1.5 text-xs text-white/35">You can upload an image after saving.</p>
            </div>
          )}
        </div>
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="he-accent" className={labelCls}>Accent colour <span className="text-white/30 normal-case">(optional)</span></label>
            <div className="flex items-center gap-3">
              <input
                id="he-accent"
                type="text"
                value={accentHex}
                onChange={(e) => setAccentHex(e.target.value)}
                placeholder="#1a2b3c"
                className={input}
              />
              <span
                className="h-9 w-9 shrink-0 rounded-lg border border-white/12"
                style={ACCENT_RE.test(accentHex.trim()) ? { backgroundColor: accentHex.trim() } : undefined}
                aria-hidden="true"
              />
            </div>
          </div>
        </div>
      </section>

      {/* Email copy (secondary, collapsed) */}
      <section>
        <button
          type="button"
          onClick={() => setShowEmail((v) => !v)}
          className="flex items-center gap-2 text-xs uppercase tracking-[0.15em] text-white/45 hover:text-white/70 transition"
        >
          <span>{showEmail ? '▾' : '▸'}</span>
          Email copy (optional)
        </button>
        {showEmail && (
          <div className="mt-4 space-y-4 border-l border-white/10 pl-4">
            <p className="text-xs text-white/40">
              Customise the confirmation and reminder emails attendees receive. Leave blank to use UN1T defaults.
            </p>
            <div>
              <label htmlFor="he-csub" className={labelCls}>Confirmation subject</label>
              <input
                id="he-csub"
                type="text"
                value={confirmSubject}
                onChange={(e) => setConfirmSubject(e.target.value)}
                className={input}
              />
            </div>
            <div>
              <label htmlFor="he-cintro" className={labelCls}>Confirmation intro</label>
              <textarea
                id="he-cintro"
                value={confirmIntro}
                onChange={(e) => setConfirmIntro(e.target.value)}
                rows={3}
                className={`${input} resize-y`}
              />
            </div>
            <div>
              <label htmlFor="he-rsub" className={labelCls}>Reminder subject</label>
              <input
                id="he-rsub"
                type="text"
                value={reminderSubject}
                onChange={(e) => setReminderSubject(e.target.value)}
                className={input}
              />
            </div>
            <div>
              <label htmlFor="he-rintro" className={labelCls}>Reminder intro</label>
              <textarea
                id="he-rintro"
                value={reminderIntro}
                onChange={(e) => setReminderIntro(e.target.value)}
                rows={3}
                className={`${input} resize-y`}
              />
            </div>
          </div>
        )}
      </section>

      {/* Errors */}
      {(error || issues.length > 0) && (
        <div className="rounded-lg border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error && <p>{error}</p>}
          {issues.length > 0 && (
            <ul className="mt-2 list-disc pl-4 space-y-0.5 text-red-300/90">
              {issues.map((iss, i) => (
                <li key={i}>
                  {(Array.isArray(iss.path) && iss.path.length ? `${iss.path.join('.')}: ` : '')}
                  {iss.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-3 pt-2">
        <button
          type="submit"
          disabled={submitting}
          className="rounded-lg bg-white text-black text-sm font-semibold px-5 py-2.5 hover:bg-white/90 disabled:opacity-60"
        >
          {submitting
            ? isEdit ? 'Saving…' : 'Creating…'
            : isEdit ? 'Save changes' : 'Create event'}
        </button>
        <a href={cancelHref} className="text-sm text-white/50 hover:text-white transition">
          Cancel
        </a>
      </div>
    </form>
  )
}
