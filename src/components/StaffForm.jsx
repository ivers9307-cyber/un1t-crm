'use client'

import { useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Check, X, Plus, Trash2, Crown } from 'lucide-react'
import {
  passwordRequirements, validatePasswordComplexity,
  OWNER_ASSIGNABLE_ROLES, MASTER_ASSIGNABLE_ROLES,
} from '@/lib/schemas'
import {
  WEB_PERMISSIONS as allPermissions,
  DEFAULT_WEB_PERMISSIONS_BY_ROLE as defaultPermissionsByRole,
  isFeatureGatedByLocation,
  MOBILE_PERMISSIONS as allMobilePermissions,
  DEFAULT_MOBILE_PERMISSIONS_BY_ROLE as defaultMobilePermissionsByRole,
} from '@shared/permissions'

const defaultPermissions = defaultPermissionsByRole.staff
const defaultMobilePermissions = defaultMobilePermissionsByRole.staff

const ROLE_PRECEDENCE = { owner: 1, manager: 2, head_coach: 3, staff: 4 }
const ROLE_LABELS = {
  owner: 'Owner / Studio Admin',
  manager: 'Manager',
  head_coach: 'Head Coach',
  staff: 'Staff',
}

/**
 * Wizard-style staff form (mig 051 per-location roles).
 *
 * The user can be assigned to multiple locations, each with its OWN
 * role + door access + default flag. Master is a separate platform-
 * wide flag — owners can't grant or revoke it.
 *
 * Authorization in the UI mirrors the server-side checks:
 *   master:  can grant master flag, add/edit any location, any role
 *   owner:   can NOT grant master, can only add/edit assignments at
 *            locations they themselves are owner at, role limited
 *            to OWNER_ASSIGNABLE_ROLES (which includes 'owner' per
 *            mig 051 — owner-at-X can mint another owner-at-X).
 *
 * Assignments at locations the caller is NOT owner at are shown
 * read-only (so an owner can see "this person is also at Stillorgan
 * as head_coach" but can't edit that row). The server preserves
 * those rows on save.
 */
export default function StaffForm({
  staff,
  locations,
  callerIsMaster = false,
  callerOwnerLocationIds = [],
}) {
  const isEdit = !!staff
  const router = useRouter()

  // Master can grant any role (incl. another master flag); owner
  // can grant any per-location role (including owner) but not master.
  const allowedRoles = callerIsMaster ? MASTER_ASSIGNABLE_ROLES : OWNER_ASSIGNABLE_ROLES
  const callerScope = useMemo(
    () => new Set(callerOwnerLocationIds),
    [callerOwnerLocationIds]
  )

  const [form, setForm] = useState({
    full_name: staff?.full_name || '',
    email: staff?.email || '',
    password: '',
    is_master: !!staff?.is_master,
    active: staff?.active ?? true,
    // assignments: [{ location_id, role, is_default, unifi_door_access }]
    assignments: staff?.assignments || [],
    permissions: staff?.permissions || { ...defaultPermissions, mobile: { ...defaultMobilePermissions } },
    mobile_permissions: staff?.permissions?.mobile || { ...defaultMobilePermissions },
    employment_type: staff?.employment_type || 'fte',
    annual_salary: staff?.annual_salary || '',
    hourly_rate: staff?.hourly_rate || '',
    contracted_hours_per_week: staff?.contracted_hours_per_week ?? 40,
    annual_leave_entitlement: staff?.annual_leave_entitlement ?? 20,
    overtime_rate: staff?.overtime_rate || '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  // Computed view of the assignments — split into editable (caller can
  // touch) and read-only (caller is not owner at that location, so the
  // row is preserved server-side without modification).
  const editableAssignments = form.assignments.filter(a => callerScope.has(a.location_id))
  const readOnlyAssignments = form.assignments.filter(a => !callerScope.has(a.location_id))

  // Locations the caller could ADD to this user that aren't already
  // assigned. Master gets every location; owner gets only their owned ones.
  const assignedIds = new Set(form.assignments.map(a => a.location_id))
  const addableLocations = locations
    .filter(l => callerScope.has(l.id) && !assignedIds.has(l.id))

  // Highest role across editable assignments — drives the
  // role-default reset for permissions when assignments change.
  const highestEditableRole = editableAssignments
    .map(a => a.role)
    .sort((a, b) => (ROLE_PRECEDENCE[a] || 99) - (ROLE_PRECEDENCE[b] || 99))[0]

  function isUnifiConfigured(loc) {
    const cfg = loc?.settings?.unifi || {}
    return Boolean(
      cfg.host && cfg.api_token &&
      cfg.staff_policy_id && cfg.manager_policy_id
    )
  }

  function disabledAtLocationNames(key) {
    if (!isFeatureGatedByLocation(key)) return []
    return locations
      .filter(l => assignedIds.has(l.id) && l.features?.[key] === false)
      .map(l => l.name)
  }

  function togglePermission(key) {
    setForm(prev => ({
      ...prev,
      permissions: { ...prev.permissions, [key]: !prev.permissions[key] },
    }))
  }
  function toggleMobilePermission(key) {
    setForm(prev => ({
      ...prev,
      mobile_permissions: { ...prev.mobile_permissions, [key]: !prev.mobile_permissions[key] },
    }))
  }
  function setAllMobilePermissions(on) {
    const perms = {}
    allMobilePermissions.forEach(p => { perms[p.key] = on })
    setForm(prev => ({ ...prev, mobile_permissions: perms }))
  }
  function setAllPermissions(on) {
    const perms = {}
    allPermissions.forEach(p => { perms[p.key] = on })
    setForm(prev => ({ ...prev, permissions: perms }))
  }

  // Reset role-default permissions when the highest editable role
  // changes (e.g. promoting a staff to manager grants manager defaults).
  // We track the "previous highest role" via a useState shadow so the
  // user's manual permission tweaks aren't overwritten on every render.
  const [lastHighestRole, setLastHighestRole] = useState(highestEditableRole)
  if (highestEditableRole && highestEditableRole !== lastHighestRole) {
    setLastHighestRole(highestEditableRole)
    setForm(prev => ({
      ...prev,
      permissions: defaultPermissionsByRole[highestEditableRole] || defaultPermissions,
      mobile_permissions: defaultMobilePermissionsByRole[highestEditableRole] || defaultMobilePermissions,
    }))
  }

  function addAssignment(locationId) {
    setForm(prev => {
      const next = [...prev.assignments, {
        location_id: locationId,
        role: allowedRoles.includes('staff') ? 'staff' : allowedRoles[0],
        is_default: prev.assignments.length === 0,
        unifi_door_access: false,
      }]
      return { ...prev, assignments: next }
    })
  }

  function removeAssignment(locationId) {
    setForm(prev => {
      const remaining = prev.assignments.filter(a => a.location_id !== locationId)
      // Promote a new default if we just removed the default-flagged one
      if (remaining.length > 0 && !remaining.some(a => a.is_default)) {
        // Prefer an editable assignment as the new default, else the first
        const idx = remaining.findIndex(a => callerScope.has(a.location_id))
        const promoteIdx = idx >= 0 ? idx : 0
        remaining[promoteIdx] = { ...remaining[promoteIdx], is_default: true }
      }
      return { ...prev, assignments: remaining }
    })
  }

  function updateAssignment(locationId, patch) {
    setForm(prev => ({
      ...prev,
      assignments: prev.assignments.map(a => {
        if (a.location_id !== locationId) {
          // If we're setting a new default, others must clear theirs
          if (patch.is_default) return { ...a, is_default: false }
          return a
        }
        return { ...a, ...patch }
      }),
    }))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)

    if (!isEdit) {
      const pwError = validatePasswordComplexity(form.password)
      if (pwError) { setError(pwError); return }
    }

    if (form.assignments.length === 0 && !form.is_master) {
      setError('Assign this person to at least one studio (or grant the master flag).')
      return
    }

    setSaving(true)

    const url = isEdit ? `/api/staff/${staff.id}` : '/api/staff'
    const method = isEdit ? 'PUT' : 'POST'

    const mergedPermissions = {
      ...form.permissions,
      mobile: { ...form.mobile_permissions },
    }

    const payload = {
      full_name: form.full_name,
      is_master: form.is_master,
      assignments: form.assignments,
      permissions: mergedPermissions,
      active: form.active,
      employment_type: form.employment_type,
      annual_salary: form.employment_type === 'fte' && form.annual_salary ? Number(form.annual_salary) : null,
      hourly_rate: form.employment_type === 'contractor' && form.hourly_rate ? Number(form.hourly_rate) : null,
      contracted_hours_per_week: form.employment_type === 'fte' ? Number(form.contracted_hours_per_week) : null,
      annual_leave_entitlement: form.employment_type === 'fte' ? Number(form.annual_leave_entitlement) : null,
      overtime_rate: form.employment_type === 'fte' && form.overtime_rate ? Number(form.overtime_rate) : null,
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

      {/* Account Details */}
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
              placeholder="Strong password"
            />
            <ul className="mt-2 space-y-1">
              {passwordRequirements.map(r => {
                const ok = r.test(form.password || '')
                return (
                  <li key={r.id} className={`flex items-center gap-2 text-xs ${ok ? 'text-green-400' : 'text-un1t-mid'}`}>
                    {ok ? <Check size={12} /> : <X size={12} />}
                    <span>{r.label}</span>
                  </li>
                )
              })}
            </ul>
          </div>
        )}

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

      {/* Master Account flag — only master callers can set this */}
      {callerIsMaster && (
        <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <Crown size={14} className="text-amber-400" />
                <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light">Master / Platform Admin</h3>
              </div>
              <p className="text-xs text-un1t-light mt-1">
                Platform-wide super-admin. Can create new locations, mint other masters,
                see every studio regardless of assignments. Independent of per-location roles below.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setForm(prev => ({ ...prev, is_master: !prev.is_master }))}
              className={`w-10 h-5 rounded-full transition-colors shrink-0 ${form.is_master ? 'bg-amber-500' : 'bg-un1t-gray'}`}
            >
              <div className={`w-4 h-4 rounded-full bg-white transition-transform ${form.is_master ? 'translate-x-5' : 'translate-x-0.5'}`} />
            </button>
          </div>
        </div>
      )}

      {/* Studio Assignments — the wizard */}
      <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5 space-y-4">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light">Studio Assignments</h3>
          <p className="text-xs text-un1t-light mt-1">
            One row per studio. Each studio carries its OWN role and door access — owner at one studio,
            head coach at another is fine. Mark one as default to land them there on login.
          </p>
        </div>

        {/* Editable cards */}
        {editableAssignments.map(a => {
          const loc = locations.find(l => l.id === a.location_id)
          if (!loc) return null
          const configured = isUnifiConfigured(loc)
          const isManagerRole = a.role === 'owner' || a.role === 'manager'
          return (
            <div key={a.location_id} className="border border-un1t-gray/70 rounded-lg p-4 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-un1t-white">{loc.name}</div>
                  <div className="text-xs text-un1t-light">{loc.slug}</div>
                </div>
                <button
                  type="button"
                  onClick={() => removeAssignment(a.location_id)}
                  className="text-un1t-light hover:text-red-400 shrink-0"
                  title="Remove this assignment"
                >
                  <Trash2 size={16} />
                </button>
              </div>

              <div>
                <label className="block text-xs text-un1t-light mb-1">Role at this studio</label>
                <select
                  value={a.role}
                  onChange={e => updateAssignment(a.location_id, { role: e.target.value })}
                  className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
                >
                  {allowedRoles.map(r => (
                    <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                  ))}
                </select>
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm">Default studio</div>
                  <div className="text-xs text-un1t-light">Lands here on login</div>
                </div>
                <button
                  type="button"
                  onClick={() => updateAssignment(a.location_id, { is_default: true })}
                  disabled={a.is_default}
                  className={`w-10 h-5 rounded-full transition-colors disabled:opacity-100 ${a.is_default ? 'bg-blue-500' : 'bg-un1t-gray hover:bg-un1t-mid'}`}
                >
                  <div className={`w-4 h-4 rounded-full bg-white transition-transform ${a.is_default ? 'translate-x-5' : 'translate-x-0.5'}`} />
                </button>
              </div>

              {/* Door Access — gated by location-level UniFi config + edit mode */}
              {isEdit && (
                <div className="flex items-center justify-between">
                  <div className="min-w-0">
                    <div className="text-sm">Door Access</div>
                    <div className="text-xs text-un1t-light">
                      {configured
                        ? (isManagerRole ? 'Manager access (main + physio + office)' : 'Staff access (main + physio)')
                        : 'UniFi not configured for this location'}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={!configured}
                    onClick={() => updateAssignment(a.location_id, { unifi_door_access: !a.unifi_door_access })}
                    className={`w-10 h-5 rounded-full transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0 ${
                      a.unifi_door_access ? 'bg-green-500' : 'bg-un1t-gray'
                    }`}
                    title={!configured ? `Configure UniFi for ${loc.name} first` : ''}
                  >
                    <div className={`w-4 h-4 rounded-full bg-white transition-transform ${
                      a.unifi_door_access ? 'translate-x-5' : 'translate-x-0.5'
                    }`} />
                  </button>
                </div>
              )}
              {!configured && a.unifi_door_access && (
                <div className="text-xs text-amber-300">
                  UniFi not configured for {loc.name}. Set it up in Location settings before enabling door access.
                </div>
              )}
            </div>
          )
        })}

        {/* Read-only cards (owner caller looking at staff also assigned elsewhere) */}
        {readOnlyAssignments.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs text-un1t-light uppercase tracking-wider">Other studios (read-only)</div>
            {readOnlyAssignments.map(a => {
              const loc = locations.find(l => l.id === a.location_id)
              return (
                <div key={a.location_id} className="border border-un1t-gray/40 bg-black/20 rounded-md px-3 py-2 flex items-center justify-between text-sm">
                  <div>
                    <span className="text-un1t-white">{loc?.name || a.location_id}</span>
                    <span className="text-un1t-light ml-2">— {ROLE_LABELS[a.role] || a.role}</span>
                  </div>
                  <span className="text-xs text-un1t-mid">
                    Owner of that studio can edit
                  </span>
                </div>
              )
            })}
          </div>
        )}

        {/* Add another */}
        {addableLocations.length > 0 && (
          <div>
            <label className="block text-xs text-un1t-light mb-1">Add a studio</label>
            <div className="flex gap-2">
              <select
                value=""
                onChange={e => { if (e.target.value) addAssignment(e.target.value) }}
                className="flex-1 bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white focus:outline-none focus:border-un1t-mid"
              >
                <option value="">— Pick a studio —</option>
                {addableLocations.map(l => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
              <span className="inline-flex items-center text-un1t-mid">
                <Plus size={16} />
              </span>
            </div>
          </div>
        )}

        {form.assignments.length === 0 && (
          <p className="text-xs text-amber-400">
            {form.is_master
              ? 'Master account — can see all studios via platform bypass even with no explicit assignment.'
              : 'No assignments yet. Pick at least one studio above.'}
          </p>
        )}
      </div>

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

      {/* Permissions (web sidebar) */}
      <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light">Feature Permissions</h3>
          <div className="flex gap-2">
            <button type="button" onClick={() => setAllPermissions(true)} className="text-xs text-blue-400 hover:text-blue-300">All on</button>
            <span className="text-un1t-mid">·</span>
            <button type="button" onClick={() => setAllPermissions(false)} className="text-xs text-blue-400 hover:text-blue-300">All off</button>
          </div>
        </div>
        <p className="text-xs text-un1t-light mb-2">Controls what this person sees in the web sidebar. User-level — applies at every studio they're assigned to.</p>
        <div className="space-y-2">
          {allPermissions.map(perm => {
            const offAt = disabledAtLocationNames(perm.key)
            const offAtAssigned = offAt.length > 0
            return (
              <label key={perm.key} className={`flex items-center justify-between py-1.5 cursor-pointer ${offAtAssigned ? 'opacity-60' : ''}`}>
                <span className="text-sm">
                  {perm.label}
                  {offAtAssigned && (
                    <span className="block text-[11px] text-amber-500 mt-0.5">
                      Off at location: {offAt.join(', ')} — toggle has no effect there
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => togglePermission(perm.key)}
                  className={`w-10 h-5 rounded-full transition-colors shrink-0 ${form.permissions[perm.key] ? 'bg-green-500' : 'bg-un1t-gray'}`}
                  title={offAtAssigned ? `Disabled at ${offAt.join(', ')}. Edit the location's Features section to enable.` : ''}
                >
                  <div className={`w-4 h-4 rounded-full bg-white transition-transform ${form.permissions[perm.key] ? 'translate-x-5' : 'translate-x-0.5'}`} />
                </button>
              </label>
            )
          })}
        </div>
      </div>

      {/* Mobile Features */}
      <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light">Mobile App Features</h3>
            <p className="text-xs text-un1t-light mt-1">
              Controls what this person sees in the iOS app (independent of web sidebar). Notification rows are silenced if Push Notifications is off.
            </p>
          </div>
          <div className="flex gap-2 shrink-0">
            <button type="button" onClick={() => setAllMobilePermissions(true)} className="text-xs text-blue-400 hover:text-blue-300">All on</button>
            <span className="text-un1t-mid">·</span>
            <button type="button" onClick={() => setAllMobilePermissions(false)} className="text-xs text-blue-400 hover:text-blue-300">All off</button>
          </div>
        </div>
        <div className="space-y-2">
          {allMobilePermissions.map(perm => {
            const isNotifyRow = perm.key.startsWith('notify_')
            const dim = isNotifyRow && !form.mobile_permissions.push_notifications
            const offAt = disabledAtLocationNames(perm.key)
            const offAtAssigned = offAt.length > 0
            return (
              <label key={perm.key} className={`flex items-center justify-between py-1.5 cursor-pointer ${dim || offAtAssigned ? 'opacity-60' : ''}`}>
                <span className="text-sm">
                  {perm.label}
                  {perm.hint && (
                    <span className="block text-xs text-un1t-light">{perm.hint}</span>
                  )}
                  {offAtAssigned && (
                    <span className="block text-[11px] text-amber-500 mt-0.5">
                      Off at location: {offAt.join(', ')} — toggle has no effect there
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => toggleMobilePermission(perm.key)}
                  className={`w-10 h-5 rounded-full transition-colors shrink-0 ${form.mobile_permissions[perm.key] ? 'bg-green-500' : 'bg-un1t-gray'}`}
                  title={offAtAssigned ? `Disabled at ${offAt.join(', ')}. Edit the location's Features section to enable.` : ''}
                >
                  <div className={`w-4 h-4 rounded-full bg-white transition-transform ${form.mobile_permissions[perm.key] ? 'translate-x-5' : 'translate-x-0.5'}`} />
                </button>
              </label>
            )
          })}
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
