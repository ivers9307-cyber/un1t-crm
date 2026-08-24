'use client'

// RaceEventForm — operator create/edit form for a multi-kind event
// (race | workshop | seminar | open_day | masterclass). Used by
// /events/new and /events/[id]/edit.
//
// The component name + filename keep the "Race" prefix because the
// underlying table is still race_events (mig 082) and lots of internal
// code references this component by name. The operator-facing UI says
// "Event"; only the file/component identifier is unchanged. A future
// internal rename can rename the file without changing behaviour.
//
// Kind-aware behaviour (mig 122 added the discriminator):
//   - kind='race' (default, original Hyrox-sim shape):
//       Multiple waves, team sizes, TV display logos, "Race date"
//       terminology. Race-day control panel + race-timing cron run.
//   - kind != 'race' (workshop, seminar, open_day, masterclass):
//       Single time slot (auto-becomes a synthetic wave on submit so
//       the underlying data shape doesn't change), simple capacity
//       input, "Group sizes" label instead of "Team sizes" (data is
//       the same allowed_team_sizes column), no TV logos section,
//       no race-day terminology.
//
// Same Revolut Race payment pipeline + member/non-member pricing
// (mig 084) regardless of kind — that revenue path is preserved
// verbatim across all kinds.

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Calendar, Clock, Users, Save, AlertCircle, Loader2, Plus, Trash2, BadgeEuro, ImagePlus, X as XIcon, Tv, Flag, GraduationCap, Mic, Star, DoorOpen, UserPlus, Image as ImageIcon, Mail, MessageSquare } from 'lucide-react'
import Link from 'next/link'
import { toSlug } from '@/lib/slug'
import { compressImageForUpload, parseUploadResponse } from '@/lib/landing-media-upload'

const ALL_SIZES = [1, 2, 3, 4, 5, 6, 8]

// Kind metadata. Order = picker display order. The tuple
// [icon, label, description, dateLabel, sizeLabel, sizeHint] is
// surfaced through the UI; behaviour-defining flags
// (showWaves, showLogos, hasRaceDayControl) live next to it so
// adding a new kind is a one-tuple change.
const KINDS = [
  {
    value: 'race',
    label: 'Race',
    icon: Flag,
    description: 'Multiple waves, team-first signup, race-day control panel, TV display.',
    sectionLabel: 'Race details',
    dateLabel: 'Race date',
    timeLabel: null, // races use waves, not a single start_time
    sizeLabel: 'Allowed team sizes',
    sizeHint: 'The signup form shows a radio constrained to these sizes. For each size > 1, the form renders N−1 additional name+email pairs. Hyrox formats: 1 (singles), 2 (doubles), 4 (relay).',
    submitLabel: 'Create race',
    showWaves: true,
    showLogos: true,
    defaultStaffRequired: 4,
  },
  {
    value: 'workshop',
    label: 'Workshop',
    icon: GraduationCap,
    description: 'Hands-on, capacity-limited, single time slot. Per-spot name + email capture.',
    sectionLabel: 'Workshop details',
    dateLabel: 'Workshop date',
    timeLabel: 'Start time',
    sizeLabel: 'Available group sizes',
    sizeHint: 'How customers can buy spots: 1 = solo, 2 = bring a friend, larger sizes = group buys. For sizes > 1, the signup form captures name + email for every spot.',
    submitLabel: 'Create workshop',
    showWaves: false,
    showLogos: false,
    defaultStaffRequired: 1,
  },
  {
    value: 'seminar',
    label: 'Seminar',
    icon: Mic,
    description: 'Talk / lecture style, capacity-limited, single time slot.',
    sectionLabel: 'Seminar details',
    dateLabel: 'Seminar date',
    timeLabel: 'Start time',
    sizeLabel: 'Available group sizes',
    sizeHint: 'How customers can buy spots: 1 = solo, 2 = bring a friend, larger sizes = group buys. For sizes > 1, the signup form captures name + email for every spot.',
    submitLabel: 'Create seminar',
    showWaves: false,
    showLogos: false,
    defaultStaffRequired: 1,
  },
  {
    value: 'open_day',
    label: 'Open day',
    icon: DoorOpen,
    description: 'Often free or token price, larger capacity, single time slot.',
    sectionLabel: 'Open day details',
    dateLabel: 'Open day date',
    timeLabel: 'Start time',
    sizeLabel: 'Available group sizes',
    sizeHint: 'How customers can buy spots: 1 = solo, 2 = bring a friend, larger sizes = group buys. For sizes > 1, the signup form captures name + email for every spot.',
    submitLabel: 'Create open day',
    showWaves: false,
    showLogos: false,
    defaultStaffRequired: 2,
  },
  {
    value: 'masterclass',
    label: 'Masterclass',
    icon: Star,
    description: 'Premium one-off with a guest coach. Capacity-limited, single time slot.',
    sectionLabel: 'Masterclass details',
    dateLabel: 'Masterclass date',
    timeLabel: 'Start time',
    sizeLabel: 'Available group sizes',
    sizeHint: 'How customers can buy spots: 1 = solo, 2 = bring a friend, larger sizes = group buys. For sizes > 1, the signup form captures name + email for every spot.',
    submitLabel: 'Create masterclass',
    showWaves: false,
    showLogos: false,
    defaultStaffRequired: 1,
  },
  {
    value: 'lead_gen',
    label: 'Lead Gen',
    icon: UserPlus,
    description: 'Signup form to capture name, email & phone. No date or time — drops contacts straight into the sales funnel.',
    sectionLabel: 'Lead gen form details',
    dateLabel: null,
    timeLabel: null,
    sizeLabel: null,
    sizeHint: null,
    submitLabel: 'Create form',
    showWaves: false,
    showLogos: false,
    defaultStaffRequired: 0,
    // Lead Gen is a pure data-capture form: no date/time/waves/team
    // sizes/pricing. These flags collapse the form down to the
    // essentials and tell the submit handler to skip date + wave
    // synthesis entirely.
    isLeadGen: true,
  },
]

const kindMeta = (k) => KINDS.find((x) => x.value === k) || KINDS[0]

export default function RaceEventForm({ race, locationId }) {
  const router = useRouter()
  const isEditing = !!race

  const [kind, setKind] = useState(race?.kind || 'race')
  const meta = kindMeta(kind)

  // Mig 125: staff_required for the studio overview demand classifier.
  // Initial value: existing race's value, or the kind's default for new
  // events. When the operator switches kind on a new event, the default
  // for the new kind is loaded UNLESS they've already manually edited
  // the field (`staffRequiredTouched`) — that respects intent.
  const [staffRequired, setStaffRequired] = useState(
    race?.staff_required != null ? String(race.staff_required) : String(kindMeta(race?.kind || 'race').defaultStaffRequired ?? 1)
  )
  const [staffRequiredTouched, setStaffRequiredTouched] = useState(isEditing)

  // EVENTS-CAPACITY-MODE.1 — cap by 'teams' or 'people'. New events default
  // by kind (race -> teams, others -> people); existing events keep their
  // stored mode. Switching kind on a NEW event re-applies the kind default
  // until the operator picks one explicitly.
  const [capacityMode, setCapacityMode] = useState(
    race?.capacity_mode || ((race?.kind || 'race') === 'race' ? 'teams' : 'people')
  )
  const [capacityModeTouched, setCapacityModeTouched] = useState(isEditing)

  function handleKindChange(newKind) {
    setKind(newKind)
    if (!staffRequiredTouched) {
      const def = kindMeta(newKind).defaultStaffRequired ?? 1
      setStaffRequired(String(def))
    }
    if (!capacityModeTouched) {
      setCapacityMode(newKind === 'race' ? 'teams' : 'people')
    }
  }

  const [name, setName] = useState(race?.name || '')
  const [slug, setSlug] = useState(race?.slug || '')
  const [slugAuto, setSlugAuto] = useState(!isEditing)
  const [description, setDescription] = useState(race?.description || '')
  const [raceDate, setRaceDate] = useState(race?.race_date || '')

  // Single-slot start time + capacity for non-race kinds. On submit
  // we turn these into a single synthetic wave so the underlying
  // data shape (waves[], race_registrations.wave_id) stays uniform
  // across kinds. For races, these stay null and the waves array is
  // operator-managed.
  const initialSingleWave = race && race.kind && race.kind !== 'race' && Array.isArray(race.waves) && race.waves[0]
    ? race.waves[0]
    : null
  const [singleStartTime, setSingleStartTime] = useState(
    initialSingleWave?.start_time ? initialSingleWave.start_time.slice(0, 5) : ''
  )
  const [singleCapacity, setSingleCapacity] = useState(
    initialSingleWave?.capacity != null ? String(initialSingleWave.capacity) : ''
  )

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
  // Waves (mig 083) — only managed via UI for kind='race'. For other
  // kinds we synthesise [{ start_time: singleStartTime, capacity:
  // singleCapacity, label: null }] on submit.
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
  // shows whole-euro inputs and converts on submit. Same pricing path
  // for all kinds.
  const [memberPricingEnabled, setMemberPricingEnabled] = useState(!!race?.member_pricing_enabled)
  const [membersOnly, setMembersOnly] = useState(!!race?.members_only)
  // EVENTS-LOC.2: shared = event appears in every location's list.
  const [shared, setShared] = useState(!!race?.shared)
  const [memberFee, setMemberFee] = useState(
    race?.member_fee_cents != null ? String(race.member_fee_cents / 100) : ''
  )
  const [nonMemberFee, setNonMemberFee] = useState(
    race?.non_member_fee_cents != null ? String(race.non_member_fee_cents / 100) : ''
  )
  // Mig 092: TV-display logos. race-only.
  const [logos, setLogos] = useState(() => {
    const incoming = Array.isArray(race?.tv_logos) ? race.tv_logos : []
    return [incoming[0] || null, incoming[1] || null, incoming[2] || null]
  })
  const [logoBusy, setLogoBusy] = useState(null) // slot index currently uploading
  const [logoError, setLogoError] = useState(null)
  // Public-page hero image + accent colour. Shown for every kind (every
  // public event page has a hero). hero_image_url is set after the
  // /hero upload route returns the bytes URL; accent_hex is an optional,
  // clearable 6-digit hex persisted via the main save payload.
  const [heroUrl, setHeroUrl] = useState(race?.hero_image_url || null)
  const [heroBusy, setHeroBusy] = useState(false)
  const [heroError, setHeroError] = useState(null)
  const [accentHex, setAccentHex] = useState(race?.accent_hex || '')
  // EVENTS-EMAILCFG.1 (mig 385) — per-event styling of the two LIVE
  // transactional emails this event sends: the signup CONFIRMATION and the
  // pre-event REMINDER. For each: an optional subject + intro/body drop into
  // the shared branded shell (which the accent colour + hero image above
  // already tint); an optional "full template" pointer overrides that shell
  // with a saved email_templates row's HTML. Blank everywhere = today's
  // default copy/look (behaviour-preserving). Hydrated from the race on edit;
  // '' means "use default" and is sent to the API as null.
  const [confirmationSubject, setConfirmationSubject] = useState(race?.confirmation_email_subject || '')
  const [confirmationIntro, setConfirmationIntro] = useState(race?.confirmation_email_intro || '')
  const [confirmationTemplateId, setConfirmationTemplateId] = useState(race?.confirmation_email_template_id || '')
  // EVENTS-SMS-TOGGLE (mig 552) — per-event opt-in for the registration SMS
  // confirmation. Off by default for new events; existing events reflect the DB.
  const [confirmationSmsEnabled, setConfirmationSmsEnabled] = useState(!!race?.confirmation_sms_enabled)
  const [reminderSubject, setReminderSubject] = useState(race?.reminder_email_subject || '')
  const [reminderIntro, setReminderIntro] = useState(race?.reminder_email_intro || '')
  const [reminderTemplateId, setReminderTemplateId] = useState(race?.reminder_email_template_id || '')
  // The location's saved email templates, for the "Advanced: use a full
  // template" pickers. Fetched from the shared templates list endpoint,
  // scoped to this event's location. A fetch failure just leaves the list
  // empty (operator keeps the branded-default option).
  const [emailTemplates, setEmailTemplates] = useState([])
  useEffect(() => {
    if (!locationId) return
    let cancelled = false
    fetch(`/api/templates?location_id=${encodeURIComponent(locationId)}`)
      .then((r) => r.json())
      .then((j) => {
        if (!cancelled && j?.success && Array.isArray(j.templates)) setEmailTemplates(j.templates)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [locationId])
  // GLOFOX3.3 (mig 145). When on, every confirmed public registration
  // on this event pushes the registrant + every team_member with a
  // contact to Glofox: search-by-email first (link if found),
  // otherwise create + attach the per-location trial membership + tag
  // for the welcome sequence. Default off — operator opts in per
  // event.
  const [createInGlofox, setCreateInGlofox] = useState(!!race?.create_in_glofox)
  // EVENTS-HOST.4 — payout routing. '' = internal UN1T event (settled via
  // Revolut, the default); a host id = pay that third-party host directly
  // via Stripe Connect. Hosts are org-scoped and fetched on mount; a fetch
  // failure just leaves the list empty (operator keeps the UN1T default).
  const [hostId, setHostId] = useState(race?.host_id || '')
  const [hosts, setHosts] = useState([])
  useEffect(() => {
    let cancelled = false
    fetch('/api/hosts')
      .then((r) => r.json())
      .then((j) => {
        if (!cancelled && j?.success && Array.isArray(j.data)) setHosts(j.data)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])
  // EVENTS-HOST.4 — only third-party (stripe_connect) hosts are selectable
  // payees; a Revolut/UN1T host is the implicit default (host_id '').
  const stripeHosts = hosts.filter((h) => h.payment_provider === 'stripe_connect')
  const selectedHost = stripeHosts.find((h) => h.id === hostId) || null
  // EVENT-COMMS-LOC (mig 553) — for host events, which real UN1T location's
  // Twilio sender + email identity this event's confirmation/reminder texts
  // and emails use. Host events sit on a sender-less per-host anchor
  // location, so this override is only surfaced when hostId is set. Options
  // are the org's real (non-anchor) locations, fetched per event location —
  // mirrors the emailTemplates fetch above. A fetch failure just leaves the
  // list empty (operator keeps whatever was already saved).
  const [sendingLocationId, setSendingLocationId] = useState(race?.sending_location_id || '')
  const [locationOptions, setLocationOptions] = useState([]) // {id,name,is_master}
  useEffect(() => {
    if (!locationId) return
    let cancelled = false
    fetch(`/api/locations/sendable?event_location_id=${encodeURIComponent(locationId)}`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return
        const opts = Array.isArray(j?.data) ? j.data : []
        setLocationOptions(opts)
        // Only HOST events carry a sending-location override; a normal event
        // must keep NULL so its comms resolve to its own location_id (spec
        // non-goal). Default the picker to the org master for host events only.
        if (hostId && !sendingLocationId) {
          const master = opts.find((o) => o.is_master)
          if (master) setSendingLocationId(master.id)
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [locationId, hostId]) // eslint-disable-line react-hooks/exhaustive-deps
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  function onNameChange(v) {
    setName(v)
    if (slugAuto) setSlug(toSlug(v))
  }

  // Mig 092: upload a single TV logo into the slot. Race-only — gated
  // at the section render level.
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
      // Safe parse — a >4.5MB file is rejected by the platform with a
      // plain-text 413, which a bare r.json() turns into a parse crash.
      const out = await parseUploadResponse(r)
      if (!out.success) {
        setLogoError(out.error)
        return
      }
      const next = [...logos]
      next[slot] = out.url
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
      await fetch(`/api/events/${race.id}/logo?slot=${slot}`, { method: 'DELETE' })
      const next = [...logos]
      next[slot] = null
      setLogos(next)
    } finally {
      setLogoBusy(null)
    }
  }

  // Upload the single public-page hero image. Like logos, gated on a
  // saved event because the upload route namespaces storage by id.
  async function handleHeroUpload(file) {
    if (!race?.id) {
      setHeroError('Save the event first, then add a hero image.')
      return
    }
    setHeroError(null)
    setHeroBusy(true)
    try {
      // Downscale in the browser first — a photo straight off a phone is
      // often over Vercel's ~4.5MB body cap, which rejects with a
      // plain-text 413 before the route (and its 5MB check) ever runs.
      const toSend = await compressImageForUpload(file)
      const fd = new FormData()
      fd.append('file', toSend, toSend.name || file.name || 'hero')
      const r = await fetch(`/api/events/${race.id}/hero`, { method: 'POST', body: fd })
      const out = await parseUploadResponse(r)
      if (!out.success) {
        setHeroError(out.error)
        return
      }
      setHeroUrl(out.url)
    } catch (e) {
      setHeroError(e.message || 'Network error')
    } finally {
      setHeroBusy(false)
    }
  }

  async function handleHeroRemove() {
    if (!race?.id) return
    setHeroError(null)
    setHeroBusy(true)
    try {
      await fetch(`/api/events/${race.id}/hero`, { method: 'DELETE' })
      setHeroUrl(null)
    } finally {
      setHeroBusy(false)
    }
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)

    if (!name.trim()) { setError('Name is required.'); return }
    if (!meta.isLeadGen && !raceDate) { setError(`${meta.dateLabel} is required.`); return }
    if (!meta.isLeadGen && allowedTeamSizes.length === 0) { setError(`Pick at least one ${meta.value === 'race' ? 'team' : 'group'} size.`); return }

    // Wave-shape validation depends on kind. Race uses the full waves
    // UI; non-race kinds use the single start_time + capacity inputs
    // and we synthesise a wave from them.
    let outboundWaves
    if (meta.isLeadGen) {
      outboundWaves = []
    } else if (meta.showWaves) {
      if (waves.length === 0) { setError('Add at least one wave.'); return }
      const seenTimes = new Set()
      for (const w of waves) {
        if (!w.start_time) { setError('Every wave needs a start time.'); return }
        if (seenTimes.has(w.start_time)) {
          setError(`Two waves can't share the same start time (${w.start_time}).`)
          return
        }
        seenTimes.add(w.start_time)
      }
      outboundWaves = waves.slice().sort((a, b) => a.start_time.localeCompare(b.start_time))
    } else {
      if (!singleStartTime) { setError('Start time is required.'); return }
      const cap = singleCapacity.trim() === '' ? null : Number(singleCapacity)
      if (cap != null && (!Number.isFinite(cap) || cap < 1)) {
        setError('Capacity must be a positive whole number (or empty for unlimited).')
        return
      }
      outboundWaves = [{
        // Preserve existing wave id on edit so the diff-and-apply on
        // the server hits update vs insert (and we don't orphan
        // registrations whose wave_id pointed at it).
        ...(initialSingleWave?.id ? { id: initialSingleWave.id } : {}),
        start_time: singleStartTime,
        capacity: cap != null ? String(cap) : '',
        label: '',
      }]
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

    // Mig 125 validation: staff_required must be 0-50 integer.
    const staffReqNum = Number(staffRequired)
    if (!Number.isFinite(staffReqNum) || !Number.isInteger(staffReqNum) || staffReqNum < 0 || staffReqNum > 50) {
      setError('Staff required must be a whole number between 0 and 50.')
      return
    }

    // Accent colour is optional; if set it must be a 6-digit hex.
    const accentTrimmed = accentHex.trim()
    if (accentTrimmed && !/^#[0-9a-fA-F]{6}$/.test(accentTrimmed)) {
      setError('Accent colour must be a 6-digit hex like #1A2B3C (or leave it blank).')
      return
    }

    setSaving(true)
    const payload = {
      ...(isEditing ? {} : { location_id: locationId, kind }),
      name: name.trim(),
      staff_required: staffReqNum,
      ...(isEditing ? {} : { slug: slug.trim() || undefined }),
      description: description.trim() || null,
      ...(meta.isLeadGen ? {} : { race_date: raceDate }),
      registration_opens_at: registrationOpensAt ? new Date(registrationOpensAt).toISOString() : null,
      registration_closes_at: registrationClosesAt ? new Date(registrationClosesAt).toISOString() : null,
      allowed_team_sizes: meta.isLeadGen ? [1] : allowedTeamSizes,
      capacity_mode: capacityMode,
      active,
      member_pricing_enabled: memberPricingEnabled,
      members_only: membersOnly,
      shared,
      // EVENTS-HOST.4 — payout routing. '' → null = internal UN1T (Revolut).
      host_id: hostId || null,
      // EVENT-COMMS-LOC (mig 553) — '' → null = resolved at send time
      // (host event → org master location; normal event → its own location).
      // EVENT-COMMS-LOC — host events only; a normal event keeps NULL so its
      // comms resolve to its own location_id (never stamped with the master).
      sending_location_id: hostId ? (sendingLocationId || null) : null,
      member_fee_cents: memberPricingEnabled ? memberFeeCents : null,
      non_member_fee_cents: nonMemberFeeCents,
      // TV logos: race-only. For non-race kinds we send an empty
      // array so any historical slots (shouldn't exist, since the
      // upload UI is gated) get cleared.
      tv_logos: meta.showLogos
        ? logos.filter((u) => typeof u === 'string' && u.length > 0).slice(0, 3)
        : [],
      // Public-page hero + accent — shown for every kind. hero bytes
      // are already uploaded via /hero; here we persist the URL + colour.
      hero_image_url: heroUrl || null,
      accent_hex: accentTrimmed || null,
      // GLOFOX3.3 — explicit boolean so toggling off persists.
      create_in_glofox: createInGlofox === true,
      // EVENTS-EMAILCFG.1 (mig 385) — per-event email styling. Empty string
      // → null = today's default copy/look; a template_id → the full-template
      // override, '' → null = the branded shell. Always sent so clearing a
      // field persists back to the default.
      confirmation_email_subject: confirmationSubject.trim() || null,
      confirmation_email_intro: confirmationIntro.trim() || null,
      confirmation_email_template_id: confirmationTemplateId || null,
      // EVENTS-SMS-TOGGLE (mig 552) — always sent so toggling it off persists.
      confirmation_sms_enabled: confirmationSmsEnabled,
      reminder_email_subject: reminderSubject.trim() || null,
      reminder_email_intro: reminderIntro.trim() || null,
      reminder_email_template_id: reminderTemplateId || null,
      ...(meta.isLeadGen ? {} : {
        waves: outboundWaves.map((w, i) => ({
          ...(w.id ? { id: w.id } : {}),
          start_time: w.start_time,
          capacity: w.capacity ? Number(w.capacity) : null,
          label: w.label && w.label.trim ? (w.label.trim() || null) : (w.label || null),
          display_order: i,
        })),
      }),
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
      <Link href="/events" className="inline-flex items-center gap-1.5 text-sm text-un1t-subtle hover:text-un1t-text">
        <ArrowLeft size={16} /> Back to Events
      </Link>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-sm rounded-lg p-3 inline-flex items-start gap-2">
          <AlertCircle size={14} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}

      {/* Kind picker. Interactive on create; locked on edit because
          changing kind on a saved event would orphan its data
          (race waves on a workshop, etc.). The lock-on-edit message
          tells the operator how to do it intentionally if needed. */}
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5 space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">Event type</h3>
        {isEditing && (
          <p className="text-[11px] text-un1t-muted -mt-2">
            Locked after creation — changing the type would orphan registrations and waves. Create a new event if you need a different type.
          </p>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {KINDS.map((k) => {
            const Icon = k.icon
            const on = kind === k.value
            return (
              <button
                key={k.value}
                type="button"
                disabled={isEditing && !on}
                onClick={() => handleKindChange(k.value)}
                className={`text-left p-3 rounded-md border transition-colors ${
                  on
                    ? 'bg-emerald-500/15 border-emerald-500/40 text-un1t-text'
                    : 'bg-un1t-bg border-un1t-border text-un1t-subtle hover:border-un1t-muted disabled:opacity-30 disabled:hover:border-un1t-border disabled:cursor-not-allowed'
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <Icon size={14} />
                  <span className="text-sm font-medium">{k.label}</span>
                </div>
                <div className="text-[11px] text-un1t-subtle leading-snug">{k.description}</div>
              </button>
            )
          })}
        </div>
      </div>

      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5 space-y-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">{meta.sectionLabel}</h3>

        <div>
          <label className="block text-sm text-un1t-subtle mb-1">Name *</label>
          <input
            type="text"
            required
            value={name}
            onChange={e => onNameChange(e.target.value)}
            placeholder={meta.value === 'race' ? 'Hyrox race sim — May 2026' : meta.value === 'workshop' ? 'Mobility workshop — May 2026' : meta.value === 'seminar' ? 'Nutrition seminar — May 2026' : meta.value === 'masterclass' ? 'Olympic-lift masterclass — May 2026' : 'Open day — May 2026'}
            className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
          />
        </div>

        <div>
          <label className="block text-sm text-un1t-subtle mb-1">
            Slug
            {slugAuto && <span className="ml-1 text-[10px] text-un1t-muted">(auto-derived)</span>}
          </label>
          <input
            type="text"
            value={slug}
            onChange={e => { setSlug(e.target.value.toLowerCase()); setSlugAuto(false) }}
            disabled={isEditing}
            pattern="^[a-z0-9]+(-[a-z0-9]+)*$"
            placeholder="hyrox-may-2026"
            className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text font-mono disabled:opacity-50"
          />
          <p className="text-[11px] text-un1t-muted mt-1">
            Public signup page is at <span className="font-mono">/event/{slug || 'your-slug'}</span>.
            {isEditing && ' Slug cannot be changed after creation (would break shared links).'}
          </p>
          {/* QR-code download is operator-only and only renders for
              saved events (it needs an id to look up). Right-aligned
              under the slug field so it sits visually with the
              public-URL line. */}
          {isEditing && race?.id && (
            <a
              href={`/api/events/${race.id}/qr-code`}
              download
              className="mt-2 inline-flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300"
              title="Download a printable QR code that links to the public signup page"
            >
              <ImagePlus size={12} /> Download QR code (PNG)
            </a>
          )}
        </div>

        <div>
          <label className="block text-sm text-un1t-subtle mb-1">Description</label>
          <textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            rows={3}
            placeholder={meta.value === 'race' ? 'Tell teams what to expect…' : 'Tell attendees what to expect — agenda, materials, who it\'s for…'}
            className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
          />
        </div>
      </div>

      {!meta.isLeadGen && (
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5 space-y-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle flex items-center gap-2">
          <Calendar size={14} /> {meta.dateLabel}
        </h3>
        <div>
          <input
            type="date"
            required
            value={raceDate}
            onChange={e => setRaceDate(e.target.value)}
            className="w-56 bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
          />
        </div>

        {/* Non-race kinds: single start_time + capacity input,
            replacing the waves UI block below. */}
        {!meta.showWaves && (
          <div className="grid grid-cols-2 gap-3 pt-2 border-t border-un1t-border">
            <div>
              <label className="block text-sm text-un1t-subtle mb-1">{meta.timeLabel} *</label>
              <input
                type="time"
                required
                value={singleStartTime}
                onChange={e => setSingleStartTime(e.target.value)}
                className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
              />
            </div>
            <div>
              <label className="block text-sm text-un1t-subtle mb-1">Capacity</label>
              <input
                type="number"
                min={1}
                placeholder="Unlimited"
                value={singleCapacity}
                onChange={e => setSingleCapacity(e.target.value)}
                className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
              />
              <p className="text-[11px] text-un1t-muted mt-1">Total spots. Empty = unlimited.</p>
            </div>
          </div>
        )}
      </div>
      )}

      {/* Waves — race only. Non-race kinds use the single
          start_time + capacity inputs above. */}
      {meta.showWaves && (
        <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle flex items-center gap-2">
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
          <p className="text-[11px] text-un1t-subtle -mt-2">
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
                  className="bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
                />
                <input
                  type="number"
                  min={1}
                  placeholder="Unlimited"
                  value={w.capacity}
                  onChange={e => setWaves(prev => prev.map((x, j) => j === i ? { ...x, capacity: e.target.value } : x))}
                  className="bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
                  title="Max teams in this wave (empty = unlimited)"
                />
                <input
                  type="text"
                  placeholder="Label (optional, e.g. Morning)"
                  value={w.label}
                  onChange={e => setWaves(prev => prev.map((x, j) => j === i ? { ...x, label: e.target.value } : x))}
                  className="bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
                />
                <button
                  type="button"
                  onClick={() => setWaves(prev => prev.length > 1 ? prev.filter((_, j) => j !== i) : prev)}
                  disabled={waves.length === 1}
                  className="text-un1t-subtle hover:text-red-700 disabled:opacity-30 p-1"
                  title={waves.length === 1 ? 'A race must have at least one wave' : 'Remove this wave'}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5 space-y-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle flex items-center gap-2">
          <Clock size={14} /> Registration window
        </h3>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm text-un1t-subtle mb-1">Opens</label>
            <input
              type="datetime-local"
              value={registrationOpensAt}
              onChange={e => setRegistrationOpensAt(e.target.value)}
              className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
            />
            <p className="text-[11px] text-un1t-muted mt-1">Empty = open from now.</p>
          </div>
          <div>
            <label className="block text-sm text-un1t-subtle mb-1">Closes</label>
            <input
              type="datetime-local"
              value={registrationClosesAt}
              onChange={e => setRegistrationClosesAt(e.target.value)}
              className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
            />
            <p className="text-[11px] text-un1t-muted mt-1">Empty = open until {meta.value === 'race' ? 'race date' : 'event date'}.</p>
          </div>
        </div>
      </div>

      {/* Mig 125: staffing requirement for the studio overview demand
          classifier on /schedule. Pre-fills from the kind's default
          when the operator hasn't manually edited it. Hidden for
          lead_gen — a data-capture form isn't a staffed occurrence. */}
      {!meta.isLeadGen && (
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5 space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle flex items-center gap-2">
          <Users size={14} /> Staffing
        </h3>
        <div>
          <label className="block text-sm text-un1t-subtle mb-1">Staff required *</label>
          <input
            type="number"
            min={0}
            max={50}
            step={1}
            required
            value={staffRequired}
            onChange={e => { setStaffRequired(e.target.value); setStaffRequiredTouched(true) }}
            className="w-32 bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text tabular-nums"
          />
          <p className="text-[11px] text-un1t-muted mt-1">
            How many staff are needed to run this {meta.label.toLowerCase()}.
            Used by the studio overview on <code>/schedule</code> to flag undermanned days.
            Default for {meta.label.toLowerCase()}: {meta.defaultStaffRequired}.
            {' '}Set <strong>0</strong> if covered by another role already on shift.
          </p>
        </div>
      </div>
      )}

      {!meta.isLeadGen && (
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5 space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle flex items-center gap-2">
          <Users size={14} /> {meta.sizeLabel}
        </h3>
        <p className="text-[11px] text-un1t-subtle">
          {meta.sizeHint}
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
                    : 'bg-un1t-bg border-un1t-border text-un1t-subtle hover:border-un1t-muted'
                }`}
              >
                {s}-{s === 1
                  ? (meta.value === 'race' ? 'person' : 'spot')
                  : (meta.value === 'race' ? 'people' : 'spots')}
              </button>
            )
          })}
        </div>
      </div>
      )}

      {!meta.isLeadGen && (
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5 space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle flex items-center gap-2">
          <Users size={14} /> Capacity counts
        </h3>
        <p className="text-[11px] text-un1t-subtle">
          {meta.value === 'race'
            ? 'Whether each wave’s capacity limits the number of teams or the total number of people across all teams.'
            : 'Whether the capacity limits the number of signups or the total number of people (a group can bring several).'}
        </p>
        <div className="inline-flex rounded-md border border-un1t-border overflow-hidden">
          {[
            { value: 'teams', label: meta.value === 'race' ? 'Teams' : 'Signups' },
            { value: 'people', label: 'People' },
          ].map(opt => {
            const on = capacityMode === opt.value
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => { setCapacityMode(opt.value); setCapacityModeTouched(true) }}
                className={`text-xs px-4 py-1.5 ${
                  on
                    ? 'bg-emerald-500/15 text-emerald-700 font-medium'
                    : 'bg-un1t-bg text-un1t-subtle hover:text-un1t-text'
                }`}
              >
                {opt.label}
              </button>
            )
          })}
        </div>
        <p className="text-[11px] text-un1t-muted">
          {capacityMode === 'people'
            ? 'A capacity of 40 means 40 people — a group only fits if the whole group fits.'
            : `A capacity of 40 means 40 ${meta.value === 'race' ? 'teams' : 'signups'}, regardless of group size.`}
        </p>
      </div>
      )}

      {!meta.isLeadGen && (
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5 space-y-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle flex items-center gap-2">
          <BadgeEuro size={14} /> Pricing
        </h3>
        <p className="text-[11px] text-un1t-subtle -mt-2">
          Per-person pricing. Mixed groups pay each head at their own rate (e.g. 2 members + 2
          non-members on a 4-{meta.value === 'race' ? 'person team' : 'spot group'} = 2 × member fee + 2 × non-member fee). Leave a fee blank
          to make that category free. UN1T members are matched by the email on their member account.
        </p>

        {/* EVENTS-HOST.4 — payout routing: who gets paid for this event */}
        <div className="pb-1">
          <label className="block text-sm text-un1t-subtle mb-1">Who gets paid</label>
          {stripeHosts.length === 0 ? (
            <p className="text-[11px] text-un1t-muted">
              UN1T (settles via Revolut). Add a third-party host in{' '}
              <Link href="/settings/hosts" className="text-un1t-text underline">Settings → Event hosts</Link>{' '}
              to pay someone else directly.
            </p>
          ) : (
            <>
              <select
                value={hostId}
                onChange={(e) => setHostId(e.target.value)}
                className="w-full max-w-md bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
              >
                <option value="">UN1T (settles via Revolut)</option>
                {stripeHosts.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}{h.charges_enabled ? '' : ' — Stripe not connected'}
                  </option>
                ))}
              </select>
              {selectedHost ? (
                <p className="text-[11px] text-un1t-muted mt-1">
                  Tickets settle to {selectedHost.name}&apos;s own Stripe account, with UN1T&apos;s €{(((selectedHost.platform_fee_cents ?? 0)) / 100).toFixed(2)} booking fee added per ticket.
                </p>
              ) : (
                <p className="text-[11px] text-un1t-muted mt-1">
                  UN1T event — ticket money settles to UN1T via Revolut.
                </p>
              )}
              {selectedHost && !selectedHost.charges_enabled && (
                <p className="mt-1 text-[11px] text-amber-700">
                  {selectedHost.name} hasn&apos;t finished connecting Stripe — this event can&apos;t take paid registrations until they do.{' '}
                  <Link href={`/settings/hosts/${selectedHost.id}`} className="underline">Finish setup</Link>.
                </p>
              )}
            </>
          )}
        </div>

        <div>
          <label className="block text-sm text-un1t-subtle mb-1">Non-member fee (€ per person)</label>
          <input
            type="number"
            min={0}
            step="0.01"
            value={nonMemberFee}
            onChange={e => setNonMemberFee(e.target.value)}
            placeholder="Free"
            className="w-40 bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
          />
          <p className="text-[11px] text-un1t-muted mt-1">
            Charged per non-member entrant. Leave empty for a free {meta.value === 'race' ? 'race' : 'event'}.
          </p>
        </div>

        <div className="flex items-center justify-between gap-3 pt-2 border-t border-un1t-border">
          <div>
            <div className="text-sm text-un1t-text">Different pricing for UN1T members</div>
            <div className="text-[11px] text-un1t-subtle">When on, the signup form validates member emails and applies the member rate per verified head.</div>
          </div>
          <button
            type="button"
            onClick={() => setMemberPricingEnabled(v => !v)}
            className={`shrink-0 w-10 h-5 rounded-full ${memberPricingEnabled ? 'bg-emerald-500' : 'bg-un1t-border'}`}
          >
            <div className={`w-4 h-4 rounded-full bg-white transition-transform ${memberPricingEnabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
        </div>

        {memberPricingEnabled && (
          <div className="pl-2">
            <label className="block text-sm text-un1t-subtle mb-1">Member fee (€ per person)</label>
            <input
              type="number"
              min={0}
              step="0.01"
              value={memberFee}
              onChange={e => setMemberFee(e.target.value)}
              placeholder="Free for members"
              className="w-40 bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
            />
            <p className="text-[11px] text-un1t-muted mt-1">
              Empty = members enter free. Members are matched against contacts with active membership at the {meta.value === 'race' ? 'race\'s' : 'event\'s'} location.
            </p>
          </div>
        )}

        <div className="flex items-center justify-between gap-3 pt-2 border-t border-un1t-border">
          <div>
            <div className="text-sm text-un1t-text">Members only</div>
            <div className="text-[11px] text-un1t-subtle">Refuse signups containing any unverified members. Independent of pricing — a free members-only {meta.value === 'race' ? 'race' : 'event'} is valid.</div>
          </div>
          <button
            type="button"
            onClick={() => setMembersOnly(v => !v)}
            className={`shrink-0 w-10 h-5 rounded-full ${membersOnly ? 'bg-amber-500' : 'bg-un1t-border'}`}
          >
            <div className={`w-4 h-4 rounded-full bg-white transition-transform ${membersOnly ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
        </div>

        <div className="flex items-center justify-between gap-3 pt-2 border-t border-un1t-border">
          <div>
            <div className="text-sm text-un1t-text">Shared across all locations</div>
            <div className="text-[11px] text-un1t-subtle">Show this {meta.value === 'race' ? 'race' : 'event'} in every studio&apos;s events list, not just its own location.</div>
          </div>
          <button
            type="button"
            onClick={() => setShared(v => !v)}
            className={`shrink-0 w-10 h-5 rounded-full ${shared ? 'bg-indigo-500' : 'bg-un1t-border'}`}
          >
            <div className={`w-4 h-4 rounded-full bg-white transition-transform ${shared ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
        </div>
      </div>
      )}

      {/* TV-display logos. Race-only — non-race kinds don't have a
          TV display board. Within race, only shown after the event
          exists because the upload route needs an id to namespace
          the storage path. */}
      {meta.showLogos && (
        <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5 space-y-4">
          <div className="flex items-start gap-3">
            <Tv size={18} className="text-un1t-subtle mt-0.5 shrink-0" />
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">TV display logos</h3>
              <p className="text-[11px] text-un1t-subtle mt-1">
                Up to 3 logos rendered centred in the header of <code>/event/&lt;slug&gt;/display</code>. Use the same height across logos for the cleanest look. PNG/JPEG/WebP/SVG, max 2MB each.
              </p>
            </div>
          </div>

          {!isEditing ? (
            <div className="bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-[11px] text-un1t-subtle">
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
              <p className="text-[11px] text-un1t-muted">
                Logo bytes save immediately. The slot order doesn&apos;t persist until you click <strong>Save Changes</strong> below.
              </p>
            </>
          )}
        </div>
      )}

      {/* Public-page hero image + accent colour. Shown for every kind —
          every public event page has a hero. The upload UX mirrors the
          TV-logo slot but as a single hero: it needs a saved event
          first (the /hero route namespaces storage by id), whereas the
          accent colour persists via the main save payload and so is
          always editable. */}
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5 space-y-4">
        <div className="flex items-start gap-3">
          <ImageIcon size={18} className="text-un1t-subtle mt-0.5 shrink-0" />
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">Hero image</h3>
            <p className="text-[11px] text-un1t-subtle mt-1">
              A wide banner shown at the top of the public {meta.value === 'race' ? 'race' : 'event'} page. PNG/JPEG/WebP, max 5MB.
            </p>
          </div>
        </div>

        {!isEditing ? (
          <div className="bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-[11px] text-un1t-subtle">
            Save the {meta.value === 'race' ? 'race' : 'event'} first — you&apos;ll be able to add a hero image after it&apos;s created.
          </div>
        ) : (
          <>
            {heroError && (
              <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-xs rounded-md px-3 py-2">
                {heroError}
              </div>
            )}
            {heroUrl ? (
              <div className="relative bg-un1t-bg border border-un1t-border rounded-md overflow-hidden">
                { }
                <img src={heroUrl} alt="Event hero" className="w-full max-h-56 object-cover" />
                <button
                  type="button"
                  onClick={handleHeroRemove}
                  disabled={heroBusy}
                  className="absolute top-2 right-2 bg-un1t-surface/90 border border-un1t-border rounded-full p-1 text-un1t-subtle hover:text-red-500 disabled:opacity-50"
                  title="Remove hero image"
                >
                  {heroBusy ? <Loader2 size={14} className="animate-spin" /> : <XIcon size={14} />}
                </button>
              </div>
            ) : (
              <label
                htmlFor="event-hero-input"
                className={`bg-un1t-bg border-2 border-dashed border-un1t-border hover:border-un1t-muted rounded-md h-40 flex flex-col items-center justify-center text-un1t-subtle cursor-pointer ${heroBusy ? 'opacity-50 pointer-events-none' : ''}`}
              >
                {heroBusy ? <Loader2 size={24} className="animate-spin" /> : <ImagePlus size={24} />}
                <span className="text-[11px] mt-1">{heroBusy ? 'Uploading…' : 'Add hero image'}</span>
                <input
                  id="event-hero-input"
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
            <p className="text-[11px] text-un1t-muted">
              Image bytes save immediately.
            </p>
          </>
        )}

        {/* Accent colour — optional, clearable. Persisted via the main
            save payload, so it's editable on create and edit. */}
        <div className="pt-3 border-t border-un1t-border">
          <label className="block text-sm text-un1t-subtle mb-1">Accent colour</label>
          <div className="flex items-center gap-3">
            <input
              type="color"
              value={/^#[0-9a-fA-F]{6}$/.test(accentHex) ? accentHex : '#000000'}
              onChange={e => setAccentHex(e.target.value)}
              aria-label="Accent colour picker"
              className="h-9 w-12 bg-un1t-bg border border-un1t-border rounded-md cursor-pointer p-0.5"
            />
            <input
              type="text"
              value={accentHex}
              onChange={e => setAccentHex(e.target.value.trim())}
              placeholder="#000000"
              pattern="^#[0-9a-fA-F]{6}$"
              className="w-32 bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text font-mono"
            />
            {accentHex && (
              <button
                type="button"
                onClick={() => setAccentHex('')}
                className="text-xs text-un1t-subtle hover:text-red-700"
              >
                Clear
              </button>
            )}
          </div>
          <p className="text-[11px] text-un1t-muted mt-1">
            Optional brand colour for the public {meta.value === 'race' ? 'race' : 'event'} page. Leave blank to use the default.
          </p>
        </div>
      </div>

      {/* EVENTS-EMAILCFG.1 — per-event email styling. Configures the two
          live transactional emails this event sends: the signup
          confirmation and the pre-event reminder. Blank fields keep the
          current default copy, wrapped in the branded shell that the accent
          colour + hero image above already tint. Hidden for lead_gen — a
          capture form sends neither a confirmation nor a reminder. */}
      {!meta.isLeadGen && (
        <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5 space-y-5">
          <div className="flex items-start gap-3">
            <Mail size={18} className="text-un1t-subtle mt-0.5 shrink-0" />
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">Emails</h3>
              <p className="text-[11px] text-un1t-subtle mt-1">
                Style the signup confirmation and the pre-event reminder this {meta.value === 'race' ? 'race' : 'event'} sends.
                Leave a field blank to keep the current default. The accent colour + hero image set above already brand these emails.
              </p>
            </div>
          </div>

          {/* EVENT-COMMS-LOC (mig 553) — host events sit on a sender-less
              per-host anchor location, so their texts/emails need a real
              UN1T location's identity to send from. Hidden for internal
              UN1T events (hostId empty) — those already send from their
              own location. */}
          {hostId && (
            <div className="pb-1">
              <label className="block text-sm text-un1t-subtle mb-1">Send comms from</label>
              <select
                value={sendingLocationId}
                onChange={(e) => setSendingLocationId(e.target.value)}
                className="w-full max-w-md bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
              >
                {locationOptions.map((o) => (
                  <option key={o.id} value={o.id}>{o.name}{o.is_master ? ' (default)' : ''}</option>
                ))}
              </select>
              <p className="text-[11px] text-un1t-muted mt-1">
                Which UN1T location&apos;s Twilio sender + email identity this event&apos;s texts and emails use.
              </p>
            </div>
          )}

          <EventEmailFields
            title="Signup confirmation"
            description="Sent as soon as a signup is confirmed."
            subject={confirmationSubject}
            onSubject={setConfirmationSubject}
            subjectPlaceholder="{{event_name}} — you're in!"
            intro={confirmationIntro}
            onIntro={setConfirmationIntro}
            introPlaceholder="What's next: arrive 30 minutes early, bring water + a towel…"
            templateId={confirmationTemplateId}
            onTemplateId={setConfirmationTemplateId}
            templates={emailTemplates}
          />

          {/* EVENTS-SMS-TOGGLE (mig 552) — the signup confirmation can ALSO go
              out as a text message. OFF by default; the email above always
              sends. The pre-event reminder below is email + push only (no SMS). */}
          <label className="flex items-start gap-3 pt-4 border-t border-un1t-border cursor-pointer">
            <input
              type="checkbox"
              checked={confirmationSmsEnabled}
              onChange={e => setConfirmationSmsEnabled(e.target.checked)}
              className="mt-0.5 cursor-pointer"
            />
            <span>
              <span className="flex items-center gap-1.5 text-sm font-medium text-un1t-text">
                <MessageSquare size={14} className="text-un1t-subtle" /> Send a text message (SMS) confirmation
              </span>
              <span className="block text-[11px] text-un1t-subtle mt-1">
                Off by default. Texts the registrant a short confirmation on signup, on top of the email above.
                Sender ID is set per location in Settings → Locations → SMS.
              </span>
            </span>
          </label>

          <div className="pt-4 border-t border-un1t-border">
            <EventEmailFields
              title="Pre-event reminder"
              description="Sent automatically 3 days and 1 day before the event."
              subject={reminderSubject}
              onSubject={setReminderSubject}
              subjectPlaceholder="Reminder: {{event_name}} is tomorrow"
              intro={reminderIntro}
              onIntro={setReminderIntro}
              introPlaceholder="Before you arrive: get here 30 minutes early, bring water + a towel…"
              templateId={reminderTemplateId}
              onTemplateId={setReminderTemplateId}
              templates={emailTemplates}
            />
          </div>
        </div>
      )}

      {/* Glofox sync (GLOFOX3.3 / mig 145). Operator opts each event
          in. When on, every confirmed public registration on this
          event pushes the registrant + every team_member with a
          contact to Glofox in create-and-trial mode after the
          registration lands. For race kinds this means every team
          member (captain + others); for non-race kinds, the single
          registrant. */}
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle flex items-center gap-2">
            <UserPlus size={14} /> Glofox sync
          </h3>
          <button
            type="button"
            onClick={() => setCreateInGlofox(v => !v)}
            className={`shrink-0 w-10 h-5 rounded-full ${createInGlofox ? 'bg-emerald-500' : 'bg-un1t-border'}`}
          >
            <div className={`w-4 h-4 rounded-full bg-white transition-transform ${createInGlofox ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
        </div>
        <p className="text-[11px] text-un1t-subtle">
          When on, every confirmed registration on this {meta.value === 'race' ? 'race' : 'event'} pushes
          the registrant
          {meta.value === 'race' ? ' AND every team member ' : ' '}
          to Glofox: first we search by email and link if a Glofox account already
          exists; if not, we create a fresh Glofox account, attach this location&apos;s
          trial membership, and tag the contact for the welcome sequence (which emails
          the member their one-time passcode).
        </p>
        {createInGlofox && (
          <p className="text-[11px] text-amber-700">
            Make sure the trial membership picker is set on
            <span className="text-un1t-text"> Settings → Locations → Glofox Integration</span>
            {' '}for this location, otherwise pushes will land in the Review tab as
            <em> needs_review</em>.
          </p>
        )}
      </div>

      {isEditing && (
        <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5 flex items-center justify-between">
          <div>
            <div className="text-sm text-un1t-text">Active</div>
            <div className="text-[11px] text-un1t-subtle">Inactive {meta.value === 'race' ? 'races' : 'events'} are hidden from public signup but kept for history.</div>
          </div>
          <button
            type="button"
            onClick={() => setActive(v => !v)}
            className={`shrink-0 w-10 h-5 rounded-full ${active ? 'bg-emerald-500' : 'bg-un1t-border'}`}
          >
            <div className={`w-4 h-4 rounded-full bg-white transition-transform ${active ? 'translate-x-5' : 'translate-x-0.5'}`} />
          </button>
        </div>
      )}

      <button
        type="submit"
        disabled={saving}
        className="w-full inline-flex items-center justify-center gap-2 bg-un1t-text text-un1t-bg font-medium text-sm py-2.5 rounded-md hover:bg-un1t-accent disabled:opacity-50"
      >
        {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
        {saving ? 'Saving…' : isEditing ? 'Save Changes' : meta.submitLabel}
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
      <div className="relative bg-un1t-bg border border-un1t-border rounded-md aspect-video flex items-center justify-center p-3 group">
        { }
        <img src={url} alt={`Logo ${slot + 1}`} className="max-h-full max-w-full object-contain" />
        <button
          type="button"
          onClick={onRemove}
          disabled={busy}
          className="absolute top-1 right-1 bg-un1t-surface/90 border border-un1t-border rounded-full p-1 text-un1t-subtle hover:text-red-500 disabled:opacity-50"
          title="Remove logo"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <XIcon size={12} />}
        </button>
        <span className="absolute bottom-1 left-2 text-[10px] text-un1t-muted">Slot {slot + 1}</span>
      </div>
    )
  }
  return (
    <label
      htmlFor={inputId}
      className={`bg-un1t-bg border-2 border-dashed border-un1t-border hover:border-un1t-muted rounded-md aspect-video flex flex-col items-center justify-center text-un1t-subtle cursor-pointer ${busy ? 'opacity-50 pointer-events-none' : ''}`}
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

// EVENTS-EMAILCFG.1 — one email's operator controls: a subject line, an
// intro/body textarea (with a merge-tag hint), and an "Advanced" full-template
// picker. Presentation only — all state lives in RaceEventForm. A blank
// subject/intro falls back to the default copy server-side; the picker's empty
// option keeps the branded shell (tinted by the event's accent + hero image).
function EventEmailFields({
  title,
  description,
  subject,
  onSubject,
  subjectPlaceholder,
  intro,
  onIntro,
  introPlaceholder,
  templateId,
  onTemplateId,
  templates,
}) {
  return (
    <div className="space-y-3">
      <div>
        <h4 className="text-sm font-medium text-un1t-text">{title}</h4>
        <p className="text-[11px] text-un1t-subtle">{description}</p>
      </div>

      <div>
        <label className="block text-sm text-un1t-subtle mb-1">Subject</label>
        <input
          type="text"
          value={subject}
          onChange={(e) => onSubject(e.target.value)}
          placeholder={subjectPlaceholder}
          className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
        />
        <p className="text-[11px] text-un1t-muted mt-1">Blank = the default subject.</p>
      </div>

      <div>
        <label className="block text-sm text-un1t-subtle mb-1">Intro / body</label>
        <textarea
          value={intro}
          onChange={(e) => onIntro(e.target.value)}
          rows={3}
          placeholder={introPlaceholder}
          className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
        />
        <p className="text-[11px] text-un1t-muted mt-1">
          Merge tags: <code>{'{{event_name}}'}</code>, <code>{'{{team_name}}'}</code>, <code>{'{{when}}'}</code>, <code>{'{{location}}'}</code>. Blank = the default copy.
        </p>
      </div>

      <div>
        <label className="block text-sm text-un1t-subtle mb-1">Advanced: use a full template</label>
        <select
          value={templateId}
          onChange={(e) => onTemplateId(e.target.value)}
          className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
        >
          <option value="">Branded default (uses this event&apos;s colour + hero image)</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
        <p className="text-[11px] text-un1t-muted mt-1">
          Overrides the intro/body above with a saved email template&apos;s full HTML. The subject line still applies.
        </p>
      </div>
    </div>
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
