'use client'

// LOCCOMMS.4 — the preference centre, rebuilt around per-location lists.
//
// Each UN1T location is a standalone business. Leaving the Hatch Street list
// must not remove someone from Stillorgan's, and the only way that reads as
// deliberate rather than broken is to SHOW people which lists they are on and
// let them leave one at a time.
//
// The "leave everything" control at the bottom is not politeness. Someone who
// wants out entirely and cannot find how will press the spam button instead,
// and complaints damage the sending domain every location shares.
//
// Styling follows the public site (un1tdublin.com), not the staff CRM: black
// ground, Poppins display type, the one white pill button. This page is reached
// from a marketing email, so landing on the CRM's light admin theme reads as a
// different company. Tokens mirror WaitlistWidget/globals.css.

import { useState, useEffect, useCallback } from 'react'

// Channels shown per location list. Marketing only — administrative mail
// (booking confirmations, reminders) follows the transaction rather than a
// list, stays global, and is handled below on its own terms.
const LIST_CHANNELS = [
  { key: 'email_marketing',    label: 'Email',    description: 'Offers, class news and updates' },
  { key: 'whatsapp_marketing', label: 'WhatsApp', description: 'Offers and updates on WhatsApp' },
  { key: 'sms_marketing',      label: 'Text',     description: 'Offers and updates by text' },
]

const CARD = 'bg-white/[0.06] border border-white/15 rounded-2xl'

function Toggle({ on, onClick, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`relative w-12 h-7 rounded-full shrink-0 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60 ${
        on ? 'bg-white' : 'bg-white/20'
      }`}
    >
      <span
        className={`absolute top-1 left-1 w-5 h-5 rounded-full transition-transform ${
          on ? 'translate-x-5 bg-black' : 'translate-x-0 bg-white/70'
        }`}
      />
    </button>
  )
}

export default function PreferenceCentre({ token }) {
  const [loading, setLoading] = useState(true)
  const [savingId, setSavingId] = useState(null)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState(null)
  const [contact, setContact] = useState(null)
  const [lists, setLists] = useState([])

  const fetchPreferences = useCallback(async () => {
    try {
      const res = await fetch(`/api/preferences/${token}`)
      const data = await res.json()
      if (data.success) {
        setContact(data.contact)
        setLists(data.lists || [])
      } else {
        setError('This link is no longer valid.')
      }
    } catch {
      setError('We couldn’t load your preferences. Please try again.')
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => { fetchPreferences() }, [fetchPreferences])

  async function save(locationId, patch) {
    setSavingId(locationId || 'all')
    setSaved(false)
    setError(null)
    try {
      const res = await fetch(`/api/preferences/${token}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(locationId ? { locationId } : {}), ...patch }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.success === false) throw new Error()
      setSaved(true)
    } catch {
      setError('We couldn’t save that. Please try again.')
      await fetchPreferences()   // resync so the UI never lies about what's stored
    } finally {
      setSavingId(null)
    }
  }

  function toggle(list, key) {
    const next = !list[key]
    setLists((prev) => prev.map((l) => (l.locationId === list.locationId ? { ...l, [key]: next } : l)))
    save(list.locationId, { [key]: next })
  }

  async function leaveEverything() {
    setLists((prev) => prev.map((l) => ({
      ...l, email_marketing: false, whatsapp_marketing: false, sms_marketing: false,
    })))
    await save(null, { email_marketing: false, whatsapp_marketing: false, sms_marketing: false })
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <p className="text-white/40 text-sm">Loading…</p>
      </div>
    )
  }

  if (error && !contact) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center p-6">
        <div className={`${CARD} w-full max-w-md p-8 text-center`}>
          <h1 className="font-display font-extrabold uppercase tracking-wide text-2xl text-white mb-3">
            Link expired
          </h1>
          <p className="text-white/60 text-sm leading-relaxed">
            This preferences link is no longer valid. If you’d like to update how we contact
            you, reply to any email from us and we’ll sort it.
          </p>
        </div>
      </div>
    )
  }

  const stillOnSomething = lists.some(
    (l) => l.email_marketing || l.whatsapp_marketing || l.sms_marketing,
  )

  return (
    <div className="min-h-screen bg-black text-white px-5 py-14 sm:py-20">
      <div className="w-full max-w-xl mx-auto">
        <header className="mb-10">
          <p className="font-display font-extrabold uppercase tracking-[0.2em] text-xs text-white/40 mb-4">
            UN1T
          </p>
          <h1 className="font-display font-extrabold uppercase tracking-wide text-3xl sm:text-4xl leading-[1.05] mb-4">
            Your preferences
          </h1>
          {contact?.email && (
            <p className="text-white/50 text-sm">
              For <span className="text-white/80">{contact.email}</span>
            </p>
          )}
        </header>

        {lists.length > 1 && (
          <p className="text-white/60 text-sm leading-relaxed mb-6">
            Each of our studios sends its own updates. Turning something off here only affects
            that studio — you’ll still hear from the others unless you turn those off too.
          </p>
        )}

        <div className="space-y-4">
          {lists.map((list) => (
            <section key={list.locationId} className={`${CARD} p-6`}>
              <h2 className="font-display font-extrabold uppercase tracking-wide text-lg mb-5">
                {list.locationName}
              </h2>
              <div className="space-y-4">
                {LIST_CHANNELS.map((ch) => (
                  <div key={ch.key} className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="text-sm text-white/90">{ch.label}</p>
                      <p className="text-xs text-white/40 mt-0.5 leading-relaxed">{ch.description}</p>
                    </div>
                    <Toggle
                      on={!!list[ch.key]}
                      onClick={() => toggle(list, ch.key)}
                      label={`${ch.label} from ${list.locationName}`}
                    />
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>

        {lists.length === 0 && (
          <div className={`${CARD} p-6`}>
            <p className="text-white/60 text-sm leading-relaxed">
              You’re not on any of our marketing lists right now.
            </p>
          </div>
        )}

        <p className="text-white/40 text-xs leading-relaxed mt-6">
          We’ll still send things you’ve asked for — booking confirmations, class reminders and
          account updates. Those aren’t marketing and aren’t affected by the switches above.
        </p>

        <div className="mt-10 pt-8 border-t border-white/10">
          {stillOnSomething ? (
            <>
              <p className="text-white/60 text-sm mb-4">Want to stop hearing from us entirely?</p>
              <button
                type="button"
                onClick={leaveEverything}
                disabled={savingId === 'all'}
                className="lp-btn-ghost w-full sm:w-auto disabled:opacity-60"
              >
                {savingId === 'all' ? 'Saving…' : 'Unsubscribe from everything'}
              </button>
            </>
          ) : (
            <p className="text-white/50 text-sm">
              You’re unsubscribed from all UN1T marketing. Turn any switch back on above if you
              change your mind.
            </p>
          )}
        </div>

        <div className="mt-8 min-h-[1.25rem]" aria-live="polite">
          {error && <p className="text-sm text-red-300">{error}</p>}
          {saved && !error && <p className="text-sm text-white/50">Saved.</p>}
        </div>
      </div>
    </div>
  )
}
