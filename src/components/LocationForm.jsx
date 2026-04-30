'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'

export default function LocationForm({ location }) {
  const router = useRouter()
  const isEditing = !!location

  const [name, setName] = useState(location?.name || '')
  const [address, setAddress] = useState(location?.address || '')
  const [phone, setPhone] = useState(location?.phone || '')
  const [email, setEmail] = useState(location?.email || '')
  const [timezone, setTimezone] = useState(location?.timezone || 'Europe/Dublin')
  const [country, setCountry] = useState(location?.country || 'IE')
  const [active, setActive] = useState(location?.active !== false)

  // Integration settings
  const settings = location?.settings || {}
  const [glofoxBranchId, setGlofoxBranchId] = useState(settings.glofox?.branch_id || '')
  const [glofoxApiKey, setGlofoxApiKey] = useState(settings.glofox?.api_key || '')

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  async function handleSubmit(e) {
    e.preventDefault()
    setSaving(true)
    setError(null)

    const db = createBrowserClient()
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')

    const payload = {
      name,
      slug,
      address: address || null,
      phone: phone || null,
      email: email || null,
      timezone,
      country,
      active,
      settings: {
        ...(settings || {}),
        glofox: glofoxBranchId || glofoxApiKey ? {
          branch_id: glofoxBranchId || null,
          api_key: glofoxApiKey || null,
        } : null,
      },
      updated_at: new Date().toISOString(),
    }

    let result
    if (isEditing) {
      result = await db.from('locations').update(payload).eq('id', location.id).select().single()
    } else {
      result = await db.from('locations').insert(payload).select().single()
    }

    if (result.error) {
      setError(result.error.message)
      setSaving(false)
      return
    }

    // Seed default pipeline stages for new locations
    if (!isEditing && result.data?.id) {
      const defaultStages = [
        { name: 'New Lead',           slug: 'new_lead',          display_order: 1, color: '#3B82F6' },
        { name: 'New Lead — Social',  slug: 'new_lead_social',   display_order: 2, color: '#8B5CF6' },
        { name: 'Trial Active',       slug: 'trial_active',      display_order: 3, color: '#10B981' },
        { name: 'Conversion Ready',   slug: 'conversion_ready',  display_order: 4, color: '#F59E0B' },
        { name: 'Follow-up Needed',   slug: 'follow_up_needed',  display_order: 5, color: '#EF4444' },
        { name: 'Member',             slug: 'member',            display_order: 6, color: '#059669' },
        { name: 'Cold — Email Only',  slug: 'cold_email_only',   display_order: 7, color: '#9CA3AF' },
        { name: 'Lost Member',        slug: 'lost_member',       display_order: 8, color: '#DC2626' },
        { name: 'Returning Member',   slug: 'returning_member',  display_order: 9, color: '#6366F1' },
      ].map(s => ({ ...s, location_id: result.data.id }))

      await db.from('pipeline_stages').insert(defaultStages)
    }

    router.push('/settings')
    router.refresh()
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-sm rounded-lg p-3">
          {error}
        </div>
      )}

      {/* Basic Info */}
      <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5 space-y-4">
        <h3 className="font-semibold text-sm text-un1t-light uppercase tracking-wider">Location Details</h3>

        <div>
          <label className="block text-sm mb-1.5">Name *</label>
          <input
            type="text"
            required
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="UN1T Dublin City"
            className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid"
          />
        </div>

        <div>
          <label className="block text-sm mb-1.5">Address</label>
          <input
            type="text"
            value={address}
            onChange={e => setAddress(e.target.value)}
            placeholder="123 Example St, Dublin 2"
            className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm mb-1.5">Phone</label>
            <input
              type="text"
              value={phone}
              onChange={e => setPhone(e.target.value)}
              placeholder="+353 1 234 5678"
              className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid"
            />
          </div>
          <div>
            <label className="block text-sm mb-1.5">Email</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="info@un1t.ie"
              className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm mb-1.5">Country</label>
            <select
              value={country}
              onChange={e => setCountry(e.target.value)}
              className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
            >
              <option value="IE">Ireland (IE)</option>
              <option value="GB">United Kingdom (GB)</option>
              <option value="US">United States (US)</option>
              <option value="DE">Germany (DE)</option>
              <option value="FR">France (FR)</option>
              <option value="ES">Spain (ES)</option>
              <option value="NL">Netherlands (NL)</option>
            </select>
            <p className="text-xs text-un1t-mid mt-1">Drives public-holiday list on the schedule. Currently only Ireland has built-in holidays — others can still add custom holidays.</p>
          </div>
          <div>
            <label className="block text-sm mb-1.5">Timezone</label>
            <select
              value={timezone}
              onChange={e => setTimezone(e.target.value)}
              className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
            >
              <option value="Europe/Dublin">Europe/Dublin</option>
              <option value="Europe/London">Europe/London</option>
              <option value="Europe/Berlin">Europe/Berlin</option>
              <option value="Europe/Paris">Europe/Paris</option>
              <option value="Europe/Madrid">Europe/Madrid</option>
              <option value="Europe/Amsterdam">Europe/Amsterdam</option>
              <option value="America/New_York">America/New_York</option>
              <option value="America/Los_Angeles">America/Los_Angeles</option>
            </select>
          </div>
        </div>

        {isEditing && (
          <div>
            <label className="block text-sm mb-1.5">Status</label>
            <button
              type="button"
              onClick={() => setActive(!active)}
              className={`px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                active ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'
              }`}
            >
              {active ? 'Active' : 'Inactive'}
            </button>
          </div>
        )}
      </div>

      {/* Glofox Integration */}
      <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5 space-y-4">
        <h3 className="font-semibold text-sm text-un1t-light uppercase tracking-wider">Glofox Integration</h3>
        <p className="text-xs text-un1t-mid">Connect this location to its own Glofox branch for member syncing</p>

        <div>
          <label className="block text-sm mb-1.5">Branch ID</label>
          <input
            type="text"
            value={glofoxBranchId}
            onChange={e => setGlofoxBranchId(e.target.value)}
            placeholder="your-glofox-branch-id"
            className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid font-mono"
          />
        </div>

        <div>
          <label className="block text-sm mb-1.5">API Key</label>
          <input
            type="password"
            value={glofoxApiKey}
            onChange={e => setGlofoxApiKey(e.target.value)}
            placeholder="••••••••••••••••"
            className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white placeholder:text-un1t-mid focus:outline-none focus:border-un1t-mid font-mono"
          />
        </div>
      </div>

      {/* Submit */}
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={saving}
          className="bg-un1t-white text-un1t-black text-sm font-medium px-5 py-2.5 rounded-md hover:bg-un1t-accent transition-colors disabled:opacity-50"
        >
          {saving ? 'Saving...' : isEditing ? 'Update Location' : 'Create Location'}
        </button>
        <button
          type="button"
          onClick={() => router.push('/settings')}
          className="text-sm text-un1t-light hover:text-un1t-white transition-colors px-4 py-2.5"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}
