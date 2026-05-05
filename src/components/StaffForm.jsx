'use client'

import { useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Plus, Trash2, Crown, KeyRound, AlertCircle, Loader2, UserX, UserCheck, Skull } from 'lucide-react'
import {
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

  // Build a populated permissions blob for an assignment of `role`.
  // Each new assignment starts at the role default; admin can flip
  // individual toggles afterwards. The full blob is sent on save so
  // the per-location override is explicit (even if it matches the
  // default at write time — keeps StaffForm's UX simple).
  function defaultPermsForRole(role) {
    const web = defaultPermissionsByRole[role] || defaultPermissions
    const mob = defaultMobilePermissionsByRole[role] || defaultMobilePermissions
    return { ...web, mobile: { ...mob } }
  }

  // Hydrate per-assignment permissions from the staff payload. If the
  // server returned the assignment with a non-empty permissions blob,
  // use that. Empty {} → fall back to role defaults so toggles render
  // truthfully (admin sees what the user effectively gets, can flip
  // individual ones to override).
  const initialAssignments = (staff?.assignments || []).map(a => ({
    ...a,
    permissions: a.permissions && Object.keys(a.permissions).length > 0
      ? {
          ...a.permissions,
          mobile: { ...(a.permissions.mobile || defaultMobilePermissionsByRole[a.role] || defaultMobilePermissions) },
        }
      : defaultPermsForRole(a.role),
  }))

  const [form, setForm] = useState({
    full_name: staff?.full_name || '',
    email: staff?.email || '',
    is_master: !!staff?.is_master,
    active: staff?.active ?? true,
    // assignments: [{ location_id, role, is_default, unifi_door_access, permissions }]
    // permissions is per-assignment (mig 058) — see defaultPermsForRole above.
    assignments: initialAssignments,
    employment_type: staff?.employment_type || 'fte',
    annual_salary: staff?.annual_salary || '',
    hourly_rate: staff?.hourly_rate || '',
    contracted_hours_per_week: staff?.contracted_hours_per_week ?? 40,
    annual_leave_entitlement: staff?.annual_leave_entitlement ?? 20,
    overtime_rate: staff?.overtime_rate || '',
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  // Which assignment's permissions are currently being edited. Set
  // to the first editable assignment's location_id by default; the
  // tab strip above the permissions sections lets the admin switch.
  const firstEditableId = (form.assignments.find(a => callerScope.has(a.location_id)) || form.assignments[0])?.location_id
  const [selectedPermLocationId, setSelectedPermLocationId] = useState(firstEditableId || null)
  // Keep selectedPermLocationId in sync if assignments change underneath us.
  if (selectedPermLocationId && !form.assignments.some(a => a.location_id === selectedPermLocationId)) {
    const fallback = form.assignments[0]?.location_id || null
    if (fallback !== selectedPermLocationId) setSelectedPermLocationId(fallback)
  }
  const selectedAssignment = form.assignments.find(a => a.location_id === selectedPermLocationId) || null
  const selectedLocationName = locations.find(l => l.id === selectedPermLocationId)?.name || ''
  const selectedPerms = selectedAssignment?.permissions || defaultPermsForRole('staff')
  const selectedMobilePerms = selectedPerms.mobile || {}

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

  function isUnifiConfigured(loc) {
    const cfg = loc?.settings?.unifi || {}
    return Boolean(
      cfg.host && cfg.api_token &&
      cfg.staff_policy_id && cfg.manager_policy_id
    )
  }

  // All toggle helpers now operate on the SELECTED assignment's
  // permissions (per-assignment, mig 058). Switching the tab strip
  // above the permissions sections rebinds the helpers to a
  // different assignment — same toggle logic, different scope.
  function patchSelectedPerms(patch) {
    if (!selectedPermLocationId) return
    setForm(prev => ({
      ...prev,
      assignments: prev.assignments.map(a =>
        a.location_id === selectedPermLocationId
          ? { ...a, permissions: { ...a.permissions, ...patch } }
          : a
      ),
    }))
  }
  function patchSelectedMobilePerms(patch) {
    if (!selectedPermLocationId) return
    setForm(prev => ({
      ...prev,
      assignments: prev.assignments.map(a =>
        a.location_id === selectedPermLocationId
          ? {
              ...a,
              permissions: {
                ...a.permissions,
                mobile: { ...(a.permissions?.mobile || {}), ...patch },
              },
            }
          : a
      ),
    }))
  }
  function togglePermission(key) {
    patchSelectedPerms({ [key]: !selectedPerms[key] })
  }
  function toggleMobilePermission(key) {
    patchSelectedMobilePerms({ [key]: !selectedMobilePerms[key] })
  }
  function setAllMobilePermissions(on) {
    const perms = {}
    allMobilePermissions.forEach(p => { perms[p.key] = on })
    if (!selectedPermLocationId) return
    setForm(prev => ({
      ...prev,
      assignments: prev.assignments.map(a =>
        a.location_id === selectedPermLocationId
          ? { ...a, permissions: { ...a.permissions, mobile: perms } }
          : a
      ),
    }))
  }
  function setAllPermissions(on) {
    const perms = {}
    allPermissions.forEach(p => { perms[p.key] = on })
    if (!selectedPermLocationId) return
    setForm(prev => ({
      ...prev,
      assignments: prev.assignments.map(a =>
        a.location_id === selectedPermLocationId
          ? {
              ...a,
              permissions: { ...perms, mobile: a.permissions?.mobile || {} },
            }
          : a
      ),
    }))
  }

  // Reset an assignment's permissions to the role default whenever
  // its role changes (e.g. promoting a staff to manager grants
  // manager defaults at THAT location only). Per-assignment shadow
  // map keyed by location_id so manual tweaks aren't overwritten on
  // every render.
  const [lastRoleByLocation, setLastRoleByLocation] = useState(() => {
    const m = {}
    for (const a of (staff?.assignments || [])) m[a.location_id] = a.role
    return m
  })
  for (const a of form.assignments) {
    if (a.role && a.role !== lastRoleByLocation[a.location_id]) {
      // Schedule the reset for next render to avoid mid-render mutation
      // of two pieces of state. Functional setState in a microtask.
      Promise.resolve().then(() => {
        setLastRoleByLocation(prev => ({ ...prev, [a.location_id]: a.role }))
        setForm(prev => ({
          ...prev,
          assignments: prev.assignments.map(x =>
            x.location_id === a.location_id
              ? { ...x, permissions: defaultPermsForRole(a.role) }
              : x
          ),
        }))
      })
    }
  }

  function addAssignment(locationId) {
    setForm(prev => {
      const role = allowedRoles.includes('staff') ? 'staff' : allowedRoles[0]
      const next = [...prev.assignments, {
        location_id: locationId,
        role,
        is_default: prev.assignments.length === 0,
        unifi_door_access: false,
        // Per-location permissions (mig 058) — start at the role
        // default for the chosen role; admin can flip individual
        // toggles afterwards via the permissions tab strip.
        permissions: defaultPermsForRole(role),
      }]
      return { ...prev, assignments: next }
    })
    // Auto-select the newly-added assignment so the permissions
    // tab strip surfaces it without an extra click.
    setSelectedPermLocationId(locationId)
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

    if (form.assignments.length === 0 && !form.is_master) {
      setError('Assign this person to at least one studio (or grant the master flag).')
      return
    }

    setSaving(true)

    const url = isEdit ? `/api/staff/${staff.id}` : '/api/staff'
    const method = isEdit ? 'PUT' : 'POST'

    // Per-location permissions (mig 058). Each assignment carries its
    // own permissions blob (web flat + mobile sub-object). The server
    // writes them to profile_locations.permissions; profile.permissions
    // is no longer read by hasPermission().
    const payload = {
      full_name: form.full_name,
      is_master: form.is_master,
      assignments: form.assignments.map(a => ({
        location_id: a.location_id,
        role: a.role,
        is_default: !!a.is_default,
        unifi_door_access: !!a.unifi_door_access,
        permissions: a.permissions || {},
      })),
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
      // No password — Supabase Auth sends an invitation email and the
      // new user sets their own credential at /reset-password. The admin
      // never handles the password.
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
          <div className="bg-un1t-black/40 border border-un1t-gray rounded-md p-3 text-xs text-un1t-light">
            <div className="font-medium text-un1t-white mb-1">Password</div>
            On save, an invitation email goes to <span className="font-mono">{form.email || 'this address'}</span>.
            The new user clicks the link to set their own password — nobody on this side ever sees it.
            If they miss the email or the link expires, you can resend at any time using the
            &ldquo;Send password reset&rdquo; button on their profile.
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

        {isEdit && staff?.id && (
          <SendPasswordResetButton staffId={staff.id} email={form.email} />
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

      {/* Per-location permissions tab strip (mig 058). Lets the
          admin pick WHICH assignment they're editing — permissions
          are per-location now, so there's one toggle list per
          location the user is assigned to. */}
      {form.assignments.length > 0 && (
        <div className="bg-un1t-dark border border-un1t-gray rounded-lg overflow-hidden">
          <div className="px-5 pt-4 pb-2 border-b border-un1t-gray">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light">Feature Permissions</h3>
            <p className="text-xs text-un1t-light mt-1">
              Per-location permissions — pick a studio below to set what this person sees there.
              Empty toggles fall back to the role default for their role at that studio.
            </p>
          </div>
          <div className="flex flex-wrap gap-1 px-3 pt-3">
            {form.assignments.map(a => {
              const loc = locations.find(l => l.id === a.location_id)
              const isSelected = a.location_id === selectedPermLocationId
              const isReadOnly = !callerScope.has(a.location_id)
              return (
                <button
                  key={a.location_id}
                  type="button"
                  onClick={() => setSelectedPermLocationId(a.location_id)}
                  className={`px-3 py-1.5 text-xs rounded-md border transition-colors ${
                    isSelected
                      ? 'bg-un1t-white text-un1t-black border-un1t-white font-medium'
                      : 'bg-un1t-black text-un1t-light border-un1t-gray hover:text-un1t-white'
                  }`}
                  title={isReadOnly ? "You don't manage this location — view only" : ''}
                >
                  {loc?.name || 'Unknown'}
                  <span className="ml-1.5 text-[10px] opacity-70 uppercase">{a.role}</span>
                </button>
              )
            })}
          </div>

          {/* Web sidebar permissions for the selected assignment */}
          <div className="px-5 pt-4 pb-3">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-un1t-light">
                Web sidebar — {selectedLocationName || '(pick a location)'}
              </h4>
              <div className="flex gap-2">
                <button type="button" onClick={() => setAllPermissions(true)} className="text-xs text-blue-400 hover:text-blue-300">All on</button>
                <span className="text-un1t-mid">·</span>
                <button type="button" onClick={() => setAllPermissions(false)} className="text-xs text-blue-400 hover:text-blue-300">All off</button>
              </div>
            </div>
            <div className="space-y-2">
              {allPermissions.map(perm => {
                // Only flag the LOCATION gate at the currently
                // selected location — toggling a per-location
                // override has no effect if the location itself
                // disabled the feature.
                const selectedLoc = locations.find(l => l.id === selectedPermLocationId)
                const offHere = isFeatureGatedByLocation(perm.key) && selectedLoc?.features?.[perm.key] === false
                return (
                  <label key={perm.key} className={`flex items-center justify-between py-1.5 cursor-pointer ${offHere ? 'opacity-60' : ''}`}>
                    <span className="text-sm">
                      {perm.label}
                      {offHere && (
                        <span className="block text-[11px] text-amber-500 mt-0.5">
                          Off at this location — toggle has no effect until enabled in Location Features
                        </span>
                      )}
                    </span>
                    <button
                      type="button"
                      onClick={() => togglePermission(perm.key)}
                      disabled={!selectedPermLocationId}
                      className={`w-10 h-5 rounded-full transition-colors shrink-0 ${selectedPerms[perm.key] ? 'bg-green-500' : 'bg-un1t-gray'} ${!selectedPermLocationId ? 'opacity-50 cursor-not-allowed' : ''}`}
                      title={offHere ? `Disabled at this location. Edit Location Features to enable.` : ''}
                    >
                      <div className={`w-4 h-4 rounded-full bg-white transition-transform ${selectedPerms[perm.key] ? 'translate-x-5' : 'translate-x-0.5'}`} />
                    </button>
                  </label>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {/* Mobile Features (per-location, scoped to the currently
          selected tab above). */}
      {form.assignments.length > 0 && (
      <div className="bg-un1t-dark border border-un1t-gray rounded-lg p-5">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-light">
              Mobile App Features — {selectedLocationName || '(pick a location)'}
            </h3>
            <p className="text-xs text-un1t-light mt-1">
              Controls what this person sees in the iOS app at the selected studio. Notification rows are silenced if Push Notifications is off.
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
            const dim = isNotifyRow && !selectedMobilePerms.push_notifications
            const selectedLoc = locations.find(l => l.id === selectedPermLocationId)
            const offHere = isFeatureGatedByLocation(perm.key) && selectedLoc?.features?.[perm.key] === false
            return (
              <label key={perm.key} className={`flex items-center justify-between py-1.5 cursor-pointer ${dim || offHere ? 'opacity-60' : ''}`}>
                <span className="text-sm">
                  {perm.label}
                  {perm.hint && (
                    <span className="block text-xs text-un1t-light">{perm.hint}</span>
                  )}
                  {offHere && (
                    <span className="block text-[11px] text-amber-500 mt-0.5">
                      Off at this location — toggle has no effect until enabled in Location Features
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => toggleMobilePermission(perm.key)}
                  disabled={!selectedPermLocationId}
                  className={`w-10 h-5 rounded-full transition-colors shrink-0 ${selectedMobilePerms[perm.key] ? 'bg-green-500' : 'bg-un1t-gray'} ${!selectedPermLocationId ? 'opacity-50 cursor-not-allowed' : ''}`}
                  title={offHere ? `Disabled at this location. Edit Location Features to enable.` : ''}
                >
                  <div className={`w-4 h-4 rounded-full bg-white transition-transform ${selectedMobilePerms[perm.key] ? 'translate-x-5' : 'translate-x-0.5'}`} />
                </button>
              </label>
            )
          })}
        </div>
      </div>
      )}

      <button
        type="submit"
        disabled={saving}
        className="w-full bg-un1t-white text-un1t-black font-medium text-sm py-2.5 rounded-md hover:bg-un1t-accent transition-colors disabled:opacity-50"
      >
        {saving ? 'Saving...' : isEdit ? 'Save Changes' : 'Create Team Member'}
      </button>

      {/* Danger Zone — soft archive (Deactivate) and permanent delete
          (master only, only when already inactive). Lives inside the
          form but every button is type="button" so they don't trigger
          the submit handler. */}
      {isEdit && staff?.id && (
        <DangerZone
          staffId={staff.id}
          staffName={form.full_name || staff.email}
          isActive={form.active}
          callerIsMaster={callerIsMaster}
        />
      )}
    </form>
  )
}

// Danger Zone — destructive actions on a staff member.
//
// Visible states:
//   active staff       → Deactivate button (everyone authorized to edit)
//   inactive staff     → Reactivate button + Permanent delete (master only)
//
// Both destructive actions go through a confirmation step. Permanent
// delete additionally requires typing the staff member's name to
// match — that's the second-confirm UX standard for irreversible
// destructive actions in this codebase (see contact delete-with-impact).
function DangerZone({ staffId, staffName, isActive, callerIsMaster }) {
  return (
    <div className="bg-red-500/5 border border-red-500/20 rounded-lg p-5 space-y-4">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-red-400">Danger Zone</h3>
        <p className="text-xs text-un1t-light mt-1">
          {isActive
            ? "Deactivating revokes all door access and prevents sign-in. Their history (shifts, contact events, audit log) stays intact — that's almost always what you want when someone leaves."
            : "This account is deactivated. They can't sign in. Reactivate to restore access, or permanently delete (master only) to fulfil a GDPR right-to-be-forgotten request."}
        </p>
      </div>

      {isActive ? (
        <DeactivateButton staffId={staffId} staffName={staffName} />
      ) : (
        <div className="space-y-3">
          <ReactivateButton staffId={staffId} />
          {callerIsMaster && (
            <PermanentDeleteButton staffId={staffId} staffName={staffName} />
          )}
        </div>
      )}
    </div>
  )
}

// Soft-archive (DELETE /api/staff/[id]). Two-state inline confirm.
function DeactivateButton({ staffId, staffName }) {
  const router = useRouter()
  const [state, setState] = useState('idle') // idle | confirming | working | error
  const [error, setError] = useState(null)

  async function run() {
    setState('working')
    setError(null)
    try {
      const res = await fetch(`/api/staff/${staffId}`, { method: 'DELETE' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.success === false) {
        throw new Error(data.error || `Deactivate failed (${res.status})`)
      }
      router.refresh()
      setState('idle')
    } catch (e) {
      setState('error')
      setError(e.message || 'Deactivate failed')
    }
  }

  if (state === 'confirming' || state === 'working' || state === 'error') {
    return (
      <div className="bg-un1t-black/40 border border-un1t-gray rounded-md p-3 space-y-2">
        <div className="text-xs text-un1t-light">
          Deactivate <span className="font-mono text-un1t-white">{staffName}</span>?
          They lose CRM access immediately and any UniFi door policies are revoked.
          You can reactivate them at any time.
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={run}
            disabled={state === 'working'}
            className="text-xs bg-red-500 text-white px-3 py-1.5 rounded-md hover:bg-red-600 font-medium inline-flex items-center gap-1.5 disabled:opacity-50"
          >
            {state === 'working' ? <Loader2 size={11} className="animate-spin" /> : <UserX size={11} />}
            {state === 'working' ? 'Deactivating…' : 'Yes, deactivate'}
          </button>
          <button
            type="button"
            onClick={() => { setState('idle'); setError(null) }}
            disabled={state === 'working'}
            className="text-xs text-un1t-light hover:text-un1t-white"
          >
            Cancel
          </button>
        </div>
        {error && (
          <div className="text-xs text-red-400 inline-flex items-start gap-1.5">
            <AlertCircle size={11} className="mt-0.5 shrink-0" /> {error}
          </div>
        )}
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={() => setState('confirming')}
      className="text-xs bg-red-500/15 text-red-300 border border-red-500/30 hover:bg-red-500/25 px-3 py-2 rounded-md font-medium inline-flex items-center gap-1.5"
    >
      <UserX size={12} /> Deactivate staff member
    </button>
  )
}

// Reactivate (PUT /api/staff/[id] with active:true). One-step — low risk.
function ReactivateButton({ staffId }) {
  const router = useRouter()
  const [state, setState] = useState('idle')
  const [error, setError] = useState(null)

  async function run() {
    setState('working')
    setError(null)
    try {
      const res = await fetch(`/api/staff/${staffId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ active: true }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.success === false) {
        throw new Error(data.error || `Reactivate failed (${res.status})`)
      }
      router.refresh()
      setState('idle')
    } catch (e) {
      setState('error')
      setError(e.message || 'Reactivate failed')
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={run}
        disabled={state === 'working'}
        className="text-xs bg-green-500/15 text-green-300 border border-green-500/30 hover:bg-green-500/25 px-3 py-2 rounded-md font-medium inline-flex items-center gap-1.5 disabled:opacity-50"
      >
        {state === 'working' ? <Loader2 size={11} className="animate-spin" /> : <UserCheck size={12} />}
        {state === 'working' ? 'Reactivating…' : 'Reactivate staff member'}
      </button>
      {error && (
        <div className="text-xs text-red-400 mt-2 inline-flex items-start gap-1.5">
          <AlertCircle size={11} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}
    </div>
  )
}

// Permanent delete (DELETE /api/staff/[id]/permanent).
// Master-only. Requires typed-name match.
function PermanentDeleteButton({ staffId, staffName }) {
  const router = useRouter()
  const [state, setState] = useState('idle') // idle | confirming | working | error
  const [typedName, setTypedName] = useState('')
  const [error, setError] = useState(null)

  const expectsConfirmText = (staffName || 'this user').trim()
  const matches = typedName.trim().toLowerCase() === expectsConfirmText.toLowerCase()

  async function run() {
    if (!matches) return
    setState('working')
    setError(null)
    try {
      const res = await fetch(`/api/staff/${staffId}/permanent`, { method: 'DELETE' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.success === false) {
        throw new Error(data.error || `Delete failed (${res.status})`)
      }
      // Hard delete — there's no profile to return to. Send the
      // operator back to the staff list. data.warning surfaces the
      // auth-orphan case if it happened.
      if (data.warning) alert(data.warning)
      router.push('/settings/staff')
    } catch (e) {
      setState('error')
      setError(e.message || 'Delete failed')
    }
  }

  if (state === 'confirming' || state === 'working' || state === 'error') {
    return (
      <div className="bg-red-500/10 border border-red-500/40 rounded-md p-3 space-y-3">
        <div className="text-xs text-red-200">
          <strong className="block text-red-100 mb-1">This is irreversible.</strong>
          Permanently deleting <span className="font-mono text-white">{staffName}</span> removes their
          profile, login, and all per-location assignments. Audit attribution on rosters,
          shifts, and broadcasts becomes anonymous (the row stays, the &ldquo;by&rdquo; column goes NULL).
          Use this only for a confirmed GDPR right-to-be-forgotten request.
        </div>
        <div>
          <label className="block text-xs text-un1t-light mb-1">
            Type <span className="font-mono text-un1t-white">{expectsConfirmText}</span> to confirm:
          </label>
          <input
            type="text"
            value={typedName}
            onChange={(e) => setTypedName(e.target.value)}
            disabled={state === 'working'}
            className="w-full bg-un1t-black border border-un1t-gray rounded-md px-3 py-2 text-sm text-un1t-white focus:outline-none focus:border-red-500/50 disabled:opacity-50"
            autoComplete="off"
          />
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={run}
            disabled={!matches || state === 'working'}
            className="text-xs bg-red-600 text-white px-3 py-1.5 rounded-md hover:bg-red-700 font-medium inline-flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {state === 'working' ? <Loader2 size={11} className="animate-spin" /> : <Skull size={11} />}
            {state === 'working' ? 'Deleting…' : 'Permanently delete'}
          </button>
          <button
            type="button"
            onClick={() => { setState('idle'); setError(null); setTypedName('') }}
            disabled={state === 'working'}
            className="text-xs text-un1t-light hover:text-un1t-white"
          >
            Cancel
          </button>
        </div>
        {error && (
          <div className="text-xs text-red-400 inline-flex items-start gap-1.5">
            <AlertCircle size={11} className="mt-0.5 shrink-0" /> {error}
          </div>
        )}
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={() => setState('confirming')}
      className="text-xs bg-red-500/15 text-red-300 border border-red-500/40 hover:bg-red-500/25 px-3 py-2 rounded-md font-medium inline-flex items-center gap-1.5"
    >
      <Skull size={12} /> Permanently delete (GDPR)
    </button>
  )
}

// "Send password reset" — fires the standard Supabase recovery email
// via /api/staff/[id]/send-password-reset. Confirmation prompt is
// inline rather than a modal because this is low-risk (worst case the
// user gets an extra email they can ignore). Useful for: re-sending
// a missed invite, helping a user who forgot their password, or
// rotating credentials after suspected compromise.
function SendPasswordResetButton({ staffId, email }) {
  const [state, setState] = useState('idle')   // 'idle' | 'confirming' | 'sending' | 'sent' | 'error'
  const [error, setError] = useState(null)

  async function send() {
    setState('sending')
    setError(null)
    try {
      const res = await fetch(`/api/staff/${staffId}/send-password-reset`, {
        method: 'POST',
      })
      const data = await res.json()
      if (!res.ok || data.success === false) {
        throw new Error(data.error || `Send failed (${res.status})`)
      }
      setState('sent')
    } catch (e) {
      setState('error')
      setError(e.message || 'Send failed')
    }
  }

  if (state === 'sent') {
    return (
      <div className="text-xs text-green-700 bg-green-500/10 border border-green-500/30 rounded-md p-2 inline-flex items-center gap-2">
        <KeyRound size={12} />
        Password reset email sent to {email}.
      </div>
    )
  }

  if (state === 'confirming') {
    return (
      <div className="bg-un1t-black/40 border border-un1t-gray rounded-md p-3 space-y-2">
        <div className="text-xs text-un1t-light">
          Send a password reset email to <span className="font-mono text-un1t-white">{email}</span>?
          They&apos;ll receive a link to set a new password and any existing session won&apos;t change
          until they actually use it.
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={send}
            className="text-xs bg-un1t-white text-un1t-black px-3 py-1.5 rounded-md hover:bg-un1t-accent font-medium inline-flex items-center gap-1.5"
          >
            <KeyRound size={11} /> Send
          </button>
          <button
            type="button"
            onClick={() => { setState('idle'); setError(null) }}
            className="text-xs text-un1t-light hover:text-un1t-white"
          >
            Cancel
          </button>
        </div>
        {error && (
          <div className="text-xs text-red-700 inline-flex items-start gap-1.5">
            <AlertCircle size={11} className="mt-0.5 shrink-0" /> {error}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={() => setState('confirming')}
        disabled={state === 'sending'}
        className="text-xs text-un1t-light hover:text-un1t-white inline-flex items-center gap-1.5 disabled:opacity-40"
      >
        {state === 'sending' ? <Loader2 size={11} className="animate-spin" /> : <KeyRound size={11} />}
        {state === 'sending' ? 'Sending…' : 'Send password reset email'}
      </button>
      {error && state === 'error' && (
        <div className="text-xs text-red-700 inline-flex items-start gap-1.5">
          <AlertCircle size={11} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}
    </div>
  )
}
