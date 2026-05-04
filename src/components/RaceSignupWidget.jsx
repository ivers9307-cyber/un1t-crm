'use client'

// RaceSignupWidget — public team-first signup for a race event.
// Lives at /race/[slug]. Standalone from BookingWidget (which is
// for Calendly-style slot booking) — no calendar, no slot picking,
// just a single "what team are you, how many of you are there,
// who's competing" form.
//
// Flow:
//   1. Fetch /api/public/races/[slug] for race details + state
//   2. Render race info + team capture form
//   3. POST to /api/public/races/[slug]/register with team data
//   4. Show post-signup confirmation card

import { useEffect, useState } from 'react'
import { Calendar, Clock, MapPin, Users, AlertCircle, Check, Loader2 } from 'lucide-react'

export default function RaceSignupWidget({ slug }) {
  const [race, setRace] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [submitted, setSubmitted] = useState(null)

  // Form state
  const [teamName, setTeamName] = useState('')
  const [teamSize, setTeamSize] = useState(1)
  const [members, setMembers] = useState([])
  const [captainName, setCaptainName] = useState('')
  const [captainEmail, setCaptainEmail] = useState('')
  const [captainPhone, setCaptainPhone] = useState('')

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
        // Default the team-size radio to the smallest allowed size.
        const sizes = j.data.allowed_team_sizes || [1]
        const initial = [...sizes].sort((a, b) => a - b)[0]
        setTeamSize(initial)
      })
      .catch(e => setLoadError(e.message || 'Network error'))
  }, [slug])

  // When team_size changes, reshape the members array.
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

  async function handleSubmit(e) {
    e.preventDefault()
    setSubmitError(null)
    setFieldErrors({})

    const errors = {}
    if (!teamName.trim()) errors.team_name = 'Team name is required'
    if (!captainName.trim()) errors.captain_name = 'Your name is required'
    if (!validateEmail(captainEmail)) errors.captain_email = 'Valid email required'
    members.forEach((m, i) => {
      if (!m.name.trim()) errors[`member_${i}_name`] = 'Name required'
      if (m.email && !validateEmail(m.email)) errors[`member_${i}_email`] = 'Invalid email'
    })
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
    setSubmitted(json.data)
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

  if (submitted) {
    return (
      <div className="w-full max-w-xl bg-white rounded-2xl border border-gray-200 shadow-sm p-8">
        <div className="text-center">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-emerald-50 text-emerald-600 mb-4">
            <Check size={24} />
          </div>
          <h2 className="text-xl font-semibold text-gray-900 mb-1">
            Team registered!
          </h2>
          <p className="text-sm text-gray-600 mb-1">
            <span className="font-medium">{submitted.team_name}</span> is in for {race.name}.
          </p>
          <p className="text-xs text-gray-500">
            Confirmation email coming to {captainEmail}.
          </p>
        </div>
      </div>
    )
  }

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
            {race.start_time && (
              <div className="flex items-center gap-2">
                <Clock size={14} className="text-gray-400" />
                First wave at {race.start_time.slice(0, 5)}
              </div>
            )}
            {location?.address && (
              <div className="flex items-start gap-2">
                <MapPin size={14} className="text-gray-400 mt-0.5 shrink-0" />
                <span>{location.address}</span>
              </div>
            )}
            {race.capacity != null && (
              <div className="flex items-center gap-2">
                <Users size={14} className="text-gray-400" />
                {race.remaining_capacity ?? race.capacity} of {race.capacity} spots remaining
              </div>
            )}
          </div>
        </aside>

        {/* Form */}
        <main className="p-6">
          <h2 className="text-base font-semibold text-gray-900 mb-1">Register your team</h2>
          <p className="text-xs text-gray-500 mb-4">
            You&apos;re registering as the team captain. Add your team members below.
          </p>

          {isClosed && (
            <div className="mb-4 p-3 bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-md inline-flex items-start gap-2">
              <AlertCircle size={14} className="mt-0.5 shrink-0" /> {closeMsg}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <fieldset disabled={isClosed} className="space-y-4">
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
                  <input
                    type="email"
                    required
                    placeholder="Your email *"
                    value={captainEmail}
                    onChange={e => setCaptainEmail(e.target.value)}
                    className={`w-full border rounded-md px-3 py-2 text-sm focus:outline-none ${fieldErrors.captain_email ? 'border-red-400' : 'border-gray-300 focus:border-gray-500'}`}
                  />
                  {fieldErrors.captain_email && <p className="text-[11px] text-red-600">{fieldErrors.captain_email}</p>}
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
                  <div className="space-y-2">
                    {members.map((m, i) => (
                      <div key={i} className="grid grid-cols-2 gap-2">
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
                            onChange={e => setMembers(prev => prev.map((x, j) => j === i ? { ...x, email: e.target.value } : x))}
                            className={`w-full border rounded-md px-3 py-2 text-sm focus:outline-none ${fieldErrors[`member_${i}_email`] ? 'border-red-400' : 'border-gray-300 focus:border-gray-500'}`}
                          />
                          {fieldErrors[`member_${i}_email`] && <p className="text-[11px] text-red-600 mt-0.5">{fieldErrors[`member_${i}_email`]}</p>}
                        </div>
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
                {submitting ? 'Registering…' : 'Register team'}
              </button>
            </fieldset>
          </form>
        </main>
      </div>
    </div>
  )
}
