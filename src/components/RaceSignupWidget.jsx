'use client'

// RaceSignupWidget — public team-first signup for a race event.
// Lives at /race/[slug]. Standalone from BookingWidget (which is
// for Calendly-style slot booking) — no calendar, no slot picking,
// just a single "what team are you, how many of you are there,
// who's competing" form.
//
// Mig 084 additions:
//   - Per-email live UN1T-member validation (debounced) so the form
//     can show "UN1T member · €X" badges and live-update the total.
//   - A prominent banner at the top telling members to use the email
//     on their UN1T account (so they aren't accidentally charged the
//     non-member rate).
//   - Pricing summary card with per-head breakdown.
//   - Members-only race handling (banner + submit-time block).
//   - Post-submit: redirect to embedded checkout for paid entries,
//     or to /race/[slug]/confirmed for free entries.

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Calendar, Clock, MapPin, AlertCircle, Loader2, Check, BadgeCheck, Info } from 'lucide-react'

export default function RaceSignupWidget({ slug }) {
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

  // Member-validation cache. Key = lower email; value =
  //   { state: 'idle'|'checking'|'verified'|'not_member', first_name?, applicable }
  const [memberChecks, setMemberChecks] = useState({})
  const checkTimers = useRef({})

  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState(null)
  const [fieldErrors, setFieldErrors] = useState({})

  // Initial load
  useEffect(() => {
    fetch(`/api/public/races/${slug}`)
      .then(r => r.json())
      .then(j => {
        if (!j.success) {
          setLoadError(j.error || 'Race not found')
          return
        }
        setRace(j.data)
        const sizes = j.data.allowed_team_sizes || [1]
        const initial = [...sizes].sort((a, b) => a - b)[0]
        setTeamSize(initial)
        const waves = Array.isArray(j.data.waves) ? j.data.waves : []
        const available = waves.filter((w) => !w.is_full)
        if (waves.length === 1 && available.length === 1) setWaveId(waves[0].id)
        else if (available.length === 1) setWaveId(available[0].id)
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
    // Already cached?
    if (memberChecks[email] && memberChecks[email].state !== 'idle') return
    // Already a timer? Reset.
    if (checkTimers.current[email]) clearTimeout(checkTimers.current[email])
    checkTimers.current[email] = setTimeout(async () => {
      setMemberChecks((prev) => ({ ...prev, [email]: { state: 'checking', applicable: true } }))
      try {
        const r = await fetch(`/api/public/races/${slug}/check-member`, {
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
              // Mig 085 follow-up: personalisation signals returned
              // alongside the membership match. null when not a member
              // OR when the lookup failed — widget falls back to the
              // generic "Welcome back" message in that case.
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
        // Silent fail — the form still works without live validation;
        // the server will re-check at submit.
        setMemberChecks((prev) => ({
          ...prev,
          [email]: { state: 'not_member', applicable: true },
        }))
      }
    }, 500)
  }

  // Roster as the live form sees it — used for pricing preview.
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

  async function handleSubmit(e) {
    e.preventDefault()
    setSubmitError(null)
    setFieldErrors({})

    const errors = {}
    if (!teamName.trim()) errors.team_name = 'Team name is required'
    if (!waveId) errors.wave_id = 'Pick a wave'
    if (!captainName.trim()) errors.captain_name = 'Your name is required'
    if (!validateEmail(captainEmail)) errors.captain_email = 'Valid email required'
    members.forEach((m, i) => {
      if (!m.name.trim()) errors[`member_${i}_name`] = 'Name required'
      if (m.email && !validateEmail(m.email)) errors[`member_${i}_email`] = 'Invalid email'
    })

    // Members-only races require everyone to validate as a member
    // before submit. The server enforces this too, but failing on the
    // client is faster + friendlier.
    if (race?.members_only) {
      const unverified = liveRoster.filter((m) => !isVerifiedMember(m.email))
      if (unverified.length > 0) {
        setSubmitError(
          `This is a members-only race. We couldn't verify membership for ${unverified.length} team member(s). Make sure everyone uses the email on their UN1T account.`
        )
        return
      }
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors)
      return
    }

    setSubmitting(true)
    const res = await fetch(`/api/public/races/${slug}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_name: teamName.trim(),
        team_size: teamSize,
        wave_id: waveId,
        captain_name: captainName.trim(),
        captain_email: captainEmail.trim().toLowerCase(),
        captain_phone: captainPhone.trim() || null,
        members: members.map((m) => ({
          name: m.name.trim(),
          email: m.email.trim() || null,
        })),
        source: 'race_signup_widget',
      }),
    })
    const json = await res.json()
    setSubmitting(false)

    if (!res.ok || json.success === false) {
      setSubmitError(json.error || `Registration failed (${res.status})`)
      return
    }

    // Free entry → straight to confirmation page. Paid → embedded
    // checkout page that owns the Revolut SDK lifecycle.
    const payment = json.data?.payment
    if (payment?.free) {
      router.push(`/race/${slug}/confirmed?registration=${json.data.registration_id}`)
    } else if (payment?.id) {
      router.push(`/race-pay/${payment.id}`)
    } else {
      // Defensive — if the API didn't return a payment id, show a
      // best-effort confirmation rather than getting stuck.
      router.push(`/race/${slug}/confirmed?registration=${json.data.registration_id}`)
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
    not_yet_open: 'Registration hasn\'t opened yet for this race.',
    closed: 'Registration has closed for this race.',
    full: 'This race is full.',
  }
  const isClosed = race.registration_state !== 'open'
  const closeMsg = closedReasons[race.registration_state]
  const showMemberNotice = !!(race.member_pricing_enabled || race.members_only)
  const showPricingCard = !!(memberPricing || nonMemberFeeCents != null)

  return (
    <div className="w-full max-w-3xl bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
      <div className="grid md:grid-cols-[260px_1fr] divide-y md:divide-y-0 md:divide-x divide-gray-200">
        {/* Race info sidebar */}
        <aside className="p-6">
          {location && (
            <div className="text-[11px] text-gray-500 uppercase tracking-wider mb-3">
              {location.name}
            </div>
          )}
          <h1 className="text-xl font-bold text-gray-900 mb-4">{race.name}</h1>
          {race.description && (
            <p className="text-sm text-gray-600 whitespace-pre-line mb-4">{race.description}</p>
          )}
          <div className="space-y-2 text-sm text-gray-700">
            <div className="flex items-center gap-2">
              <Calendar size={14} className="text-gray-400" />
              {new Date(race.race_date).toLocaleDateString('en-IE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
            </div>
            {Array.isArray(race.waves) && race.waves.length > 0 && (
              <div className="flex items-start gap-2">
                <Clock size={14} className="text-gray-400 mt-0.5 shrink-0" />
                <span>
                  {race.waves.length === 1
                    ? `Wave at ${(race.waves[0].start_time || '').slice(0, 5)}`
                    : `${race.waves.length} waves: ${race.waves.map(w => (w.start_time || '').slice(0, 5)).join(', ')}`}
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

          {/* Pricing summary card. Only shown when there's pricing
              configured (free races skip this). Updates live as
              members get verified. */}
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
          <h2 className="text-base font-semibold text-gray-900 mb-1">Register your team</h2>
          <p className="text-xs text-gray-500 mb-4">
            You&apos;re registering as the team captain. Add your team members below.
          </p>

          {/* Member-email notice. Shown whenever member pricing OR
              members-only is on — that's when using the right email
              actually matters. */}
          {showMemberNotice && (
            <div className="mb-4 p-3 bg-amber-50 border border-amber-200 text-amber-900 text-xs rounded-md inline-flex items-start gap-2">
              <Info size={14} className="mt-0.5 shrink-0 text-amber-700" />
              <span>
                <strong>UN1T members:</strong> use the email on your UN1T account so member pricing applies. We&apos;ll match each entrant&apos;s email against active member records.
                {race.members_only && ' This race is members-only — every team member must be a verified UN1T member.'}
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
              {/* Wave picker (mig 083). Compact pill grid — 3 cols on
                  mobile, 4 on tablet, 5 on desktop. Stays tidy at 10+
                  waves where the older stacked-button layout sprawled. */}
              {Array.isArray(race.waves) && race.waves.length > 0 && (
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Pick your wave *</label>
                  <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2">
                    {race.waves.map((w) => {
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

              {(race.allowed_team_sizes || []).length > 1 && (
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Team size *</label>
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
                        {s}-person
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="pt-3 border-t border-gray-200">
                <div className="text-xs text-gray-500 uppercase tracking-wider mb-2">You (team captain)</div>
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
                  <input
                    type="tel"
                    placeholder="Your phone (optional)"
                    value={captainPhone}
                    onChange={e => setCaptainPhone(e.target.value)}
                    className="w-full border border-gray-300 focus:border-gray-500 rounded-md px-3 py-2 text-sm focus:outline-none"
                  />
                </div>
              </div>

              {members.length > 0 && (
                <div className="pt-3 border-t border-gray-200">
                  <div className="text-xs text-gray-500 uppercase tracking-wider mb-2">Other team members</div>
                  <div className="space-y-3">
                    {members.map((m, i) => (
                      <div key={i} className="space-y-1">
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <input
                              type="text"
                              required
                              placeholder={`Member ${i + 2} name *`}
                              value={m.name}
                              onChange={e => setMembers(prev => prev.map((x, j) => j === i ? { ...x, name: e.target.value } : x))}
                              className={`w-full border rounded-md px-3 py-2 text-sm focus:outline-none ${fieldErrors[`member_${i}_name`] ? 'border-red-400' : 'border-gray-300 focus:border-gray-500'}`}
                            />
                            {fieldErrors[`member_${i}_name`] && <p className="text-[11px] text-red-600 mt-0.5">{fieldErrors[`member_${i}_name`]}</p>}
                          </div>
                          <div>
                            <input
                              type="email"
                              placeholder={`Member ${i + 2} email`}
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
                  ? 'Registering…'
                  : totalCents > 0
                    ? `Register and pay ${fmtMoney(totalCents)}`
                    : 'Register team'}
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
    // Personalisation: when we have a finished-race count, append it.
    // Repeat racers (≥2 finishes) get a stronger "x races" greeting;
    // first-timers (or unknown count) just get the welcome-back.
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
