'use client'

// RaceSignupWidget — public signup widget for an event of any kind
// (race | workshop | seminar | open_day | masterclass). Lives at
// /event/[slug]. Standalone from BookingWidget (which is for
// Calendly-style slot booking).
//
// The component name + filename keep the "Race" prefix because
// many internal imports reference it; the user-facing UI says
// "Event" / "Booking" depending on kind. A future internal rename
// can rename the file without changing behaviour.
//
// Kind-aware behaviour (mig 122 added the discriminator on
// race_events.kind):
//   - kind='race': Original team-first signup. Team name required,
//     wave picker shown (multiple waves), N−1 member name+email
//     pairs for N>1, "Register team" submit.
//   - kind != 'race': Single time slot (one synthetic wave auto-
//     selected and the picker hidden), no team name (auto-derived
//     from captain name client-side so the underlying team_id FK
//     stays satisfied), N−1 attendee name+email pairs for N>1
//     (per Richard's spec: every seat captures name+email regardless
//     of buy mode — solo, bring-a-friend, group), terminology
//     relabelled ("team member" → "attendee", "Pick wave" hidden,
//     submit "Register" / "Buy N seats").
//
// Same pricing path (mig 084 — member/non-member per-head pricing,
// member-validation, members-only flag, Revolut Race embedded
// checkout) regardless of kind. The /register API handler is
// indifferent to kind.

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Calendar, Clock, MapPin, AlertCircle, Loader2, Check, BadgeCheck, Info } from 'lucide-react'

// Kind-keyed copy. Adding a new kind = one entry. The 'race' entry
// holds the original strings so the operator-visible UX for races
// is byte-identical to before the multi-kind extension.
const KIND_COPY = {
  race: {
    sidebarTimeOne: (t) => `Wave at ${t}`,
    sidebarTimeMany: (n, list) => `${n} waves: ${list}`,
    showWavePicker: true,
    showTeamName: true,
    headingTitle: 'Register your team',
    headingSubtitle: "You're registering as the team captain. Add your team members below.",
    captainSectionLabel: 'You (team captain)',
    membersSectionLabel: 'Other team members',
    sizeLabel: 'Team size *',
    sizeButtonSuffix: 'person',
    submitFreeLabel: 'Register team',
    submitPaidLabel: (price) => `Register and pay ${price}`,
    closedFull: 'This race is full.',
    closedNotYet: "Registration hasn't opened yet for this race.",
    closedClosed: 'Registration has closed for this race.',
    membersOnlyExtra: ' This race is members-only — every team member must be a verified UN1T member.',
    membersOnlyBlock: (n) =>
      `This is a members-only race. We couldn't verify membership for ${n} team member(s). Make sure everyone uses the email on their UN1T account.`,
  },
  workshop: {
    sidebarTimeOne: (t) => `Starts at ${t}`,
    sidebarTimeMany: (n, list) => `Sessions at ${list}`,
    showWavePicker: false,
    showTeamName: false,
    headingTitle: 'Book your spot',
    headingSubtitle: "Add anyone joining you below — every spot captures a name and email.",
    captainSectionLabel: 'Your details',
    membersSectionLabel: 'Other attendees',
    sizeLabel: 'How many spots? *',
    sizeButtonSuffix: 'spot',
    submitFreeLabel: 'Book spot',
    submitPaidLabel: (price) => `Book and pay ${price}`,
    closedFull: 'This workshop is full.',
    closedNotYet: "Bookings haven't opened yet for this workshop.",
    closedClosed: 'Bookings have closed for this workshop.',
    membersOnlyExtra: " This workshop is members-only — every attendee must be a verified UN1T member.",
    membersOnlyBlock: (n) =>
      `This is a members-only workshop. We couldn't verify membership for ${n} attendee(s). Make sure everyone uses the email on their UN1T account.`,
  },
  seminar: {
    sidebarTimeOne: (t) => `Starts at ${t}`,
    sidebarTimeMany: (n, list) => `Sessions at ${list}`,
    showWavePicker: false,
    showTeamName: false,
    headingTitle: 'Book your spot',
    headingSubtitle: "Add anyone joining you below — every spot captures a name and email.",
    captainSectionLabel: 'Your details',
    membersSectionLabel: 'Other attendees',
    sizeLabel: 'How many spots? *',
    sizeButtonSuffix: 'spot',
    submitFreeLabel: 'Book spot',
    submitPaidLabel: (price) => `Book and pay ${price}`,
    closedFull: 'This seminar is full.',
    closedNotYet: "Bookings haven't opened yet for this seminar.",
    closedClosed: 'Bookings have closed for this seminar.',
    membersOnlyExtra: " This seminar is members-only — every attendee must be a verified UN1T member.",
    membersOnlyBlock: (n) =>
      `This is a members-only seminar. We couldn't verify membership for ${n} attendee(s). Make sure everyone uses the email on their UN1T account.`,
  },
  open_day: {
    sidebarTimeOne: (t) => `Starts at ${t}`,
    sidebarTimeMany: (n, list) => `Sessions at ${list}`,
    showWavePicker: false,
    showTeamName: false,
    headingTitle: 'Reserve your spot',
    headingSubtitle: "Add anyone joining you below — every spot captures a name and email.",
    captainSectionLabel: 'Your details',
    membersSectionLabel: 'Other attendees',
    sizeLabel: 'How many spots? *',
    sizeButtonSuffix: 'spot',
    submitFreeLabel: 'Reserve spot',
    submitPaidLabel: (price) => `Reserve and pay ${price}`,
    closedFull: 'This open day is full.',
    closedNotYet: "Reservations haven't opened yet for this open day.",
    closedClosed: 'Reservations have closed for this open day.',
    membersOnlyExtra: ' This open day is members-only — every attendee must be a verified UN1T member.',
    membersOnlyBlock: (n) =>
      `This is a members-only open day. We couldn't verify membership for ${n} attendee(s). Make sure everyone uses the email on their UN1T account.`,
  },
  masterclass: {
    sidebarTimeOne: (t) => `Starts at ${t}`,
    sidebarTimeMany: (n, list) => `Sessions at ${list}`,
    showWavePicker: false,
    showTeamName: false,
    headingTitle: 'Book your spot',
    headingSubtitle: "Add anyone joining you below — every spot captures a name and email.",
    captainSectionLabel: 'Your details',
    membersSectionLabel: 'Other attendees',
    sizeLabel: 'How many spots? *',
    sizeButtonSuffix: 'spot',
    submitFreeLabel: 'Book spot',
    submitPaidLabel: (price) => `Book and pay ${price}`,
    closedFull: 'This masterclass is full.',
    closedNotYet: "Bookings haven't opened yet for this masterclass.",
    closedClosed: 'Bookings have closed for this masterclass.',
    membersOnlyExtra: ' This masterclass is members-only — every attendee must be a verified UN1T member.',
    membersOnlyBlock: (n) =>
      `This is a members-only masterclass. We couldn't verify membership for ${n} attendee(s). Make sure everyone uses the email on their UN1T account.`,
  },
  // Lead Gen — a pure name/email/phone capture form. No team, no wave,
  // no pricing. The size selector hides itself (allowed_team_sizes is
  // [1]); team-name + wave picker are off; isLeadGen tells the submit
  // handler to skip the wave requirement.
  lead_gen: {
    sidebarTimeOne: () => '',
    sidebarTimeMany: () => '',
    showWavePicker: false,
    showTeamName: false,
    isLeadGen: true,
    headingTitle: 'Sign up',
    headingSubtitle: "Pop your details in below and we'll be in touch.",
    captainSectionLabel: 'Your details',
    membersSectionLabel: '',
    sizeLabel: '',
    sizeButtonSuffix: '',
    submitFreeLabel: 'Sign up',
    submitPaidLabel: () => 'Sign up',
    closedFull: 'This form is closed.',
    closedNotYet: "This form isn't open yet.",
    closedClosed: 'This form is closed.',
    membersOnlyExtra: '',
    membersOnlyBlock: () => '',
  },
}

const copyFor = (k) => KIND_COPY[k] || KIND_COPY.race

export default function RaceSignupWidget({ slug, embedded = false }) {
  // When embedded in a cross-site iframe, post-submit navigation must
  // break OUT of the iframe (otherwise the confirmation / payment page
  // renders trapped inside the embed). go() targets the top window when
  // embedded, else uses the in-app router.
  const go = (url) => {
    // Embedded in a cross-site iframe: break OUT to the top window so
    // the confirmation / payment page isn't trapped inside the host's
    // frame. Use window.open(_top) rather than assigning location (the
    // latter trips the react-hooks immutability lint).
    if (embedded && typeof window !== 'undefined') {
      try { window.open(url, '_top'); return } catch { /* fall through */ }
    }
    router.push(url)
  }
  const router = useRouter()
  const [race, setRace] = useState(null)
  const [loadError, setLoadError] = useState(null)

  // Form state
  const [teamName, setTeamName] = useState('')
  const [teamSize, setTeamSize] = useState(1)
  const [waveId, setWaveId] = useState('')
  const [members, setMembers] = useState([])
  const [captainName, setCaptainName] = useState('')
  const [captainEmail, setCaptainEmail] = useState('')
  const [captainPhone, setCaptainPhone] = useState('')
  // CONSENT.4 — soft opt-in for marketing comms. Defaulted to true;
  // applies to the captain (the only contact we collect a phone for
  // and the registrant of record). Per CONSENT.2, ClassPass contacts
  // are excluded server-side regardless.
  const [marketingConsent, setMarketingConsent] = useState(true)

  // Member-validation cache. Key = lower email; value =
  //   { state: 'idle'|'checking'|'verified'|'not_member'|'error', first_name?, applicable }
  // 'error' = the check itself failed (blip / rate limit) — retryable,
  // never a rate verdict.
  const [memberChecks, setMemberChecks] = useState({})
  const checkTimers = useRef({})

  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState(null)
  const [fieldErrors, setFieldErrors] = useState({})

  // EVENTS-PROMO.1 — optional discount code. Validated + applied
  // server-side at /register; the discounted total shows at the payment
  // step (no live preview here by design). `promoError` surfaces a 400
  // invalid_promo_code inline so the customer can fix + retry.
  const [promoCode, setPromoCode] = useState('')
  const [promoError, setPromoError] = useState(null)

  // Initial load
  useEffect(() => {
    fetch(`/api/public/events/${slug}`)
      .then(r => r.json())
      .then(j => {
        if (!j.success) {
          setLoadError(j.error || 'Event not found')
          return
        }
        setRace(j.data)
        const sizes = j.data.allowed_team_sizes || [1]
        const initial = [...sizes].sort((a, b) => a - b)[0]
        setTeamSize(initial)
        const waves = Array.isArray(j.data.waves) ? j.data.waves : []
        const available = waves.filter((w) => !w.is_full)
        // For non-race kinds we always auto-select the (single)
        // available wave because the picker is hidden. For races
        // we only auto-select when there's exactly one option.
        const kind = j.data.kind || 'race'
        if (kind !== 'race' && available.length >= 1) {
          setWaveId(available[0].id)
        } else if (waves.length === 1 && available.length === 1) {
          setWaveId(waves[0].id)
        } else if (available.length === 1) {
          setWaveId(available[0].id)
        }
      })
      .catch(e => setLoadError(e.message || 'Network error'))
  }, [slug])

  // Reshape members array when team_size changes.
  useEffect(() => {
    const memberCount = Math.max(0, teamSize - 1)
    setMembers((prev) => {
      const next = []
      for (let i = 0; i < memberCount; i++) {
        next.push(prev[i] || { name: '', email: '' })
      }
      return next
    })
  }, [teamSize])

  function validateEmail(s) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)
  }

  // Debounced member check for one email. The key in memberChecks is
  // the lowercased email; the underlying API endpoint is rate-limited
  // (60/min) but we still debounce to avoid hammering it on keystroke.
  function scheduleMemberCheck(rawEmail) {
    const email = (rawEmail || '').trim().toLowerCase()
    if (!email || !validateEmail(email)) return
    if (!race?.member_pricing_enabled && !race?.members_only) return
    // 'error' stays retryable (MEMRATE.1): a transient failure — network
    // blip, rate limit — is not a verdict, and caching it as one froze
    // "Non-member rate" on a verified member for the page's lifetime.
    const existing = memberChecks[email]
    if (existing && existing.state !== 'idle' && existing.state !== 'error') return
    if (checkTimers.current[email]) clearTimeout(checkTimers.current[email])
    checkTimers.current[email] = setTimeout(async () => {
      setMemberChecks((prev) => ({ ...prev, [email]: { state: 'checking', applicable: true } }))
      try {
        const r = await fetch(`/api/public/events/${slug}/check-member`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        })
        const j = await r.json()
        if (j?.success && j.data?.applicable) {
          setMemberChecks((prev) => ({
            ...prev,
            [email]: {
              state: j.data.is_member ? 'verified' : 'not_member',
              first_name: j.data.first_name || null,
              races_finished_count: j.data.races_finished_count ?? null,
              repeat_racer: !!j.data.repeat_racer,
              applicable: true,
            },
          }))
        } else if (j?.success && j.data && j.data.applicable === false) {
          // A real server answer: member pricing doesn't apply here.
          setMemberChecks((prev) => ({
            ...prev,
            [email]: { state: 'not_member', applicable: false },
          }))
        } else {
          // Rate-limited or malformed — retryable, not a verdict.
          setMemberChecks((prev) => ({
            ...prev,
            [email]: { state: 'error', applicable: true },
          }))
        }
      } catch {
        setMemberChecks((prev) => ({
          ...prev,
          [email]: { state: 'error', applicable: true },
        }))
      }
    }, 500)
  }

  const liveRoster = [
    { name: captainName, email: captainEmail.toLowerCase().trim() },
    ...members.map((m) => ({ name: m.name, email: (m.email || '').toLowerCase().trim() })),
  ]

  function isVerifiedMember(email) {
    if (!email) return false
    return memberChecks[email]?.state === 'verified'
  }

  // Live pricing preview. Mirrors computeTeamPricing on the server.
  const memberPricing = !!race?.member_pricing_enabled
  const memberFeeCents = Number.isFinite(race?.member_fee_cents) ? race.member_fee_cents : null
  const nonMemberFeeCents = Number.isFinite(race?.non_member_fee_cents) ? race.non_member_fee_cents : null
  const currency = race?.payment_currency || 'EUR'

  let memberCount = 0, nonMemberCount = 0
  for (const m of liveRoster) {
    if (memberPricing && isVerifiedMember(m.email)) memberCount += 1
    else nonMemberCount += 1
  }
  const memberSubtotal = memberPricing && memberFeeCents != null ? memberFeeCents * memberCount : 0
  const nonMemberSubtotal = nonMemberFeeCents != null ? nonMemberFeeCents * nonMemberCount : 0
  const totalCents = memberSubtotal + nonMemberSubtotal

  // MEMRATE.1 — the preview must not state a rate the server hasn't
  // confirmed. An email's rate is confirmed once its check has answered
  // ('verified' or 'not_member'); while the captain's email is empty,
  // mid-typing, mid-check, or errored, the total shows a placeholder
  // instead of silently assuming non-member. Teammate emails are
  // optional, so only a TYPED teammate email holds the total — a blank
  // one prices as non-member exactly like the server will.
  const rateConfirmed = (email) =>
    ['verified', 'not_member'].includes(memberChecks[email]?.state)
  const ratePending = memberPricing && (
    !(validateEmail(liveRoster[0].email) && rateConfirmed(liveRoster[0].email)) ||
    liveRoster.slice(1).some((m) => m.email && !(validateEmail(m.email) && rateConfirmed(m.email)))
  )
  const anyCheckInFlight = Object.values(memberChecks).some((c) => c?.state === 'checking')

  const fmtMoney = (cents) => {
    if (!Number.isFinite(cents)) return ''
    const major = (cents / 100).toFixed(2)
    if (currency === 'EUR') return `€${major}`
    if (currency === 'GBP') return `£${major}`
    return `${major} ${currency}`
  }

  const kind = race?.kind || 'race'
  const copy = copyFor(kind)
  const isLeadGen = kind === 'lead_gen'

  async function handleSubmit(e) {
    e.preventDefault()
    setSubmitError(null)
    setFieldErrors({})
    setPromoError(null)

    const errors = {}
    // Team name required only for races. Non-race kinds synthesise
    // a server-bound team_name from the captain so the team_id FK
    // stays satisfied.
    if (copy.showTeamName && !teamName.trim()) errors.team_name = 'Team name is required'
    if (!copy.isLeadGen && !waveId) errors.wave_id = copy.showWavePicker ? 'Pick a wave' : 'No time slot available'
    if (!captainName.trim()) errors.captain_name = 'Your name is required'
    if (!validateEmail(captainEmail)) errors.captain_email = 'Valid email required'
    if (!captainPhone.trim()) errors.captain_phone = 'Phone number is required'
    else if (captainPhone.replace(/\D/g, '').length < 7) errors.captain_phone = 'Enter a valid phone number'
    members.forEach((m, i) => {
      if (!m.name.trim()) errors[`member_${i}_name`] = 'Name required'
      if (m.email && !validateEmail(m.email)) errors[`member_${i}_email`] = 'Invalid email'
    })

    if (race?.members_only) {
      const unverified = liveRoster.filter((m) => !isVerifiedMember(m.email))
      if (unverified.length > 0) {
        setSubmitError(copy.membersOnlyBlock(unverified.length))
        return
      }
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors)
      return
    }

    // Synthesised team_name for non-race kinds. The team_id FK on
    // race_registrations still needs a non-null value; we make it
    // human-readable so operator views ("teams" tab on the operator
    // event detail page) show something meaningful: the captain's
    // name plus a "(+N)" suffix if it's a group buy.
    const outboundTeamName = copy.showTeamName
      ? teamName.trim()
      : (teamSize > 1
          ? `${captainName.trim()} (+${teamSize - 1})`
          : captainName.trim())

    setSubmitting(true)
    const res = await fetch(`/api/public/events/${slug}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_name: outboundTeamName,
        team_size: teamSize,
        ...(waveId ? { wave_id: waveId } : {}),
        captain_name: captainName.trim(),
        captain_email: captainEmail.trim().toLowerCase(),
        captain_phone: captainPhone.trim(),
        members: members.map((m) => ({
          name: m.name.trim(),
          email: m.email.trim() || null,
        })),
        source: 'race_signup_widget',
        marketing_consent: marketingConsent,
        ...(promoCode.trim() ? { promo_code: promoCode.trim() } : {}),
      }),
    })
    const json = await res.json()
    setSubmitting(false)

    if (!res.ok || json.success === false) {
      // A rejected promo code is recoverable — surface it next to the
      // promo field so the customer can fix it + retry, not as a generic
      // registration failure.
      if (res.status === 400 && json.code === 'invalid_promo_code') {
        setPromoError(json.error || 'That code isn’t valid.')
        return
      }
      setSubmitError(json.error || `Registration failed (${res.status})`)
      return
    }

    const payment = json.data?.payment
    if (payment?.free) {
      go(`/event/${slug}/confirmed?registration=${json.data.registration_id}`)
    } else if (payment?.id) {
      go(`/event-pay/${payment.id}`)
    } else {
      go(`/event/${slug}/confirmed?registration=${json.data.registration_id}`)
    }
  }

  if (loadError) {
    return (
      <div className="min-h-[60vh] w-full flex flex-col items-center justify-center text-center px-5 py-20">
        <AlertCircle size={36} className="mb-3 text-red-400" />
        <p className="text-white/70">{loadError}</p>
      </div>
    )
  }
  if (!race) {
    return (
      <div className="min-h-[60vh] w-full flex items-center justify-center py-20">
        <Loader2 size={28} className="animate-spin text-white/40" />
      </div>
    )
  }

  const location = race.locations || null
  // Host events store the real, free-text venue on the race row; their
  // location_id points at a hidden internal anchor ("<host> (host events)",
  // null address). Prefer the venue fields when set so the public surfaces
  // show where the event actually is. UN1T events have no venue_name, so
  // these fall through to the location's own name/address unchanged.
  //
  // EVENT-COPY.1 — the `|| location?.name` fallback is SAFE only because
  // /api/public/events/[slug] already resolved `venue_name` and blanked the
  // name+address of an ops-only anchor row before serving it. This is a client
  // component: it cannot tell an anchor from a gym, so it must not try. If you
  // ever feed this widget from another endpoint, sanitise there the same way.
  const venueName = race.venue_name || location?.name || null
  const venueAddress = race.venue_address || location?.address || null
  const closedReasons = {
    not_yet_open: copy.closedNotYet,
    closed: copy.closedClosed,
    full: copy.closedFull,
  }
  const isClosed = race.registration_state !== 'open'
  const closeMsg = closedReasons[race.registration_state]
  const showMemberNotice = !!(race.member_pricing_enabled || race.members_only)
  const showPricingCard = !!(memberPricing || nonMemberFeeCents != null)
  const wavesArr = Array.isArray(race.waves) ? race.waves : []

  // ── Render-only derived values (no behaviour change) ──────────────
  // Human label for the event kind, used in the hero eyebrow.
  const KIND_LABELS = {
    race: 'Race',
    workshop: 'Workshop',
    seminar: 'Seminar',
    open_day: 'Open day',
    masterclass: 'Masterclass',
    lead_gen: 'Sign up',
  }
  const kindLabel = KIND_LABELS[kind] || 'Event'

  // Status pill — derived ONLY from registration_state + per-wave
  // is_full booleans. Never exposes raw capacity / counts.
  const regState = race.registration_state
  let pillLabel = 'Registration open'
  let pillLive = false
  if (regState === 'full') pillLabel = 'Sold out'
  else if (regState === 'closed') pillLabel = 'Registration closed'
  else if (regState === 'not_yet_open') pillLabel = 'Opens soon'
  else {
    pillLive = true
    pillLabel = wavesArr.some((w) => w.is_full) ? 'Filling fast' : 'Registration open'
  }

  // Hero eyebrow parts — lead_gen stays minimal (no date implication).
  const heroDateStr = (!isLeadGen && race.race_date)
    ? new Date(race.race_date).toLocaleDateString('en-IE', { weekday: 'short', day: 'numeric', month: 'short' })
    : null
  const eyebrowParts = [kindLabel, heroDateStr, venueName].filter(Boolean)

  // Poster background (monochrome gradient copied from the approved
  // mockup's .hero-media .bg) — the graceful fallback when no hero
  // photo is set.
  const heroBg =
    'radial-gradient(120% 90% at 78% 6%, rgba(255,255,255,.16), rgba(255,255,255,0) 46%),' +
    'radial-gradient(90% 80% at 12% 100%, rgba(255,255,255,.10), rgba(255,255,255,0) 40%),' +
    'linear-gradient(180deg,#141414 0%,#0a0a0a 55%,#000 100%)'

  // Optional hero photo. When race.hero_image_url is a non-empty string
  // we render it as the hero background (keeping the ken-burns zoom and
  // the legibility scrim on top); otherwise we fall back to the
  // generated monochrome poster gradient above.
  const heroImageUrl =
    typeof race.hero_image_url === 'string' && race.hero_image_url.trim()
      ? race.hero_image_url.trim()
      : null
  const hasHeroImage = !!heroImageUrl
  // CSS-escape the url() argument so a stray quote/backslash can't break
  // out of the string (operator-set data, but cheap to harden).
  const heroImageCss = heroImageUrl
    ? `url("${heroImageUrl.replace(/["\\]/g, (c) => `\\${c}`)}")`
    : null

  // Optional per-event accent. Only accept a strict #rrggbb value so a
  // bad/injected string can never leak into an inline style. Used to
  // subtly tint the "live" status pill; the default (no accent) leaves
  // the pill exactly as before.
  const accentHex =
    typeof race.accent_hex === 'string' && /^#[0-9a-fA-F]{6}$/.test(race.accent_hex.trim())
      ? race.accent_hex.trim()
      : null
  const livePillStyle =
    pillLive && accentHex
      ? { backgroundColor: `${accentHex}1a`, borderColor: `${accentHex}55`, color: accentHex }
      : undefined
  const liveDotStyle = pillLive && accentHex ? { backgroundColor: accentHex } : undefined

  // Dynamic submit label — identical logic to the pre-reskin button;
  // shared by the desktop submit and the mobile sticky action bar.
  const submitLabel = submitting
    ? 'Submitting…'
    : totalCents > 0 && !ratePending
      ? copy.submitPaidLabel(fmtMoney(totalCents))
      : copy.submitFreeLabel

  const liveTotalLabel = ratePending ? '—' : totalCents > 0 ? fmtMoney(totalCents) : 'Free'

  // Dark input / label / error class recipes (design-system tokens).
  const inputCls = (invalid) =>
    `w-full bg-white/5 border rounded-xl px-3.5 py-3 text-[15px] text-white placeholder-white/35 focus:outline-none focus:bg-white/10 transition-colors ${invalid ? 'border-red-400/70 focus:border-red-400' : 'border-white/15 focus:border-white/45'}`
  const labelCls = 'block text-[11px] font-semibold uppercase tracking-[0.14em] text-white/55 mb-2'
  const errCls = 'text-[11px] text-red-400 mt-1'
  const sectionEyebrow = 'text-[11px] font-semibold uppercase tracking-[0.2em] text-white/45 mb-3'

  // Stable per-slug form id so the fixed mobile action bar (rendered
  // outside the <form>) can submit it via the `form` attribute.
  const formId = `event-signup-form-${slug}`

  return (
    <div className="relative w-full">
      {/* ── HERO (poster style, works with no image) — full page only;
             the paste-anywhere iframe embed uses a compact header ──── */}
      {!embedded && (
      <section className="relative min-h-[58svh] flex items-end overflow-hidden lp-grain">
        {/* Hero background + slow ken-burns zoom. When a hero photo is
            set we render it (cover/center); otherwise the monochrome
            poster gradient + grid-lines fallback. */}
        <div className="absolute inset-0 overflow-hidden">
          {hasHeroImage ? (
            <div
              className="absolute inset-[-4%] lp-kenburns"
              style={{
                backgroundImage: heroImageCss,
                backgroundSize: 'cover',
                backgroundPosition: 'center',
              }}
            />
          ) : (
            <>
              <div className="absolute inset-[-4%] lp-kenburns" style={{ background: heroBg }} />
              <div
                className="absolute inset-0 opacity-50"
                style={{
                  backgroundImage: 'linear-gradient(90deg,rgba(255,255,255,.04) 1px,transparent 1px)',
                  backgroundSize: '56px 100%',
                  maskImage: 'linear-gradient(180deg,transparent,#000 40%,transparent)',
                  WebkitMaskImage: 'linear-gradient(180deg,transparent,#000 40%,transparent)',
                }}
              />
            </>
          )}
        </div>
        {/* huge outlined watermark of the event name */}
        <div
          aria-hidden="true"
          className="lp-outline absolute z-[1] select-none uppercase"
          style={{ fontSize: '26vw', lineHeight: 0.8, fontWeight: 800, letterSpacing: '-0.03em', whiteSpace: 'nowrap', left: '-2vw', bottom: '-2vw' }}
        >
          {race.name}
        </div>
        {/* legibility scrim */}
        <div className="absolute inset-0 z-[2] bg-gradient-to-t from-black via-black/60 to-black/20" />

        {/* hero content */}
        <div className="relative z-10 max-w-6xl mx-auto w-full px-5 pb-12 lp-hero-stagger">
          <div>
            <span
              style={livePillStyle}
              className={`inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] px-3 py-1.5 rounded-full border ${pillLive ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' : 'bg-white/10 border-white/15 text-white/80'}`}
            >
              {pillLive && (
                <span style={liveDotStyle} className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shadow-[0_0_0_4px_rgba(34,197,94,0.18)]" />
              )}
              {pillLabel}
            </span>
          </div>
          {eyebrowParts.length > 0 && (
            <p className="mt-5 text-[11px] uppercase tracking-[0.2em] text-white/45">
              {eyebrowParts.join(' · ')}
            </p>
          )}
          <h1 className="mt-3 font-bold uppercase tracking-tight text-5xl md:text-7xl leading-[0.95] text-white">
            {race.name}
          </h1>
        </div>
      </section>
      )}

      {/* ── BODY ─────────────────────────────────────────────────── */}
      <div className={embedded
        ? 'max-w-xl mx-auto px-4 py-6'
        : 'max-w-6xl mx-auto px-5 pb-28 pt-10 grid gap-10 md:grid-cols-[1fr_420px] md:items-start'}>
        {/* Compact event header — embed only (the hero is hidden there) */}
        {embedded && (
          <div className="mb-5">
            <span
              style={livePillStyle}
              className={`inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] px-3 py-1.5 rounded-full border ${pillLive ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300' : 'bg-white/10 border-white/15 text-white/80'}`}
            >
              {pillLive && <span style={liveDotStyle} className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />}
              {pillLabel}
            </span>
            <h1 className="mt-3 font-bold uppercase tracking-tight text-2xl leading-tight text-white">{race.name}</h1>
            {eyebrowParts.length > 0 && (
              <p className="mt-1.5 text-[11px] uppercase tracking-[0.2em] text-white/45">{eyebrowParts.join(' · ')}</p>
            )}
          </div>
        )}
        {/* LEFT — event story + details + pricing (full page only) */}
        {!embedded && (
        <div className="min-w-0">
          {race.description && (
            <p className="text-[15px] md:text-base text-white/70 whitespace-pre-line leading-relaxed">
              {race.description}
            </p>
          )}

          {/* date / time / location rows */}
          {(!isLeadGen || wavesArr.length > 0 || venueAddress) && (
            <div className={`${race.description ? 'mt-8' : ''} rounded-2xl border border-white/10 bg-white/[0.03] p-5 space-y-3.5 text-sm text-white/70`}>
              {!isLeadGen && race.race_date && (
                <div className="flex items-center gap-3">
                  <Calendar size={16} className="text-white/40 shrink-0" />
                  <span className="text-white/85">
                    {new Date(race.race_date).toLocaleDateString('en-IE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
                  </span>
                </div>
              )}
              {wavesArr.length > 0 && (
                <div className="flex items-start gap-3">
                  <Clock size={16} className="text-white/40 mt-0.5 shrink-0" />
                  <span>
                    {wavesArr.length === 1
                      ? copy.sidebarTimeOne((wavesArr[0].start_time || '').slice(0, 5))
                      : copy.sidebarTimeMany(
                          wavesArr.length,
                          wavesArr.map(w => (w.start_time || '').slice(0, 5)).join(', ')
                        )}
                  </span>
                </div>
              )}
              {venueAddress && (
                <div className="flex items-start gap-3">
                  <MapPin size={16} className="text-white/40 mt-0.5 shrink-0" />
                  <span>{venueAddress}</span>
                </div>
              )}
            </div>
          )}

          {/* Pricing summary — same logic as before, kind-agnostic. */}
          {showPricingCard && (
            <div className="mt-5 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
              <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/45 mb-2">Total</div>
              <div className="text-3xl font-bold text-white">
                {liveTotalLabel}
              </div>
              {ratePending && (
                <div className="text-[12px] text-white/55 mt-3">
                  {anyCheckInFlight
                    ? 'Checking member rate…'
                    : 'Add your email to confirm your rate.'}
                </div>
              )}
              {!ratePending && memberPricing && (memberCount > 0 || nonMemberCount > 0) && (
                <div className="text-[12px] text-white/55 mt-3 space-y-1">
                  {memberCount > 0 && (
                    <div>{memberCount} × member {memberFeeCents != null ? fmtMoney(memberFeeCents) : 'free'}</div>
                  )}
                  {nonMemberCount > 0 && (
                    <div>{nonMemberCount} × non-member {nonMemberFeeCents != null ? fmtMoney(nonMemberFeeCents) : 'free'}</div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        )}

        {/* RIGHT — registration form */}
        <div className="lp-card-glow rounded-2xl p-6 md:sticky md:top-6">
          <h2 className="text-lg font-semibold text-white">{copy.headingTitle}</h2>
          <p className="text-[13px] text-white/55 mt-1 mb-5">
            {copy.headingSubtitle}
          </p>

          {showMemberNotice && (
            <div className="mb-4 p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs flex items-start gap-2">
              <Info size={14} className="mt-0.5 shrink-0 text-amber-300" />
              <span>
                <strong className="text-amber-200">UN1T members:</strong> use the email on your UN1T account so member pricing applies. We&apos;ll match each entrant&apos;s email against active member records.
                {race.members_only && copy.membersOnlyExtra}
              </span>
            </div>
          )}

          {isClosed && (
            <div className="mb-4 p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-300 text-sm flex items-start gap-2">
              <AlertCircle size={14} className="mt-0.5 shrink-0" /> {closeMsg}
            </div>
          )}

          <form id={formId} onSubmit={handleSubmit} className="space-y-4">
            <fieldset disabled={isClosed} className="space-y-4">
              {/* Wave picker — race-only. Non-race kinds have a single
                  auto-selected wave; the time is shown in the details
                  block so the operator UX still surfaces it. */}
              {copy.showWavePicker && wavesArr.length > 0 && (
                <div>
                  <label className={labelCls}>Pick your wave *</label>
                  <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-3 gap-2">
                    {wavesArr.map((w) => {
                      const full = !!w.is_full
                      const selected = waveId === w.id
                      const time = (w.start_time || '').slice(0, 5)
                      return (
                        <button
                          key={w.id}
                          type="button"
                          disabled={full}
                          onClick={() => setWaveId(w.id)}
                          aria-pressed={selected}
                          title={w.label ? `${time} — ${w.label}${full ? ' (full)' : ''}` : full ? `${time} (full)` : time}
                          className={`px-2 py-2.5 rounded-xl border text-center transition-colors ${
                            selected
                              ? 'border-white bg-white/10 text-white'
                              : full
                                ? 'border-white/10 bg-white/[0.03] text-white/40 line-through cursor-not-allowed'
                                : 'border-white/15 bg-white/5 text-white hover:border-white/40'
                          }`}
                        >
                          <div className="text-sm font-semibold leading-tight tabular-nums">{time}</div>
                          {w.label && (
                            <div className={`text-[10px] truncate leading-tight mt-0.5 ${selected ? 'text-white/70' : 'text-white/50'}`}>
                              {w.label}
                            </div>
                          )}
                          {full && !w.label && (
                            <div className="text-[10px] leading-tight mt-0.5">Full</div>
                          )}
                        </button>
                      )
                    })}
                  </div>
                  {fieldErrors.wave_id && <p className={errCls}>{fieldErrors.wave_id}</p>}
                </div>
              )}

              {/* Team name — race-only. Non-race kinds synthesise a
                  team_name from the captain + group size on submit. */}
              {copy.showTeamName && (
                <div>
                  <label className={labelCls}>Team name *</label>
                  <input
                    type="text"
                    required
                    value={teamName}
                    onChange={e => setTeamName(e.target.value)}
                    placeholder="The Iron Dogs"
                    className={inputCls(!!fieldErrors.team_name)}
                  />
                  {fieldErrors.team_name && <p className={errCls}>{fieldErrors.team_name}</p>}
                </div>
              )}

              {(race.allowed_team_sizes || []).length > 1 && (
                <div>
                  <label className={labelCls}>{copy.sizeLabel}</label>
                  <div className="flex flex-wrap gap-2">
                    {[...(race.allowed_team_sizes || [])].sort((a, b) => a - b).map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setTeamSize(s)}
                        className={`text-sm px-4 py-2.5 rounded-xl border font-semibold transition-colors ${
                          teamSize === s
                            ? 'border-white bg-white text-black'
                            : 'border-white/15 bg-white/5 text-white/70 hover:border-white/40'
                        }`}
                      >
                        {s}-{s === 1 || !copy.sizeButtonSuffix
                          ? copy.sizeButtonSuffix
                          : copy.sizeButtonSuffix === 'person' ? 'people' : `${copy.sizeButtonSuffix}s`}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="pt-4 border-t border-white/10">
                <div className={sectionEyebrow}>{copy.captainSectionLabel}</div>
                <div className="space-y-2.5">
                  <input
                    type="text"
                    required
                    placeholder="Your name *"
                    value={captainName}
                    onChange={e => setCaptainName(e.target.value)}
                    className={inputCls(!!fieldErrors.captain_name)}
                  />
                  {fieldErrors.captain_name && <p className={errCls}>{fieldErrors.captain_name}</p>}
                  <div>
                    <input
                      type="email"
                      required
                      placeholder="Your email *"
                      value={captainEmail}
                      onChange={e => {
                        setCaptainEmail(e.target.value)
                        scheduleMemberCheck(e.target.value)
                      }}
                      onBlur={() => scheduleMemberCheck(captainEmail)}
                      className={inputCls(!!fieldErrors.captain_email)}
                    />
                    <MemberStatusBadge
                      email={captainEmail}
                      checks={memberChecks}
                      memberFeeCents={memberFeeCents}
                      nonMemberFeeCents={nonMemberFeeCents}
                      memberPricing={memberPricing}
                      fmt={fmtMoney}
                      onRetry={() => scheduleMemberCheck(captainEmail)}
                    />
                    {fieldErrors.captain_email && <p className={errCls}>{fieldErrors.captain_email}</p>}
                  </div>
                  <div>
                    <input
                      type="tel"
                      required
                      placeholder="Your phone *"
                      value={captainPhone}
                      onChange={e => setCaptainPhone(e.target.value)}
                      className={inputCls(!!fieldErrors.captain_phone)}
                    />
                    {fieldErrors.captain_phone && <p className={errCls}>{fieldErrors.captain_phone}</p>}
                  </div>
                </div>
              </div>

              {members.length > 0 && (
                <div className="pt-4 border-t border-white/10">
                  <div className={sectionEyebrow}>{copy.membersSectionLabel}</div>
                  <div className="space-y-4">
                    {members.map((m, i) => (
                      <div key={i} className="space-y-1.5">
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <input
                              type="text"
                              required
                              placeholder={`${kind === 'race' ? 'Member' : 'Attendee'} ${i + 2} name *`}
                              value={m.name}
                              onChange={e => setMembers(prev => prev.map((x, j) => j === i ? { ...x, name: e.target.value } : x))}
                              className={inputCls(!!fieldErrors[`member_${i}_name`])}
                            />
                            {fieldErrors[`member_${i}_name`] && <p className={errCls}>{fieldErrors[`member_${i}_name`]}</p>}
                          </div>
                          <div>
                            <input
                              type="email"
                              placeholder={`${kind === 'race' ? 'Member' : 'Attendee'} ${i + 2} email`}
                              value={m.email}
                              onChange={e => {
                                const next = e.target.value
                                setMembers(prev => prev.map((x, j) => j === i ? { ...x, email: next } : x))
                                scheduleMemberCheck(next)
                              }}
                              onBlur={() => scheduleMemberCheck(m.email)}
                              className={inputCls(!!fieldErrors[`member_${i}_email`])}
                            />
                            {fieldErrors[`member_${i}_email`] && <p className={errCls}>{fieldErrors[`member_${i}_email`]}</p>}
                          </div>
                        </div>
                        <MemberStatusBadge
                          email={m.email}
                          checks={memberChecks}
                          memberFeeCents={memberFeeCents}
                          nonMemberFeeCents={nonMemberFeeCents}
                          memberPricing={memberPricing}
                          fmt={fmtMoney}
                          onRetry={() => scheduleMemberCheck(m.email)}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* EVENTS-PROMO.1 — optional discount code. Only shown on
                  paid events (nothing to discount otherwise). No live
                  preview by design — the discounted total shows at the
                  payment step. An invalid code comes back as a 400 and
                  is surfaced inline here so the customer can retry. */}
              {showPricingCard && (
                <div className="pt-4 border-t border-white/10">
                  <label className={labelCls}>Promo code</label>
                  <input
                    type="text"
                    value={promoCode}
                    onChange={e => { setPromoCode(e.target.value); if (promoError) setPromoError(null) }}
                    placeholder="Have a code? Enter it here"
                    autoCapitalize="characters"
                    autoComplete="off"
                    className={inputCls(!!promoError)}
                  />
                  {promoError && <p className={errCls}>{promoError}</p>}
                </div>
              )}

              {/* CONSENT.4 — soft opt-in for marketing comms.
                  Defaulted on; the registration is the legitimate-
                  interest service relationship that qualifies under
                  PECR / GDPR soft opt-in. Operator-side helper
                  excludes ClassPass contacts regardless. */}
              <label className="flex items-start gap-2.5 text-[12px] text-white/55 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={marketingConsent}
                  onChange={(e) => setMarketingConsent(e.target.checked)}
                  className="mt-0.5 shrink-0 accent-white"
                />
                <span>
                  Yes, send me UN1T promotional updates and offers via email, SMS or WhatsApp.
                  You can unsubscribe at any time. Event-related notifications are sent regardless.
                </span>
              </label>

              {submitError && (
                <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-300 text-sm flex items-start gap-2">
                  <AlertCircle size={14} className="mt-0.5 shrink-0" /> {submitError}
                </div>
              )}

              <button
                type="submit"
                disabled={submitting || isClosed}
                className="lp-btn w-full mt-1 disabled:opacity-50 disabled:pointer-events-none"
              >
                {submitting && <Loader2 size={16} className="animate-spin" />}
                <span>{submitLabel}</span>
                {!submitting && <span className="lp-btn-arrow">→</span>}
              </button>
            </fieldset>
          </form>
        </div>
      </div>

      {/* ── MOBILE STICKY ACTION BAR (full page only) ─────────────── */}
      {!isClosed && !embedded && (
        <div className="md:hidden fixed inset-x-0 bottom-0 z-40 flex items-center justify-between gap-3 px-4 py-3 bg-black/85 backdrop-blur border-t border-white/10" style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}>
          <div className="shrink-0">
            <div className="text-lg font-bold text-white tabular-nums leading-none">{liveTotalLabel}</div>
          </div>
          <button
            type="submit"
            form={formId}
            disabled={submitting}
            className="lp-btn flex-1 disabled:opacity-50 disabled:pointer-events-none"
          >
            {submitting && <Loader2 size={16} className="animate-spin" />}
            <span className="truncate">{submitLabel}</span>
            {!submitting && <span className="lp-btn-arrow">→</span>}
          </button>
        </div>
      )}
    </div>
  )
}

// Per-email status pill rendered under each email input. Quiet when
// member pricing is off (no signal to give); renders the verified
// badge or a muted "non-member rate" line otherwise.
function MemberStatusBadge({ email, checks, memberFeeCents, nonMemberFeeCents, memberPricing, fmt, onRetry }) {
  if (!memberPricing) return null
  const e = (email || '').trim().toLowerCase()
  if (!e) return null
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null
  const c = checks[e]
  if (!c) return null
  if (c.state === 'checking') {
    return (
      <p className="text-[11px] text-white/50 inline-flex items-center gap-1.5 mt-1.5">
        <Loader2 size={11} className="animate-spin" /> Checking membership…
      </p>
    )
  }
  if (c.state === 'verified') {
    const fee = memberFeeCents != null ? fmt(memberFeeCents) : 'free'
    const count = Number.isFinite(c.races_finished_count) ? c.races_finished_count : null
    // Same underlying data as before (first_name + races-finished
    // count); the boxed treatment splits it into a title + subtitle.
    const title = c.first_name
      ? (count === 0 ? `Welcome, ${c.first_name}` : `Welcome back, ${c.first_name}`)
      : 'UN1T member'
    let subtitle = 'Verified member'
    if (count != null && count >= 2) {
      subtitle = `Verified member · ${count} race${count === 1 ? '' : 's'} finished`
    } else if (count === 0) {
      subtitle = 'Verified member · first race?'
    }
    return (
      <div className="mt-2 flex items-center gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-3">
        <div className="w-8 h-8 flex-none rounded-full bg-emerald-500/20 grid place-items-center">
          <BadgeCheck size={16} className="text-emerald-400" />
        </div>
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-white truncate">{title}</div>
          <div className="text-[12px] text-white/60 truncate">{subtitle}</div>
        </div>
        <div className="ml-auto text-right shrink-0">
          <div className="text-[14px] font-bold text-emerald-400">{fee}</div>
          <div className="text-[11px] text-white/45">member rate</div>
        </div>
      </div>
    )
  }
  if (c.state === 'not_member') {
    const fee = nonMemberFeeCents != null ? fmt(nonMemberFeeCents) : 'free'
    return (
      <p className="text-[11px] text-white/50 inline-flex items-center gap-1.5 mt-1.5">
        <Check size={11} /> Non-member rate · {fee}
      </p>
    )
  }
  if (c.state === 'error') {
    // Retryable (MEMRATE.1) — a failed check is not a verdict, so it
    // never claims a rate; blur retries too, this button is the
    // explicit path.
    return (
      <p className="text-[11px] text-white/50 inline-flex items-center gap-1.5 mt-1.5">
        <AlertCircle size={11} /> Couldn&apos;t check membership.
        <button
          type="button"
          onClick={onRetry}
          className="underline underline-offset-2 text-white/70 hover:text-white"
        >
          Try again
        </button>
      </p>
    )
  }
  return null
}
