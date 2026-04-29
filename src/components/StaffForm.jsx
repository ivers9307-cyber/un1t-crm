'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

const allPermissions = [
  { key: 'dashboard',  label: 'Dashboard' },
  { key: 'pipeline',   label: 'Pipeline & Deals' },
  { key: 'contacts',   label: 'Contacts' },
  { key: 'events',     label: 'Events' },
  { key: 'bookings',   label: 'Bookings' },
  { key: 'activities', label: 'Activities' },
  { key: 'settings',   label: 'Settings & Staff Management' },
]

const defaultPermissions = {
  dashboard: true, pipeline: true, contacts: true,
  events: true, bookings: true, activities: true, settings: false,
}

export default function StaffForm({ staff, locations }) {
  const isEdit = !!staff
  const router = useRouter()

  const [form, setForm] = useState({
    full_name: staff?.full_name || '',
    email: staff?.email || '',
    password: '',
    role: staff?.role || 'staff',
    active: staff?.active ?? true,
    location_ids: staff?.location_ids || locations.map(l => l.id),
    permissions: staff?.permissions || { ...defaultPermissions },
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  function togglePermission(key) {
    setForm(prev => ({
      ...prev,
      permissions: { ...prev.permissions, [key]: !prev.permissions[key] },
    }))
  }

  function toggleLocation(locId) {
    setForm(prev => ({
      ...prev,
      location_ids: prev.location_ids.includes(locId)
        ? prev.location_ids.filter(id => id !== locId)
        : [...prev.location_ids, locId],
    }))
  }

  function setAllPermissions(on) {
    const perms = {}
    allPermissions.forEach(p => { perms[p.key] = on })
    setForm(prev => ({ ...prev, permissions: perms }))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    setSaving(true)

    const url = isEdit ? `/api/staff/${staff.id}` : '/api/staff'
    const method = isEdit ? 'PUT' : 'POST'

    const payload = {
      full_name: form.full_name,
      role: form.role,
      permissions: form.permissions,
      location_ids: form.location_ids,
      active: form.active,
    }

    if (!isEdit) {
      payload.email = form.email
      payload.password = form.password
    }

    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    const data = await res.json()
    setSaving(false)

    if (data.success) {
      router.push('/settings')
      router.refresh()
    } else {
      setError(data.error || 'Failed to save')
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <Link href="/settings" className="inline-flex items-center gap-1.5 text-sm text-un1t-light hover:text-white">
        <ArrowLeft size={16} /> Back to Settings
      </Link>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 text-sm rounded-lg p-3">
          {error}
        </div>
      )}

      {/* Basic Info */}
      <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5 space-y-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light">Account Details</h3>

        <div>
          <label className="block text-sm text-un1t-light mb-1">Full Name *</label>
          <input
            type="text"
            required
            value={form.full_name}
            onChange={e => setForm(prev => ({ ...prev, full_name: e.target.value }))}
            className="w-full bg-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:border-white/40"
          />
        </div>

        <div>
          <label className="block text-sm text-un1t-light mb-1">Email *</label>
          <input
            type="email"
            required
            disabled={isEdit}
            value={form.email}
            onChange={e => setForm(prev => ({ ...prev, email: e.target.value }))}
            className="w-full bg-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:border-white/40 disabled:opacity-50"
          />
        </div>

        {!isEdit && (
          <div>
            <label className="block text-sm text-un1t-light mb-1">Password *</label>
            <input
              type="password"
              required
              minLength={8}
              value={form.password}
              onChange={e => setForm(prev => ({ ...prev, password: e.target.value }))}
              className="w-full bg-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:border-white/40"
              placeholder="Min 8 characters"
            />
          </div>
        )}

        <div>
          <label className="block text-sm text-un1t-light mb-1">Role</label>
          <select
            value={form.role}
            onChange={e => setForm(prev => ({ ...prev, role: e.target.value }))}
            className="w-full bg-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:border-white/40"
          >
            <option value="staff">Staff</option>
            <option value="manager">Manager</option>
            <option value="owner">Owner / Admin</option>
          </select>
        </div>

        {isEdit && (
          <div className="flex items-center gap-3">
            <label className="text-sm text-un1t-light">Active</label>
            <button
              type="button"
              onClick={() => setForm(prev => ({ ...prev, active: !prev.active }))}
              className={`w-10 h-5 rounded-full transition-colors ${form.active ? 'bg-green-500' : 'bg-un1t-gray'}`}
            >
              <div className={`w-4 h-4 rounded-full bg-white transition-transform ${form.active ? 'translate-x-5' : 'translate-x-0.5'}`} />
            </button>
          </div>
        )}
      </div>

      {/* Locations */}
      <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light mb-3">Location Access</h3>
        <div className="space-y-2">
          {locations.map(loc => (
            <label key={loc.id} className="flex items-center gap-3 py-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={form.location_ids.includes(loc.id)}
                onChange={() => toggleLocation(loc.id)}
                className="rounded border-un1t-gray"
              />
              <span className="text-sm">{loc.name}</span>
              <span className="text-xs text-un1t-light">{loc.slug}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Permissions */}
      <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light">Feature Permissions</h3>
          <div className="flex gap-2">
            <button type="button" onClick={() => setAllPermissions(true)} className="text-xs text-blue-400 hover:text-blue-300">All on</button>
            <span className="text-un1t-mid">·</span>
            <button type="button" onClick={() => setAllPermissions(false)} className="text-xs text-blue-400 hover:text-blue-300">All off</button>
          </div>
        </div>
        <div className="space-y-2">
          {allPermissions.map(perm => (
            <label key={perm.key} className="flex items-center justify-between py-1.5 cursor-pointer">
              <span className="text-sm">{perm.label}</span>
              <button
                type="button"
                onClick={() => togglePermission(perm.key)}
                className={`w-10 h-5 rounded-full transition-colors ${form.permissions[perm.key] ? 'bg-green-500' : 'bg-un1t-gray'}`}
              >
                <div className={`w-4 h-4 rounded-full bg-white transition-transform ${form.permissions[perm.key] ? 'translate-x-5' : 'translate-x-0.5'}`} />
              </button>
            </label>
          ))}
        </div>
      </div>

      <button
        type="submit"
        disabled={saving}
        className="w-full bg-white text-black font-medium text-sm py-2.5 rounded-md hover:bg-gray-200 transition-colors disabled:opacity-50"
      >
        {saving ? 'Saving...' : isEdit ? 'Save Changes' : 'Create Team Member'}
      </button>
    </form>
  )
}
