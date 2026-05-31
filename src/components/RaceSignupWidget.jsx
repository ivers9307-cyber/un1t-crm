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
    headingTitle: 'Book your seat',
    headingSubtitle: "Add anyone joining you below — every seat captures a name and email.",
    captainSectionLabel: 'Your details',
    membersSectionLabel: 'Other attendees',
    sizeLabel: 'How many seats? *',
    sizeButtonSuffix: 'seat',
    submitFreeLabel: 'Book seat',
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
    headingTitle: 'Book your seat',
    headingSubtitle: "Add anyone joining you below — every seat captures a name and email.",
    captainSectionLabel: 'Your details',
    membersSectionLabel: 'Other attendees',
    sizeLabel: 'How many seats? *',
    sizeButtonSuffix: 'seat',
    submitFreeLabel: 'Book seat',
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
    headingTitle: 'Book your seat',
    headingSubtitle: "Add anyone joining you below — every seat captures a name and email.",
    captainSectionLabel: 'Your details',
    membersSectionLabel: 'Other attendees',
    sizeLabel: 'How many seats? *',
    sizeButtonSuffix: 'seat',
    submitFreeLabel: 'Book seat',
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
  //   { state: 'idle'|'checking'|'verified'|'not_member', first_name?, applicable }
  const [memberChecks, setMemberChecks] = useState({})
  const checkTimers = useRef({})

  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState(null)
  const [fieldErrors, setFieldErrors] = useState({})

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
    if (memberChecks[email] && memberChecks[email].state !== 'idle') return
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
        } else {
          setMemberChecks((prev) => ({
            ...prev,
            [email]: { state: 'not_member', applicable: false },
          }))
        }
      } catch {
        setMemberChecks((prev) => ({
          ...prev,
          [email]: { state: 'not_member', applicable: true },
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
      }),
    })
    const json = await res.json()
    setSubmitting(false)

    if (!res.ok || json.success === false) {
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
      <div className="w-full max-w-md text-center py-20">
        <AlertCircle size={36} className="mx-auto mb-3 text-red-500" />
        <p className="text-gray-700">{loadError}</p>
      </div>
    )
  }
  if (!race) {
    return (
      <div className="w-full max-w-md text-center py-20">
        <Loader2 size={28} className="mx-auto animate-spin text-gray-400" />
      </div>
    )
  }

  const location = race.locations || null
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

  return (
    <div className="w-full max-w-6xl bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
      {/* Container widened max-w-4xl → max-w-6xl and sidebar 360px →
          520px so the description (often multi-bullet workshop blurb)
          gets enough horizontal room that bullet items stay on a
          single line where reasonable. Form column still 540+px so
          inputs aren't crowded. */}
      <div className={`grid ${isLeadGen ? 'md:grid-cols-2' : 'md:grid-cols-[520px_1fr]'} divide-y md:divide-y-0 md:divide-x divide-gray-200`}>
        {/* Event info sidebar */}
        <aside className="p-6">
          {location && (
            <div className="text-[11px] text-gray-500 uppercase tracking-wider mb-3">
              {location.name}
            </div>
          )}
          <h1 className="text-2xl font-bold text-gray-900 mb-4">{race.name}</h1>
          {race.description && (
            <p className="text-base text-gray-700 whitespace-pre-line leading-relaxed mb-5">
              {race.description}
            </p>
          )}
          <div className="space-y-2 text-sm text-gray-700">
            <div className="flex items-center gap-2">
              <Calendar size={14} className="text-gray-400" />
              {!isLeadGen && race.race_date ? new Date(race.race_date).toLocaleDateString('en-IE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : null}
            </div>
            {wavesArr.length > 0 && (
              <div className="flex items-start gap-2">
                <Clock size={14} className="text-gray-400 mt-0.5 shrink-0" />
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
            {location?.address && (
              <div className="flex items-start gap-2">
                <MapPin size={14} className="text-gray-400 mt-0.5 shrink-0" />
                <span>{location.address}</span>
              </div>
            )}
          </div>

          {/* Pricing summary card. Same logic as before — kind-agnostic. */}
          {showPricingCard && (
            <div className="mt-5 p-3 rounded-md bg-gray-50 border border-gray-200">
              <div className="text-[11px] text-gray-500 uppercase tracking-wider mb-2">Total</div>
              <div className="text-2xl font-bold text-gray-900">
                {totalCents > 0 ? fmtMoney(totalCents) : 'Free'}
              </div>
              {memberPricing && (memberCount > 0 || nonMemberCount > 0) && (
                <div className="text-[11px] text-gray-600 mt-2 space-y-0.5">
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
        </aside>

        {/* Form */}
        <main className="p-6">
          <h2 className="text-base font-semibold text-gray-900 mb-1">{copy.headingTitle}</h2>
          <p className="text-xs text-gray-500 mb-4">
            {copy.headingSubtitle}
          </p>

          {showMemberNotice && (
            <div className="mb-4 p-3 bg-amber-50 border border-amber-200 text-amber-900 text-xs rounded-md inline-flex items-start gap-2">
              <Info size={14} className="mt-0.5 shrink-0 text-amber-700" />
              <span>
                <strong>UN1T members:</strong> use the email on your UN1T account so member pricing applies. We&apos;ll match each entrant&apos;s email against active member records.
                {race.members_only && copy.membersOnlyExtra}
              </span>
            </div>
          )}

          {isClosed && (
            <div className="mb-4 p-3 bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-md inline-flex items-start gap-2">
              <AlertCircle size={14} className="mt-0.5 shrink-0" /> {closeMsg}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <fieldset disabled={isClosed} className="space-y-4">
              {/* Wave picker — race-only. Non-race kinds have a single
                  auto-selected wave; the time is shown in the sidebar
                  under the date so the operator UX still surfaces it. */}
              {copy.showWavePicker && wavesArr.length > 0 && (
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Pick your wave *</label>
                  <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2">
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
                          className={`px-2 py-2 rounded-md border text-center transition-colors ${
                            selected
                              ? 'border-gray-900 bg-gray-900 text-white'
                              : full
                                ? 'border-gray-200 bg-gray-50 text-gray-400 line-through cursor-not-allowed'
                                : 'border-gray-300 hover:border-gray-500 bg-white text-gray-900'
                          }`}
                        >
                          <div className="text-sm font-semibold leading-tight">{time}</div>
                          {w.label && (
                            <div className={`text-[10px] truncate leading-tight mt-0.5 ${selected ? 'text-gray-200' : 'text-gray-500'}`}>
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
                  {fieldErrors.wave_id && <p className="text-[11px] text-red-600 mt-1">{fieldErrors.wave_id}</p>}
                </div>
              )}

              {/* Team name — race-only. Non-race kinds synthesise a
                  team_name from the captain + group size on submit. */}
              {copy.showTeamName && (
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Team name *</label>
                  <input
                    type="text"
                    required
                    value={teamName}
                    onChange={e => setTeamName(e.target.value)}
                    placeholder="The Iron Dogs"
                    className={`w-full border rounded-md px-3 py-2 text-sm focus:outline-none ${fieldErrors.team_name ? 'border-red-400' : 'border-gray-300 focus:border-gray-500'}`}
                  />
                  {fieldErrors.team_name && <p className="text-[11px] text-red-600 mt-1">{fieldErrors.team_name}</p>}
                </div>
              )}

              {(race.allowed_team_sizes || []).length > 1 && (
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">{copy.sizeLabel}</label>
                  <div className="flex flex-wrap gap-2">
                    {[...(race.allowed_team_sizes || [])].sort((a, b) => a - b).map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setTeamSize(s)}
                        className={`text-xs px-3 py-2 rounded-md border ${
                          teamSize === s
                            ? 'border-gray-700 bg-gray-100 text-gray-900 font-semibold'
                            : 'border-gray-300 bg-white text-gray-600 hover:border-gray-400'
                        }`}
                      >
                        {s}-{copy.sizeButtonSuffix}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="pt-3 border-t border-gray-200">
                <div className="text-xs text-gray-500 uppercase tracking-wider mb-2">{copy.captainSectionLabel}</div>
                <div className="space-y-2">
                  <input
                    type="text"
                    required
                    placeholder="Your name *"
                    value={captainName}
                    onChange={e => setCaptainName(e.target.value)}
                    className={`w-full border rounded-md px-3 py-2 text-sm focus:outline-none ${fieldErrors.captain_name ? 'border-red-400' : 'border-gray-300 focus:border-gray-500'}`}
                  />
                  {fieldErrors.captain_name && <p className="text-[11px] text-red-600">{fieldErrors.captain_name}</p>}
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
                      className={`w-full border rounded-md px-3 py-2 text-sm focus:outline-none ${fieldErrors.captain_email ? 'border-red-400' : 'border-gray-300 focus:border-gray-500'}`}
                    />
                    <MemberStatusBadge
                      email={captainEmail}
                      checks={memberChecks}
                      memberFeeCents={memberFeeCents}
                      nonMemberFeeCents={nonMemberFeeCents}
                      memberPricing={memberPricing}
                      fmt={fmtMoney}
                    />
                    {fieldErrors.captain_email && <p className="text-[11px] text-red-600 mt-0.5">{fieldErrors.captain_email}</p>}
                  </div>
                  <div>
                    <input
                      type="tel"
                      required
                      placeholder="Your phone *"
                      value={captainPhone}
                      onChange={e => setCaptainPhone(e.target.value)}
                      className={`w-full border rounded-md px-3 py-2 text-sm focus:outline-none ${fieldErrors.captain_phone ? 'border-red-400' : 'border-gray-300 focus:border-gray-500'}`}
                    />
                    {fieldErrors.captain_phone && <p className="text-[11px] text-red-600 mt-0.5">{fieldErrors.captain_phone}</p>}
                  </div>
                </div>
              </div>

              {members.length > 0 && (
                <div className="pt-3 border-t border-gray-200">
                  <div className="text-xs text-gray-500 uppercase tracking-wider mb-2">{copy.membersSectionLabel}</div>
                  <div className="space-y-3">
                    {members.map((m, i) => (
                      <div key={i} className="space-y-1">
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <input
                              type="text"
                              required
                              placeholder={`${kind === 'race' ? 'Member' : 'Attendee'} ${i + 2} name *`}
                              value={m.name}
                              onChange={e => setMembers(prev => prev.map((x, j) => j === i ? { ...x, name: e.target.value } : x))}
                              className={`w-full border rounded-md px-3 py-2 text-sm focus:outline-none ${fieldErrors[`member_${i}_name`] ? 'border-red-400' : 'border-gray-300 focus:border-gray-500'}`}
                            />
                            {fieldErrors[`member_${i}_name`] && <p className="text-[11px] text-red-600 mt-0.5">{fieldErrors[`member_${i}_name`]}</p>}
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
                              className={`w-full border rounded-md px-3 py-2 text-sm focus:outline-none ${fieldErrors[`member_${i}_email`] ? 'border-red-400' : 'border-gray-300 focus:border-gray-500'}`}
                            />
                            {fieldErrors[`member_${i}_email`] && <p className="text-[11px] text-red-600 mt-0.5">{fieldErrors[`member_${i}_email`]}</p>}
                          </div>
                        </div>
                        <MemberStatusBadge
                          email={m.email}
                          checks={memberChecks}
                          memberFeeCents={memberFeeCents}
                          nonMemberFeeCents={nonMemberFeeCents}
                          memberPricing={memberPricing}
                          fmt={fmtMoney}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* CONSENT.4 — soft opt-in for marketing comms.
                  Defaulted on; the registration is the legitimate-
                  interest service relationship that qualifies under
                  PECR / GDPR soft opt-in. Operator-side helper
                  excludes ClassPass contacts regardless. */}
              <label className="flex items-start gap-2 text-xs text-gray-600 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={marketingConsent}
                  onChange={(e) => setMarketingConsent(e.target.checked)}
                  className="mt-0.5 shrink-0"
                />
                <span>
                  Yes, send me UN1T promotional updates and offers via email, SMS or WhatsApp.
                  You can unsubscribe at any time. Event-related notifications are sent regardless.
                </span>
              </label>

              {submitError && (
                <div className="p-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-md inline-flex items-start gap-2">
                  <AlertCircle size={14} className="mt-0.5 shrink-0" /> {submitError}
                </div>
              )}

              <button
                type="submit"
                disabled={submitting || isClosed}
                className="w-full bg-gray-900 hover:bg-gray-800 text-white font-semibold py-2.5 rounded-md disabled:opacity-50 inline-flex items-center justify-center gap-2"
              >
                {submitting ? <Loader2 size={14} className="animate-spin" /> : null}
                {submitting
                  ? 'Submitting…'
                  : totalCents > 0
                    ? copy.submitPaidLabel(fmtMoney(totalCents))
                    : copy.submitFreeLabel}
              </button>
            </fieldset>
          </form>
        </main>
      </div>
    </div>
  )
}

// Per-email status pill rendered under each email input. Quiet when
// member pricing is off (no signal to give); renders the verified
// badge or a muted "non-member rate" line otherwise.
function MemberStatusBadge({ email, checks, memberFeeCents, nonMemberFeeCents, memberPricing, fmt }) {
  if (!memberPricing) return null
  const e = (email || '').trim().toLowerCase()
  if (!e) return null
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null
  const c = checks[e]
  if (!c) return null
  if (c.state === 'checking') {
    return (
      <p className="text-[11px] text-gray-500 inline-flex items-center gap-1 mt-0.5">
        <Loader2 size={10} className="animate-spin" /> Checking membership…
      </p>
    )
  }
  if (c.state === 'verified') {
    const fee = memberFeeCents != null ? fmt(memberFeeCents) : 'free'
    const count = Number.isFinite(c.races_finished_count) ? c.races_finished_count : null
    let greeting = c.first_name ? ` — welcome back, ${c.first_name}` : ''
    if (count != null && count >= 2) {
      greeting = c.first_name
        ? ` — welcome back, ${c.first_name} · ${count} race${count === 1 ? '' : 's'} finished`
        : ` — ${count} race${count === 1 ? '' : 's'} finished`
    } else if (count === 0 && c.first_name) {
      greeting = ` — welcome, ${c.first_name} · first race?`
    }
    return (
      <p className="text-[11px] text-emerald-700 inline-flex items-center gap-1 mt-0.5">
        <BadgeCheck size={11} /> UN1T member{greeting} · {fee}
      </p>
    )
  }
  if (c.state === 'not_member') {
    const fee = nonMemberFeeCents != null ? fmt(nonMemberFeeCents) : 'free'
    return (
      <p className="text-[11px] text-gray-500 inline-flex items-center gap-1 mt-0.5">
        <Check size={11} /> Non-member rate · {fee}
      </p>
    )
  }
  return null
}
