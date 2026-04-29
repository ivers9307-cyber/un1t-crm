'use client'

import { useState, useEffect } from 'react'

const CHANNELS = [
  {
    key: 'email_marketing',
    label: 'Email Marketing',
    description: 'Promotions, class updates, special offers, and newsletters',
  },
  {
    key: 'email_administrative',
    label: 'Administrative Email',
    description: 'Booking confirmations, schedule changes, and account updates',
  },
  {
    key: 'whatsapp_marketing',
    label: 'WhatsApp Marketing',
    description: 'Promotions and offers via WhatsApp',
  },
  {
    key: 'whatsapp_administrative',
    label: 'Administrative WhatsApp',
    description: 'Booking reminders, schedule changes, and account updates via WhatsApp',
  },
]

export default function PreferenceCentre({ token }) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState(null)
  const [contact, setContact] = useState(null)
  const [prefs, setPrefs] = useState({})

  useEffect(() => {
    fetchPreferences()
  }, [token])

  async function fetchPreferences() {
    try {
      const res = await fetch(`/api/preferences/${token}`)
      const data = await res.json()
      if (data.success) {
        setContact(data.contact)
        setPrefs(data.preferences)
      } else {
        setError('Invalid or expired link')
      }
    } catch {
      setError('Failed to load preferences')
    } finally {
      setLoading(false)
    }
  }

  async function handleSave() {
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      const res = await fetch(`/api/preferences/${token}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(prefs),
      })
      const data = await res.json()
      if (data.success) {
        setSaved(true)
        setTimeout(() => setSaved(false), 3000)
      } else {
        setError('Failed to update preferences')
      }
    } catch {
      setError('Failed to update preferences')
    } finally {
      setSaving(false)
    }
  }

  function toggleChannel(key) {
    setPrefs(prev => ({ ...prev, [key]: !prev[key] }))
    setSaved(false)
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-un1t-black flex items-center justify-center">
        <p className="text-un1t-light">Loading preferences...</p>
      </div>
    )
  }

  if (error && !contact) {
    return (
      <div className="min-h-screen bg-un1t-black flex items-center justify-center p-4">
        <div className="w-full max-w-md text-center">
          <h1 className="text-2xl font-bold tracking-wider mb-8">UN1T</h1>
          <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-8">
            <h2 className="text-lg font-semibold text-red-400 mb-2">Link not valid</h2>
            <p className="text-sm text-un1t-light">
              This preference link is invalid or has expired. Please contact us if you need assistance.
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-un1t-black flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold tracking-wider">UN1T</h1>
          <p className="text-sm text-un1t-light mt-1">Communication Preferences</p>
        </div>

        <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-6">
          {contact && (
            <div className="mb-6 pb-4 border-b border-un1t-gray">
              <p className="text-sm text-un1t-light">
                Managing preferences for <strong className="text-un1t-white">{contact.email}</strong>
              </p>
            </div>
          )}

          <p className="text-sm text-un1t-light mb-5">
            Choose which communications you'd like to receive from us. Administrative messages may still be sent for essential account and booking information even if marketing is turned off.
          </p>

          <div className="space-y-3">
            {CHANNELS.map(ch => (
              <div
                key={ch.key}
                className="flex items-start justify-between p-4 bg-un1t-dark rounded-lg border border-un1t-gray"
              >
                <div className="flex-1 mr-4">
                  <p className="text-sm font-medium">{ch.label}</p>
                  <p className="text-xs text-un1t-mid mt-0.5">{ch.description}</p>
                </div>
                <button
                  onClick={() => toggleChannel(ch.key)}
                  className={`relative w-11 h-6 rounded-full transition-colors shrink-0 mt-0.5 ${
                    prefs[ch.key] ? 'bg-green-500' : 'bg-un1t-gray'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${
                      prefs[ch.key] ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>
            ))}
          </div>

          {error && (
            <p className="text-sm text-red-400 mt-4">{error}</p>
          )}

          {saved && (
            <p className="text-sm text-green-400 mt-4">Preferences saved successfully</p>
          )}

          <button
            onClick={handleSave}
            disabled={saving}
            className="w-full mt-6 bg-un1t-white text-un1t-black font-medium py-2.5 rounded-md hover:bg-un1t-accent transition-colors disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save Preferences'}
          </button>
        </div>

        <p className="text-xs text-un1t-mid text-center mt-6">
          Under GDPR, you have the right to control how your data is used for communication.
          All changes are logged for compliance purposes.
        </p>
      </div>
    </div>
  )
}
