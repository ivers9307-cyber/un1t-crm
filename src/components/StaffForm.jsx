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
  { key: 'email',      label: 'Email Marketing' },
  { key: 'whatsapp',   label: 'WhatsApp' },
  { key: 'schedule',   label: 'Schedule' },
  { key: 'assistant',  label: 'AI Assistant' },
  { key: 'settings',   label: 'Settings & Staff Management' },
]

const defaultPermissionsByRole = {
  staff: {
    dashboard: true, pipeline: true, contacts: true,
    events: true, bookings: true, activities: true,
    email: false, whatsapp: false, schedule: true, assistant: false, settings: false,
  },
  head_coach: {
    dashboard: true, pipeline: true, contacts: true,
    events: true, bookings: true, activities: true,
    email: true, whatsapp: true, schedule: true, assistant: true, settings: false,
  },
  manager: {
    dashboard: true, pipeline: true, contacts: true,
    events: true, bookings: true, activities: true,
    email: true, whatsapp: true, schedule: true, assistant: true, settings: true,
  },
  owner: {
    dashboard: true, pipeline: true, contacts: true,
    events: true, bookings: true, activities: true,
    email: true, whatsapp: true, schedule: true, assistant: true, settings: true,
  },
}

const defaultPermissions = defaultPermissionsByRole.staff

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
    // HR fields
    employment_type: staff?.employment_type || 'fte',
    annual_salary: staff?.annual_salary || '',
    hourly_rate: staff?.hourly_rate || '',
    contracted_hours_per_week: staff?.contracted_hours_per_week ?? 40,
    annual_leave_entitlement: staff?.annual_leave_entitlement ?? 20,
    overtime_rate: staff?.overtime_rate || '',
    // UniFi door access — only meaningful in edit mode (need a saved
    // profile + existing location assignment for the server-side sync).
    unifi_door_access: staff?.unifi_door_access ?? false,
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  // Door-access toggle context. Picks the same "default" location the
  // server uses (first in the list) and checks whether that location has
  // UniFi configured. If not, the toggle is disabled with a hint.
  const doorLocation = locations.find(l => form.location_ids.includes(l.id)) || null
  const unifiCfg = doorLocation?.settings?.unifi || {}
  const unifiConfigured = Boolean(
    unifiCfg.host && unifiCfg.api_token &&
    unifiCfg.staff_policy_id && unifiCfg.manager_policy_id
  )
  const isManagerRole = form.role === 'owner' || form.role === 'manager'

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
      employment_type: form.employment_type,
      annual_salary: form.employment_type === 'fte' && form.annual_salary ? Number(form.annual_salary) : null,
      hourly_rate: form.employment_type === 'contractor' && form.hourly_rate ? Number(form.hourly_rate) : null,
      contracted_hours_per_week: form.employment_type === 'fte' ? Number(form.contracted_hours_per_week) : null,
      annual_leave_entitlement: form.employment_type === 'fte' ? Number(form.annual_leave_entitlement) : null,
      overtime_rate: form.employment_type === 'fte' && form.overtime_rate ? Number(form.overtime_rate) : null,
    }

    // Only send the UniFi toggle on edit. Create flow doesn't have a
    // saved profile / location assignment yet; door access is enabled
    // post-save once the staffer is set up.
    if (isEdit) {
      payload.unifi_door_access = form.unifi_door_access
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
      // Surface per-field validation issues (Zod) so we can see exactly which
      // field tripped — not just "Invalid request body".
      const issues = Array.isArray(data.issues) && data.issues.length
        ? data.issues.map(i => `${i.path || '(root)'}: ${i.message}`).join('; ')
        : null
      setError(issues ? `${data.error || 'Failed to save'} — ${issues}` : (data.error || 'Failed to save'))
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <Link href="/settings" className="inline-flex items-center gap-1.5 text-sm text-un1t-light hover:text-un1t-white">
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
            className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
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
            className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid disabled:opacity-50"
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
              className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
              placeholder="Min 8 characters"
            />
          </div>
        )}

        <div>
          <label className="block text-sm text-un1t-light mb-1">Role</label>
          <select
            value={form.role}
            onChange={e => {
              const newRole = e.target.value
              setForm(prev => {
                if (prev.role === newRole) return prev
                // Always apply the new role's defaults — both on create and on
                // edit. Without this, demoting an owner to staff would leave
                // their owner-era `permissions` JSONB intact, which makes the
                // sidebar still show admin links (the click-through 403s, but
                // the UX is misleading). Manual permission tweaks below still
                // override whatever this sets.
                return {
                  ...prev,
                  role: newRole,
                  permissions: defaultPermissionsByRole[newRole] || defaultPermissions,
                }
              })
            }}
            className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
          >
            <option value="staff">Staff</option>
            <option value="head_coach">Head Coach</option>
            <option value="manager">Manager</option>
            <option value="owner">Owner / Admin</option>
          </select>
          <p className="text-xs text-un1t-light mt-1">
            Changing role resets permissions to that role's defaults. You can fine-tune individually below.
          </p>
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

      {/* Door Access (UniFi) */}
      {isEdit && (
        <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light">Door Access</h3>
              <p className="text-xs text-un1t-light mt-1">
                {doorLocation
                  ? <>Syncs to UniFi Access for <span className="text-un1t-white">{doorLocation.name}</span></>
                  : 'Assign this person to a location first'}
              </p>
            </div>
            <button
              type="button"
              disabled={!unifiConfigured || !doorLocation}
              onClick={() => setForm(prev => ({ ...prev, unifi_door_access: !prev.unifi_door_access }))}
              className={`w-10 h-5 rounded-full transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                form.unifi_door_access ? 'bg-green-500' : 'bg-un1t-gray'
              }`}
              title={!unifiConfigured ? 'Configure UniFi in Location settings to enable this' : ''}
            >
              <div className={`w-4 h-4 rounded-full bg-white transition-transform ${
                form.unifi_door_access ? 'translate-x-5' : 'translate-x-0.5'
              }`} />
            </button>
          </div>

          {!unifiConfigured && doorLocation && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-300">
              UniFi Access isn&apos;t configured for {doorLocation.name} yet — set
              the host, API token and policy IDs on the location before
              enabling door access for staff.
            </div>
          )}

          {unifiConfigured && (
            <div className="text-xs text-un1t-light bg-black/30 rounded-md px-3 py-2">
              {isManagerRole ? (
                <>Will be granted <span className="text-un1t-white font-medium">Manager</span> access (main door, physio office, main office).</>
              ) : (
                <>Will be granted <span className="text-un1t-white font-medium">Staff</span> access (main door, physio office).</>
              )}
              <span className="block mt-1 text-un1t-mid">
                Role-based — promoting to Manager automatically upgrades door access on save.
              </span>
            </div>
          )}
        </div>
      )}

      {/* HR / Employment Details */}
      <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5 space-y-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light">Employment Details</h3>

        <div>
          <label className="block text-sm text-un1t-light mb-2">Employment Type</label>
          <div className="flex gap-2">
            {[
              { value: 'fte', label: 'Full-Time Employee' },
              { value: 'contractor', label: 'Contractor' },
            ].map(opt => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setForm(prev => ({ ...prev, employment_type: opt.value }))}
                className={`flex-1 py-2 px-3 rounded-md text-sm border transition-colors ${
                  form.employment_type === opt.value
                    ? 'border-un1t-white/40 bg-un1t-gray/30 text-un1t-white'
                    : 'border-un1t-gray text-un1t-light hover:border-white/20'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {form.employment_type === 'fte' ? (
          <>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-un1t-light mb-1">Annual Salary (€)</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={form.annual_salary}
                  onChange={e => setForm(prev => ({ ...prev, annual_salary: e.target.value }))}
                  placeholder="e.g. 35000"
                  className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
                />
              </div>
              <div>
                <label className="block text-sm text-un1t-light mb-1">Contracted Hours / Week</label>
                <input
                  type="number"
                  step="0.5"
                  min="0"
                  max="80"
                  value={form.contracted_hours_per_week}
                  onChange={e => setForm(prev => ({ ...prev, contracted_hours_per_week: e.target.value }))}
                  className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
                />
              </div>
            </div>
            {form.annual_salary && form.contracted_hours_per_week > 0 && (
              <div className="text-xs text-un1t-light bg-black/30 rounded-md px-3 py-2">
                Effective hourly rate: <span className="text-un1t-white font-medium">€{(Number(form.annual_salary) / (Number(form.contracted_hours_per_week) * 52)).toFixed(2)}</span>/hr
              </div>
            )}
            <div>
              <label className="block text-sm text-un1t-light mb-1">Annual Leave Entitlement (days)</label>
              <input
                type="number"
                step="0.5"
                min="0"
                max="50"
                value={form.annual_leave_entitlement}
                onChange={e => setForm(prev => ({ ...prev, annual_leave_entitlement: e.target.value }))}
                className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
              />
            </div>
            <div>
              <label className="block text-sm text-un1t-light mb-1">
                Overtime Rate (€/hr) <span className="text-un1t-mid">— optional</span>
              </label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={form.overtime_rate}
                onChange={e => setForm(prev => ({ ...prev, overtime_rate: e.target.value }))}
                placeholder="e.g. 30.00"
                className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
              />
              <p className="text-xs text-un1t-light mt-1">
                Hours scheduled above contracted weekly hours pay at this rate. Leave blank to pay overtime at the regular rate (no premium).
              </p>
            </div>
          </>
        ) : (
          <div>
            <label className="block text-sm text-un1t-light mb-1">Hourly Rate (€)</label>
            <input
              type="number"
              step="0.01"
              min="0"
              value={form.hourly_rate}
              onChange={e => setForm(prev => ({ ...prev, hourly_rate: e.target.value }))}
              placeholder="e.g. 18.50"
              className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
            />
          </div>
        )}
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
        className="w-full bg-un1t-white text-un1t-black font-medium text-sm py-2.5 rounded-md hover:bg-un1t-accent transition-colors disabled:opacity-50"
      >
        {saving ? 'Saving...' : isEdit ? 'Save Changes' : 'Create Team Member'}
      </button>
    </form>
  )
}
