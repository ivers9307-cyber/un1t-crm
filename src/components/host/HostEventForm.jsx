'use client'

// HOST-PORTAL.3 — host self-serve event create/edit form. Dark UN1T host-portal
// styling (HOSTTHEME.1: the host theme tokens and class kit, light and dark). Builds the exact strict
// HostEventSchema body (only the schema keys) and POSTs (create) / PUTs (edit)
// the host-scoped /api/host/events routes. Ticket price is entered in EUROS and
// converted to integer cents on submit. registration_opens_at/closes_at are not
// editable here — they're passed through unchanged (normalized to ISO) so an
// edit never silently wipes a reg window.

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { ImagePlus, Loader2, X } from 'lucide-react'
import { HOST_EVENT_KINDS, MAX_SESSIONS, RE_REVIEW_REASONS, RE_REVIEW_REASON_LABEL, reReviewReasons, editChangesFromInput } from '@/lib/host-events'
import { PLATFORM_NAME } from '@/lib/brand-name'
import { compressImageForUpload, parseUploadResponse } from '@/lib/landing-media-upload'
import PricingTiersEditor from '@/components/PricingTiersEditor'
import RegistrationQuestionsEditor from '@/components/RegistrationQuestionsEditor'
import { HOST_PANEL, HOST_SECTION, HOST_SECTION_DESC, HOST_LABEL, HOST_HINT, HOST_INPUT, HOST_TEXTAREA, HOST_WELL, HOST_BTN, HOST_BTN_PRIMARY, HOST_BTN_GHOST, HOST_CHOICE, HOST_CHOICE_ON, HOST_TAB, HOST_NOTICE, HOST_NOTICE_TONE } from '@/components/host/host-ui'
import GuardedLink from '@/components/host/GuardedLink'
import HostSubmitButton from '@/components/host/HostSubmitButton'
import OffSaleConfirmDialog, { joinLabels } from '@/components/host/OffSaleConfirmDialog'
import { hasUnsaved, setUnsaved } from '@/lib/unsaved-guard'

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

const input = HOST_INPUT
const labelCls = `${HOST_LABEL} mb-1.5`
const OPTIONAL = <span className="font-normal text-host-hint">(optional)</span>
// HOSTPORTAL.2 — the jump bar: pill label, section id (the ids live on the
// <section>s below).
const JUMPS = [
  { id: 'setup-basics', label: 'Basics' },
  { id: 'setup-schedule', label: 'Schedule & sessions' },
  { id: 'setup-tickets', label: 'Tickets & pricing' },
  { id: 'setup-questions', label: 'Questions at signup' },
  { id: 'setup-look', label: 'Page look' },
  { id: 'setup-emails', label: 'Emails' },
]


// One panel per section: a heading and a one-line description, then the fields.
function SectionHead({ children, desc }) {
  return (
    <div className="mb-4">
      <h2 className={HOST_SECTION}>{children}</h2>
      <p className={HOST_SECTION_DESC}>{desc}</p>
    </div>
  )
}
const panelCls = `${HOST_PANEL} scroll-mt-24`

// The off-sale rule's view of a body: the server trims a tier's name before it
// compares, so the form does too (a rename by spaces alone is not a change).
function predictedChanges(body) {
  const changes = editChangesFromInput(body)
  if (Array.isArray(changes.pricing_tiers)) {
    changes.pricing_tiers = changes.pricing_tiers.map((t) => ({ ...t, name: String(t.name ?? '').trim() }))
  }
  return changes
}

// brandName (W1.S1c): the host's organisation, resolved by the server page.
export default function HostEventForm({ mode = 'create', initial = null, eventId = null, brandName = PLATFORM_NAME, status = null }) {
  const router = useRouter()
  const isEdit = mode === 'edit'

  const [kind, setKind] = useState(initial?.kind || 'workshop')
  const [name, setName] = useState(initial?.name || '')
  const [venueName, setVenueName] = useState(initial?.venue_name || '')
  const [venueAddress, setVenueAddress] = useState(initial?.venue_address || '')
  const [raceDate, setRaceDate] = useState(initial?.race_date || '')
  // HOSTSERIES.1 — one row per session time (each a race_waves row). `key`
  // is the React key for a row that has no id yet.
  const [sessions, setSessions] = useState(() => {
    const given = Array.isArray(initial?.sessions) && initial.sessions.length > 0 ? initial.sessions : [{}]
    return given.map((s, i) => ({
      key: s.id || `new-${i}`,
      id: s.id || null,
      start_time: s.start_time || '',
      label: s.label || '',
      capacity: s.capacity != null ? String(s.capacity) : '',
    }))
  })
  // HOSTSERIES.1 — the host's series, for the Series select (hidden when none).
  const [seriesId, setSeriesId] = useState(initial?.series_id ?? null)
  const [seriesOptions, setSeriesOptions] = useState([])
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const r = await fetch('/api/host/series', { cache: 'no-store' })
        const j = await r.json()
        if (alive && j?.success && Array.isArray(j.data)) setSeriesOptions(j.data)
      } catch {
        // No series list: the select stays hidden; the form still saves.
      }
    })()
    return () => { alive = false }
  }, [])
  const [teamSizes, setTeamSizes] = useState(
    Array.isArray(initial?.allowed_team_sizes) && initial.allowed_team_sizes.length
      ? [...initial.allowed_team_sizes].sort((a, b) => a - b)
      : [1]
  )
  const [priceEuros, setPriceEuros] = useState(
    initial?.non_member_fee_cents != null ? centsToEuros(initial.non_member_fee_cents) : ''
  )
  const [description, setDescription] = useState(initial?.description || '')
  // TIERS.1 — early bird / capacity / group tiers.
  const [pricingTiers, setPricingTiers] = useState(Array.isArray(initial?.pricing_tiers) ? initial.pricing_tiers : [])
  // QUESTIONS.1 — asked at signup.
  const [questions, setQuestions] = useState(Array.isArray(initial?.registration_questions) ? initial.registration_questions : [])
  // CALENDAR.1 — minutes; blank = the kind's default (120 race / 60 otherwise).
  const [durationMinutes, setDurationMinutes] = useState(initial?.duration_minutes != null ? String(initial.duration_minutes) : '')
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
  // HOSTPAGE.2 — the post-event rating request's copy (null = defaults).
  const [ratingSubject, setRatingSubject] = useState(initial?.rating_email_subject || '')
  const [ratingIntro, setRatingIntro] = useState(initial?.rating_email_intro || '')

  const hasEmailCopy = !!(
    initial?.confirmation_email_subject ||
    initial?.confirmation_email_intro ||
    initial?.reminder_email_subject ||
    initial?.reminder_email_intro ||
    initial?.rating_email_subject ||
    initial?.rating_email_intro
  )
  const [showEmail, setShowEmail] = useState(hasEmailCopy)

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const [issues, setIssues] = useState([])
  const [saved, setSaved] = useState(false)
  // HOSTPORTAL.2 — the server took the last save off sale; the reasons the
  // confirm dialog is asking about (null = closed).
  const [offSale, setOffSale] = useState(false)
  const [confirmReasons, setConfirmReasons] = useState(null)
  // The last save sent the event to review, but the `status` prop still reads
  // published until the refresh lands: it is already off sale, so no second
  // dialog and no standing notice. Cleared when the status prop moves.
  const [wentOffSale, setWentOffSale] = useState(false)
  useEffect(() => { setWentOffSale(false) }, [status])
  const onSale = status === 'published' && !wentOffSale
  // What the SERVER holds, as far as the off-sale rule can tell. Starts as the
  // loaded event and moves to the body each save sent.
  const serverHolds = useRef({
    non_member_fee_cents: initial?.non_member_fee_cents,
    race_date: initial?.race_date,
    pricing_tiers: initial?.pricing_tiers,
    waves: (initial?.sessions || []).map((s) => ({ id: s.id, start_time: s.start_time })),
  })

  // Reg window isn't editable here — preserve whatever the event already has.
  const regOpensAt = initial?.registration_opens_at ?? null
  const regClosesAt = initial?.registration_closes_at ?? null

  function updateSession(key, patch) {
    setSessions((prev) => prev.map((s) => (s.key === key ? { ...s, ...patch } : s)))
  }
  function addSession() {
    setSessions((prev) => (prev.length >= MAX_SESSIONS ? prev : [...prev, { key: `new-${Date.now()}-${prev.length}`, id: null, start_time: '', label: '', capacity: '' }]))
  }
  function removeSession(key) {
    setSessions((prev) => (prev.length <= 1 ? prev : prev.filter((s) => s.key !== key)))
  }

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
    const seen = new Set()
    for (const [i, s] of sessions.entries()) {
      if (!s.start_time) return `Please set a start time for session ${i + 1}.`
      const cap = parseInt(s.capacity, 10)
      if (!Number.isFinite(cap) || cap < 1) return `Capacity for session ${i + 1} must be at least 1.`
      if (seen.has(s.start_time)) return 'Each session needs its own start time.'
      seen.add(s.start_time)
    }
    if (teamSizes.length === 0) return 'Pick at least one team size.'
    if (pricingTiers.some((t) => !String(t.name || '').trim())) return 'Give every pricing tier a name.'
    if (questions.some((q) => !String(q.label || '').trim())) return 'Give every question a label.'
    if (questions.some((q) => q.type === 'choice' && (q.options || []).length < 2)) return 'A choice question needs at least two options.'
    if (durationMinutes.trim() !== '') {
      const d = parseInt(durationMinutes, 10)
      if (!Number.isFinite(d) || d < 5 || d > 1440) return 'Duration must be between 5 minutes and a day.'
    }
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
      pricing_tiers: pricingTiers.length > 0 ? pricingTiers : null,
      registration_questions: questions.length > 0 ? questions : null,
      duration_minutes: durationMinutes.trim() === '' ? null : parseInt(durationMinutes, 10),
      sessions: sessions.map((s) => ({
        ...(s.id ? { id: s.id } : {}),
        start_time: s.start_time,
        label: trimmedText(s.label),
        capacity: parseInt(s.capacity, 10),
      })),
      // An edit always states its series (null leaves it), from state alone:
      // reading the live `initial` prop here made the body change when the
      // refresh handed down the saved value, which read as an unsaved edit.
      // A create sends the key only when a series is picked.
      ...(isEdit ? { series_id: seriesId || null } : (seriesId ? { series_id: seriesId } : {})),
      hero_image_url: trimmedText(heroImageUrl),
      accent_hex: trimmedText(accentHex),
      venue_name: venueName.trim(),
      venue_address: trimmedText(venueAddress),
      confirmation_email_subject: trimmedText(confirmSubject),
      confirmation_email_intro: trimmedText(confirmIntro),
      reminder_email_subject: trimmedText(reminderSubject),
      reminder_email_intro: trimmedText(reminderIntro),
      rating_email_subject: trimmedText(ratingSubject),
      rating_email_intro: trimmedText(ratingIntro),
    }
  }

  // The check at the moment of submitting (button or Enter): a published
  // event whose edit would be sent back to review asks first and sends
  // nothing until the host confirms.
  function handleSubmit(e) {
    e.preventDefault()
    if (submitting) return
    setError(null)
    setIssues([])
    setSaved(false)
    setOffSale(false)

    const clientErr = clientValidate()
    if (clientErr) {
      setError(clientErr)
      return
    }

    if (isEdit && onSale) {
      const reasons = reReviewReasons(
        { status, ...serverHolds.current },
        predictedChanges(buildBody()),
      )
      if (reasons.length > 0) {
        setConfirmReasons(reasons)
        return
      }
    }
    performSave()
  }

  async function performSave() {
    setSubmitting(true)
    try {
      const url = isEdit ? `/api/host/events/${eventId}` : '/api/host/events'
      const method = isEdit ? 'PUT' : 'POST'
      const sentBody = buildBody()
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sentBody),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) {
        setError(json.message || json.error || 'Something went wrong. Please try again.')
        setIssues(Array.isArray(json.issues) ? json.issues : [])
        setSubmitting(false)
        return
      }
      if (isEdit) {
        // Stay on the page: the saved body is the new baseline, and the
        // refresh re-renders the layout so the header's status chip updates.
        // An edit typed while the save was in flight is not saved: judge the
        // body as it is NOW against the one that was sent.
        baseline.current = JSON.stringify(sentBody)
        const sent = predictedChanges(sentBody)
        serverHolds.current = sent
        const nowOffSale = json.data?.reReview === true || wentOffSale
        if (nowOffSale) setWentOffSale(true)
        setOffSale(nowOffSale)
        const stillDirty = latestBody.current !== baseline.current
        setDirty(stillDirty)
        setUnsaved(stillDirty)
        setSaved(!stillDirty)
        setSubmitting(false)
        router.refresh()
        return
      }
      setUnsaved(false)
      router.push(`/host/events/${json.data?.id}/setup`)
      router.refresh()
    } catch (err) {
      setError(err?.message || 'Network error. Please try again.')
      setSubmitting(false)
    }
  }

  // HOSTPORTAL.2 — unsaved-changes tracking. The baseline is the body as first
  // rendered (the series fetch only fills the select's options, which the body
  // does not carry); a save moves it to the body that was saved.
  const currentBody = JSON.stringify(buildBody())
  const baseline = useRef(null)
  const latestBody = useRef(currentBody)
  function rebaseSessions(mapSessions) {
    if (!baseline.current) return
    const base = JSON.parse(baseline.current)
    base.sessions = mapSessions(base.sessions || [])
    baseline.current = JSON.stringify(base)
  }
  const [dirty, setDirty] = useState(false)
  useEffect(() => { latestBody.current = currentBody }, [currentBody])
  useEffect(() => {
    if (baseline.current === null) baseline.current = currentBody
    const isDirty = currentBody !== baseline.current
    setDirty(isDirty)
    setUnsaved(isDirty)
    if (isDirty) setSaved(false)
  }, [currentBody])
  useEffect(() => () => setUnsaved(false), [])

  // A save that added sessions leaves their rows id-less in this mounted form;
  // router.refresh() then hands down a fresh `initial` carrying the new ids.
  // Give each id-less row the id of the server session at the same start time
  // (never touching what was typed) and move the baseline the same way, so the
  // merge alone never changes dirty-ness. Without it the next save would
  // delete and re-create those sessions.
  const serverSessions = initial?.sessions
  useEffect(() => {
    if (!Array.isArray(serverSessions)) return
    // The refreshed event is what the server holds now, new session ids included.
    serverHolds.current = { ...serverHolds.current, waves: serverSessions.map((s) => ({ id: s.id, start_time: s.start_time })) }
    const hhmm = (t) => String(t || '').slice(0, 5)
    const idByTime = new Map(serverSessions.filter((s) => s.id).map((s) => [hhmm(s.start_time), s.id]))
    const taken = new Set(sessions.map((s) => s.id).filter(Boolean))
    const fill = (time) => {
      const id = idByTime.get(hhmm(time))
      return id && !taken.has(id) ? id : null
    }
    if (!sessions.some((s) => !s.id && fill(s.start_time))) return
    setSessions((prev) => prev.map((s) => {
      const id = s.id ? null : fill(s.start_time)
      return id ? { ...s, id } : s
    }))
    rebaseSessions((list) => list.map((s) => {
      const id = s.id ? null : fill(s.start_time)
      return id ? { id, ...s } : s
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverSessions])
  useEffect(() => {
    if (!dirty) return undefined
    // Consult the shared flag: an action that already cleared it (Take off
    // sale, Delete) must not raise the browser's prompt on its way out.
    const warn = (e) => {
      if (!hasUnsaved()) return
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  function jumpTo(id) {
    if (id === 'setup-emails') setShowEmail(true)
    document.getElementById(id)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
  }

  const cancelHref = isEdit && eventId ? `/host/events/${eventId}` : '/host/events'

  return (
    <form onSubmit={handleSubmit} className="space-y-10">
      {isEdit && onSale && (
        <div role="note" className={`${HOST_NOTICE} ${HOST_NOTICE_TONE.warn}`}>
          This event is on sale. Changing {joinLabels(RE_REVIEW_REASONS.map((r) => RE_REVIEW_REASON_LABEL[r]), 'or')} takes it <strong>off sale</strong> until {brandName} approves it again: the public page goes offline and new bookings stop. Existing bookings are kept. Everything else saves straight away.
        </div>
      )}
      {isEdit && (
        <nav aria-label="Jump to a section" className="-mt-2 flex gap-2 overflow-x-auto pb-1">
          {JUMPS.map((j) => (
            <button
              key={j.id}
              type="button"
              onClick={() => jumpTo(j.id)}
              className={`shrink-0 whitespace-nowrap border border-host-border ${HOST_TAB}`}
            >
              {j.label}
            </button>
          ))}
        </nav>
      )}
      {/* Basics */}
      <section id="setup-basics" className={panelCls}>
        <SectionHead desc="What it is and where.">Basics</SectionHead>
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
                <option key={k} value={k}>
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
              placeholder="e.g. Main studio"
              className={input}
              required
            />
          </div>
          <div>
            <label htmlFor="he-venue-addr" className={labelCls}>Venue address {OPTIONAL}</label>
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
      <section id="setup-schedule" className={panelCls}>
        <SectionHead desc="When it runs and how many places each time has.">Schedule &amp; sessions</SectionHead>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label htmlFor="he-date" className={labelCls}>Date</label>
            <input
              id="he-date"
              type="date"
              value={raceDate}
              onChange={(e) => setRaceDate(e.target.value)}
              className={`${input}`}
              required
            />
          </div>
          {/* CALENDAR.1 — the calendar entry's length. */}
          <div>
            <label htmlFor="he-duration" className={labelCls}>Duration (minutes)</label>
            <input
              id="he-duration"
              type="number"
              min={5}
              max={1440}
              step={1}
              value={durationMinutes}
              onChange={(e) => setDurationMinutes(e.target.value)}
              placeholder={kind === 'race' ? '120' : '60'}
              className={input}
            />
            <p className={`mt-1.5 ${HOST_HINT}`}>For the "add to calendar" entry. Blank = {kind === 'race' ? '2 hours' : '1 hour'}.</p>
          </div>
        </div>

        {(seriesOptions.length > 0 || seriesId) && (
          <div className="mt-4">
            <label htmlFor="he-series" className={labelCls}>Series {OPTIONAL}</label>
            <select
              id="he-series"
              value={seriesId || ''}
              onChange={(e) => setSeriesId(e.target.value || null)}
              className={`${input} sm:max-w-md`}
            >
              <option value="">Not part of a series</option>
              {seriesOptions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              {seriesId && !seriesOptions.some((s) => s.id === seriesId) && <option value={seriesId}>Current series</option>}
            </select>
            <p className={`mt-1.5 ${HOST_HINT}`}>A series is one link that lists every published date.</p>
          </div>
        )}

        {/* HOSTSERIES.1 — sessions: one row per start time, each with its own
            capacity and optional label. The only row cannot be removed. */}
        <div className="mt-5 space-y-3">
          <span className={labelCls}>Sessions</span>
          {sessions.map((sess, i) => (
            <div key={sess.key} className={`grid grid-cols-1 sm:grid-cols-[1fr_1fr_1.4fr_auto] gap-3 items-end ${HOST_WELL}`}>
              <div>
                <label htmlFor={`he-start-${sess.key}`} className={labelCls}>Start time</label>
                <input
                  id={`he-start-${sess.key}`}
                  type="time"
                  value={sess.start_time}
                  onChange={(e) => updateSession(sess.key, { start_time: e.target.value })}
                  className={`${input}`}
                  required
                />
              </div>
              <div>
                <label htmlFor={`he-cap-${sess.key}`} className={labelCls}>Capacity</label>
                <input
                  id={`he-cap-${sess.key}`}
                  type="number"
                  min={1}
                  step={1}
                  value={sess.capacity}
                  onChange={(e) => updateSession(sess.key, { capacity: e.target.value })}
                  placeholder="e.g. 30"
                  className={input}
                  required
                />
              </div>
              <div>
                <label htmlFor={`he-slabel-${sess.key}`} className={labelCls}>Label {OPTIONAL}</label>
                <input
                  id={`he-slabel-${sess.key}`}
                  type="text"
                  value={sess.label}
                  onChange={(e) => updateSession(sess.key, { label: e.target.value })}
                  placeholder="e.g. Morning session"
                  className={input}
                />
              </div>
              <button
                type="button"
                onClick={() => removeSession(sess.key)}
                disabled={sessions.length <= 1}
                aria-label={`Remove session ${i + 1}`}
                title={sessions.length <= 1 ? 'An event needs at least one session' : 'Remove this session'}
                className={`${HOST_BTN_GHOST} h-11 rounded-lg border border-host-edge px-3`}
              >
                <X size={14} />
              </button>
            </div>
          ))}
          {sessions.length < MAX_SESSIONS && (
            <button
              type="button"
              onClick={addSession}
              className={HOST_BTN}
            >
              + Add a session
            </button>
          )}
          <p className={HOST_HINT}>
            Each session is its own start time with its own places. A session with bookings cannot be removed; changing an existing session&apos;s time on a live event takes it off sale until {brandName} approves it again.
          </p>
        </div>
      </section>

      {/* Tickets & pricing */}
      <section id="setup-tickets" className={panelCls}>
        <SectionHead desc="What a place costs and how big a booking can be.">Tickets &amp; pricing</SectionHead>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="he-price" className={labelCls}>Standard price (EUR)</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-host-hint">€</span>
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
            <p className={`mt-1.5 ${HOST_HINT}`}>Set 0.00 for a free event. Pricing tiers below replace it while they apply.</p>
          </div>
          <div>
            <span className={labelCls}>Allowed team sizes</span>
            <div className="flex flex-wrap gap-2">
              {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => {
                const on = teamSizes.includes(n)
                return (
                  <label
                    key={n}
                    className={`cursor-pointer select-none transition ${
                      on ? HOST_CHOICE_ON : HOST_CHOICE
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
            <p className={`mt-1.5 ${HOST_HINT}`}>Pick every team size a booking may have.</p>
          </div>
        </div>
        {/* TIERS.1 — early bird, capacity tiers and a group price. */}
        <div className="mt-5">
          <span className={labelCls}>Pricing tiers {OPTIONAL}</span>
          <PricingTiersEditor value={pricingTiers} onChange={setPricingTiers} dark />
        </div>
      </section>

      {/* QUESTIONS.1 — asked at signup; answers travel with the attendees. */}
      <section id="setup-questions" className={panelCls}>
        <SectionHead desc="Anything you need to know from the people booking.">Questions at signup</SectionHead>
        <RegistrationQuestionsEditor value={questions} onChange={setQuestions} dark />
      </section>

      {/* Page look */}
      <section id="setup-look" className={panelCls}>
        <SectionHead desc="How the event page looks.">Page look</SectionHead>
        <div>
          <label htmlFor="he-desc" className={labelCls}>Description {OPTIONAL}</label>
          <textarea
            id="he-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
            placeholder="What can attendees expect?"
            className={HOST_TEXTAREA}
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
              <span className={labelCls}>Hero image {OPTIONAL}</span>
              <div className="space-y-3">
                {heroError && (
                  <div className={`${HOST_NOTICE} ${HOST_NOTICE_TONE.bad}`}>
                    {heroError}
                  </div>
                )}
                {heroImageUrl.trim() ? (
                  <div className="relative overflow-hidden rounded-lg border border-host-border bg-host-well">
                    <img src={heroImageUrl} alt="Event hero" className="w-full max-h-56 object-cover" />
                    <button
                      type="button"
                      onClick={handleHeroRemove}
                      disabled={heroBusy}
                      title="Remove hero image"
                      className="absolute top-2 right-2 rounded-full border border-host-edge bg-host-panel p-1.5 text-host-hint hover:text-host-bad disabled:opacity-50"
                    >
                      {heroBusy ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />}
                    </button>
                  </div>
                ) : (
                  <label
                    htmlFor="he-hero-file"
                    className={`flex h-36 cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed border-host-edge bg-host-well text-host-hint transition hover:bg-host-hover hover:text-host-text ${heroBusy ? 'pointer-events-none opacity-50' : ''}`}
                  >
                    {heroBusy ? <Loader2 size={22} className="animate-spin" /> : <ImagePlus size={22} />}
                    <span className="mt-1.5 text-xs">{heroBusy ? 'Uploading…' : 'Upload hero image'}</span>
                    <span className="mt-0.5 text-[11px] text-host-hint">PNG, JPEG or WebP · max 5MB</span>
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
                  <label htmlFor="he-hero" className={labelCls}>Or paste an image URL</label>
                  <input
                    id="he-hero"
                    type="url"
                    value={heroImageUrl}
                    onChange={(e) => setHeroImageUrl(e.target.value)}
                    placeholder="https://…"
                    className={input}
                  />
                </div>
                <p className={HOST_HINT}>
                  Uploads save straight away — press “Save changes” to update your event page.
                </p>
              </div>
            </div>
          ) : (
            <div>
              <label htmlFor="he-hero" className={labelCls}>Hero image URL {OPTIONAL}</label>
              <input
                id="he-hero"
                type="url"
                value={heroImageUrl}
                onChange={(e) => setHeroImageUrl(e.target.value)}
                placeholder="https://…"
                className={input}
              />
              <p className={`mt-1.5 ${HOST_HINT}`}>You can upload an image after saving.</p>
            </div>
          )}
        </div>
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="he-accent" className={labelCls}>Accent colour {OPTIONAL}</label>
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
                className="h-9 w-9 shrink-0 rounded-lg border border-host-edge"
                style={ACCENT_RE.test(accentHex.trim()) ? { backgroundColor: accentHex.trim() } : undefined}
                aria-hidden="true"
              />
            </div>
          </div>
        </div>
      </section>

      {/* Email copy (secondary, collapsed) */}
      <section id="setup-emails" className={panelCls}>
        <h2>
          <button
            type="button"
            onClick={() => setShowEmail((v) => !v)}
            className={`flex items-center gap-2 ${HOST_SECTION}`}
          >
            <span>{showEmail ? '▾' : '▸'}</span>
            Emails (optional)
          </button>
        </h2>
        <p className={HOST_SECTION_DESC}>The confirmation, reminder and rating request, if you want to change the wording.</p>
        {showEmail && (
          <div className="mt-4 space-y-4 border-l border-host-border pl-4">
            <p className={HOST_HINT}>
              Customise the confirmation, reminder and post-event rating emails attendees receive. Leave blank to use {brandName} defaults.
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
                className={HOST_TEXTAREA}
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
                className={HOST_TEXTAREA}
              />
            </div>
            {/* HOSTPAGE.2 — the "How was <event>?" email sent the morning after. */}
            <div>
              <label htmlFor="he-ratsub" className={labelCls}>Rating request subject</label>
              <input
                id="he-ratsub"
                type="text"
                value={ratingSubject}
                onChange={(e) => setRatingSubject(e.target.value)}
                placeholder="Default: How was {{event_name}}?"
                className={input}
              />
            </div>
            <div>
              <label htmlFor="he-ratintro" className={labelCls}>Rating request intro</label>
              <textarea
                id="he-ratintro"
                value={ratingIntro}
                onChange={(e) => setRatingIntro(e.target.value)}
                rows={3}
                className={HOST_TEXTAREA}
              />
            </div>
          </div>
        )}
      </section>

      {/* Errors */}
      {(error || issues.length > 0) && (
        <div className={`${HOST_NOTICE} ${HOST_NOTICE_TONE.bad}`}>
          {error && <p>{error}</p>}
          {issues.length > 0 && (
            <ul className="mt-2 list-disc pl-4 space-y-0.5">
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
      <div className="flex flex-wrap items-center gap-3 pt-2">
        <button
          type="submit"
          disabled={submitting}
          className={HOST_BTN_PRIMARY}
        >
          {submitting
            ? isEdit ? 'Saving…' : 'Creating…'
            : isEdit ? 'Save changes' : 'Create event'}
        </button>
        {isEdit && (status === 'draft' || status === 'rejected') && (
          dirty
            ? <span className="text-sm text-host-hint">Save your changes before submitting.</span>
            : <span className="text-sm"><HostSubmitButton eventId={eventId} /></span>
        )}
        <GuardedLink href={cancelHref} className={HOST_BTN_GHOST}>
          Cancel
        </GuardedLink>
        {saved && (
          <span role="status" className={`text-sm ${offSale ? 'text-host-warn' : 'text-host-ok'}`}>
            {offSale ? `Saved. This event is off sale until ${brandName} approves it again.` : 'Saved.'}
          </span>
        )}
      </div>
      <OffSaleConfirmDialog
        open={confirmReasons !== null}
        reasons={confirmReasons || []}
        brandName={brandName}
        busy={submitting}
        onConfirm={() => { setConfirmReasons(null); performSave() }}
        onKeepEditing={() => setConfirmReasons(null)}
      />
    </form>
  )
}
