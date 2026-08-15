'use client'

import { useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Plus, Trash2, Crown, KeyRound, AlertCircle, Loader2, UserX, UserCheck, Skull, ShieldAlert, Building2 } from 'lucide-react'
import PasswordOverrideModal from './PasswordOverrideModal'
import TestPushButton from './settings/TestPushButton'
import StaffDevicesCard from './settings/StaffDevicesCard'
import LeadTimeOverrideRow from './settings/LeadTimeOverrideRow'
import MobileBarPlanner from './MobileBarPlanner'
import AcDeviceAllowlistPicker from './AcDeviceAllowlistPicker'
import {
  OWNER_ASSIGNABLE_ROLES, MASTER_ASSIGNABLE_ROLES,
} from '@/lib/schemas'
import {
  WEB_PERMISSIONS as allPermissions,
  isFeatureGatedByLocation,
  MOBILE_PERMISSIONS as allMobilePermissions,
  hydratePermissions,
  mergeTemplates,
} from '@shared/permissions'

const ROLE_LABELS = {
  owner: 'Owner / Studio Admin',
  manager: 'Manager',
  head_coach: 'Head Coach',
  staff: 'Staff',
  reception: 'Reception',
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
  // PERM-AUDIT.3 — operator-edited role templates (mig 364), keyed
  // { [location_id]: { [role]: sparseTemplateBlob } }. Hydration and
  // the role-default baseline both honour the template so toggles
  // show the TRUE effective state at each location.
  roleTemplates = {},
  // SAAS-4 (mig 417) — org list + this staff member's current
  // org-admin grants for the master-only Organisation Admin card.
  // Only the edit page passes these (and only for master callers).
  organizations = [],
  orgAdminOrgIds = [],
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

  // Role template for (location, role, employmentType) — null when
  // the operator has never customised that role at that location
  // (code defaults apply). RECEPTION.2 (mig 367): roleTemplates is
  // keyed { locId: { role: { all, fte, contractor, casual } } } —
  // the employment-type variant layers over the 'all' base, matching
  // the server-side resolution exactly.
  function templateFor(locationId, role, employmentType) {
    const variants = roleTemplates?.[locationId]?.[role]
    if (!variants) return null
    return mergeTemplates(
      variants.all || null,
      employmentType ? variants[employmentType] || null : null
    )
  }

  // Build a populated permissions blob for an assignment of `role` at
  // `locationId`. Each new assignment starts at the role's EFFECTIVE
  // defaults (code defaults + the location's role template for the
  // form's employment type); admin can flip individual toggles
  // afterwards. The full blob is sent on save; the SERVER reduces it
  // to the sparse diff vs this same baseline (PERM-AUDIT.3), so
  // untouched toggles keep inheriting.
  // NOTE: reads the form's current employment_type, so it must only
  // be called after the form state below is initialised (all current
  // call sites are render-time or event handlers, which qualify).
  // Initial hydration (initialAssignments) deliberately uses
  // templateFor directly with the target's stored employment type.
  function defaultPermsForRole(role, locationId = null, employmentType = null) {
    const emp = employmentType ?? form.employment_type ?? staff?.employment_type ?? 'fte'
    return hydratePermissions(null, role, templateFor(locationId, role, emp))
  }

  // Hydrate per-assignment permissions from the staff payload via the
  // shared canonical helper (also used by the mobile editor): the
  // role's effective defaults (code + template) are merged UNDER the
  // stored blob — web keys AND the mobile sub-object — so toggles
  // render the effective state even for keys the sparse blob doesn't
  // pin (PR #754 Q1, PERM-AUDIT.3). Stored explicit values always win.
  const targetEmploymentType = staff?.employment_type || 'fte'
  const initialAssignments = (staff?.assignments || []).map(a => ({
    ...a,
    permissions: hydratePermissions(a.permissions, a.role, templateFor(a.location_id, a.role, targetEmploymentType)),
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
  // PERM-AUDIT.3 — the role's effective baseline (code defaults +
  // this location's role template) for the selected assignment.
  // Drives the "override" dots and the reset affordance: a toggle
  // matching this baseline is inherited (not stored on save); a
  // toggle differing from it is a per-user override (stored).
  const selectedRoleBase = selectedAssignment
    ? defaultPermsForRole(selectedAssignment.role, selectedAssignment.location_id)
    : defaultPermsForRole('staff')
  const selectedRoleBaseMobile = selectedRoleBase.mobile || {}

  // APPROVALS-PERCAT.1 — hide the location-gate-only approvals_inbox from
  // the per-user grant picker; render the six per-category grants grouped.
  const webGrantItems = allPermissions.filter((p) => !p.locationGateOnly && p.group !== 'approvals')
  const approvalGrantItems = allPermissions.filter((p) => p.group === 'approvals')

  // Reset the selected assignment back to pure role inheritance.
  function resetSelectedToRoleDefaults() {
    if (!selectedAssignment) return
    updateAssignment(selectedAssignment.location_id, {
      permissions: {
        ...selectedRoleBase,
        // Keep the non-permission extras (lead-time overrides ride on
        // .mobile) — resetting toggles shouldn't wipe reminder tuning.
        mobile: {
          ...selectedRoleBase.mobile,
          ...(selectedMobilePerms.lead_time_overrides !== undefined
            ? { lead_time_overrides: selectedMobilePerms.lead_time_overrides } : {}),
          ...(selectedMobilePerms.layout !== undefined
            ? { layout: selectedMobilePerms.layout } : {}),
        },
      },
    })
  }

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
          ? { ...a, permissions: { ...a.permissions, mobile: { ...(a.permissions?.mobile || {}), ...perms } } }
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
              ? { ...x, permissions: defaultPermsForRole(a.role, a.location_id) }
              : x
          ),
        }))
      })
    }
  }

  // RECEPTION.2 — same treatment when the employment TYPE changes:
  // the role-template variant shifts (contractor staff can inherit
  // different defaults than FTE staff), so re-baseline the affected
  // assignments to the new effective defaults. Only assignments whose
  // baseline ACTUALLY differs between the two employment types are
  // reset — in the common no-variant case manual tweaks survive.
  const [lastEmploymentType, setLastEmploymentType] = useState(staff?.employment_type || 'fte')
  if (form.employment_type && form.employment_type !== lastEmploymentType) {
    const prevEmp = lastEmploymentType
    const nextEmp = form.employment_type
    Promise.resolve().then(() => {
      setLastEmploymentType(nextEmp)
      setForm(prev => ({
        ...prev,
        assignments: prev.assignments.map(x => {
          const before = templateFor(x.location_id, x.role, prevEmp)
          const after = templateFor(x.location_id, x.role, nextEmp)
          if (JSON.stringify(before) === JSON.stringify(after)) return x
          return { ...x, permissions: defaultPermsForRole(x.role, x.location_id, nextEmp) }
        }),
      }))
    })
  }

  function addAssignment(locationId) {
    setForm(prev => {
      const role = allowedRoles.includes('staff') ? 'staff' : allowedRoles[0]
      const next = [...prev.assignments, {
        location_id: locationId,
        role,
        is_default: prev.assignments.length === 0,
        unifi_door_access: false,
        // Per-location permissions (mig 058) — start at the role's
        // effective defaults (code + template) for this location;
        // admin can flip individual toggles afterwards via the
        // permissions tab strip.
        permissions: defaultPermsForRole(role, locationId),
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
        // Manual UniFi user link (mig 120 attendance picker). Sending
        // `null` clears the link, a string sets it, omitting the key
        // leaves whatever the server already has unchanged. We always
        // send the current state so the operator's "Auto" choice
        // (null) reliably wipes the link.
        unifi_user_id: a.unifi_user_id || null,
        // GEO-ATT (mig 463) — mobile geofence attendance opt-out.
        // Always sent so the toggle reliably writes both directions.
        geofence_exempt: !!a.geofence_exempt,
        // UNIFI-DOORS-SCOPE (mig 182) — door allowlist for studio
        // mgmt. Always sent so toggling the picker reliably clears
        // or replaces the existing array. Empty array = no doors;
        // null is reserved for the manager+ legacy "all doors"
        // fallback and isn't reachable from this form.
        unifi_door_ids: Array.isArray(a.unifi_door_ids) ? a.unifi_door_ids : [],
        // AC-ROLE.1 — send the tri-state as-is: null = inherit role
        // default, [] = explicit none, [ids] = those. Always present so
        // buildAssignmentRow writes it (it already round-trips null).
        ac_device_ids: a.ac_device_ids === undefined ? null : a.ac_device_ids,
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
      <Link href="/settings/staff" className="inline-flex items-center gap-1.5 text-sm text-un1t-subtle hover:text-un1t-text">
        <ArrowLeft size={16} /> Staff
      </Link>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-700 text-sm rounded-lg p-3">
          {error}
        </div>
      )}

      {/* Account Details */}
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5 space-y-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">Account Details</h3>

        <div>
          <label className="block text-sm text-un1t-subtle mb-1">Full Name *</label>
          <input
            type="text"
            required
            value={form.full_name}
            onChange={e => setForm(prev => ({ ...prev, full_name: e.target.value }))}
            className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted"
          />
        </div>

        <div>
          <label className="block text-sm text-un1t-subtle mb-1">Email *</label>
          <input
            type="email"
            required
            disabled={isEdit}
            value={form.email}
            onChange={e => setForm(prev => ({ ...prev, email: e.target.value }))}
            className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted disabled:opacity-50"
          />
        </div>

        {!isEdit && (
          <div className="bg-un1t-bg/40 border border-un1t-border rounded-md p-3 text-xs text-un1t-subtle">
            <div className="font-medium text-un1t-text mb-1">Password</div>
            On save, an invitation email goes to <span className="font-mono">{form.email || 'this address'}</span>.
            The new user clicks the link to set their own password — nobody on this side ever sees it.
            If they miss the email or the link expires, you can resend at any time using the
            &ldquo;Send password reset&rdquo; button on their profile.
          </div>
        )}

        {isEdit && (
          <div className="flex items-center gap-3">
            <label className="text-sm text-un1t-subtle">Active</label>
            <button
              type="button"
              onClick={() => setForm(prev => ({ ...prev, active: !prev.active }))}
              className={`w-10 h-5 rounded-full transition-colors ${form.active ? 'bg-green-500' : 'bg-un1t-border'}`}
            >
              <div className={`w-4 h-4 rounded-full bg-white transition-transform ${form.active ? 'translate-x-5' : 'translate-x-0.5'}`} />
            </button>
          </div>
        )}

        {isEdit && staff?.id && (
          <div className="space-y-2">
            <SendPasswordResetButton staffId={staff.id} email={form.email} />
            {callerIsMaster && (
              <OverridePasswordButton
                targetType="staff"
                targetId={staff.id}
                targetLabel={form.full_name || form.email || 'this staff member'}
              />
            )}
          </div>
        )}
      </div>

      {/* Master Account flag — only master callers can set this */}
      {callerIsMaster && (
        <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <Crown size={14} className="text-amber-400" />
                <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">Master / Platform Admin</h3>
              </div>
              <p className="text-xs text-un1t-subtle mt-1">
                Platform-wide super-admin. Can create new locations, mint other masters,
                see every studio regardless of assignments. Independent of per-location roles below.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setForm(prev => ({ ...prev, is_master: !prev.is_master }))}
              className={`w-10 h-5 rounded-full transition-colors shrink-0 ${form.is_master ? 'bg-amber-500' : 'bg-un1t-border'}`}
            >
              <div className={`w-4 h-4 rounded-full bg-white transition-transform ${form.is_master ? 'translate-x-5' : 'translate-x-0.5'}`} />
            </button>
          </div>
        </div>
      )}

      {/* Organisation Admin grants (SAAS-4, mig 417) — master callers
          only, edit-only. Saves independently of the main form via
          PUT /api/staff/[id]/org-admin (grants are a diff-synced
          desired-state list, not part of the profile payload). */}
      {callerIsMaster && isEdit && staff?.id && organizations.length > 0 && (
        <OrgAdminCard
          staffId={staff.id}
          organizations={organizations}
          initialOrgIds={orgAdminOrgIds}
        />
      )}

      {/* Studio Assignments — the wizard */}
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5 space-y-4">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">Studio Assignments</h3>
          <p className="text-xs text-un1t-subtle mt-1">
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
            <div key={a.location_id} className="border border-un1t-border/70 rounded-lg p-4 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-un1t-text">{loc.name}</div>
                  <div className="text-xs text-un1t-subtle">{loc.slug}</div>
                </div>
                <button
                  type="button"
                  onClick={() => removeAssignment(a.location_id)}
                  className="text-un1t-subtle hover:text-red-400 shrink-0"
                  title="Remove this assignment"
                >
                  <Trash2 size={16} />
                </button>
              </div>

              <div>
                <label className="block text-xs text-un1t-subtle mb-1">Role at this studio</label>
                <select
                  value={a.role}
                  onChange={e => updateAssignment(a.location_id, { role: e.target.value })}
                  className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted"
                >
                  {allowedRoles.map(r => (
                    <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                  ))}
                </select>
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm">Default studio</div>
                  <div className="text-xs text-un1t-subtle">Lands here on login</div>
                </div>
                <button
                  type="button"
                  onClick={() => updateAssignment(a.location_id, { is_default: true })}
                  disabled={a.is_default}
                  className={`w-10 h-5 rounded-full transition-colors disabled:opacity-100 ${a.is_default ? 'bg-blue-500' : 'bg-un1t-border hover:bg-un1t-muted'}`}
                >
                  <div className={`w-4 h-4 rounded-full bg-white transition-transform ${a.is_default ? 'translate-x-5' : 'translate-x-0.5'}`} />
                </button>
              </div>

              {/* Door Access — gated by location-level UniFi config + edit mode */}
              {isEdit && (
                <div className="flex items-center justify-between">
                  <div className="min-w-0">
                    <div className="text-sm">Door Access</div>
                    <div className="text-xs text-un1t-subtle">
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
                      a.unifi_door_access ? 'bg-green-500' : 'bg-un1t-border'
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

              {/* UniFi user link (mig 120). Lets the operator manually
                  pick which UniFi Access user this profile maps to AT
                  THIS LOCATION — needed when the staff member's UniFi
                  user wasn't auto-discovered by email match (the common
                  case: cards are often registered under personal not
                  work emails). The selected unifi_user_id is what door
                  provisioning and offboarding revocation target, so an
                  unlinked/mislinked user means door access is granted or
                  revoked against the wrong UniFi account. */}
              {isEdit && configured && (
                <UnifiUserPicker
                  locationId={a.location_id}
                  locationName={loc.name}
                  value={a.unifi_user_id || null}
                  onChange={(unifi_user_id) =>
                    updateAssignment(a.location_id, { unifi_user_id })
                  }
                />
              )}
              {/* GEO-ATT (mig 463) — exclude this staff member from
                  mobile geofence attendance at this location: never
                  permission-gated in the app, never auto-stamped.
                  Keep ON for the Apple review account. */}
              {isEdit && (
                <div className="flex items-center justify-between">
                  <div className="min-w-0">
                    <div className="text-sm">Geofence exempt</div>
                    <div className="text-xs text-un1t-subtle">
                      Skip auto attendance + the location permission requirement on mobile
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => updateAssignment(a.location_id, { geofence_exempt: !a.geofence_exempt })}
                    className={`w-10 h-5 rounded-full transition-colors shrink-0 ${
                      a.geofence_exempt ? 'bg-green-500' : 'bg-un1t-border'
                    }`}
                  >
                    <div className={`w-4 h-4 rounded-full bg-white transition-transform ${
                      a.geofence_exempt ? 'translate-x-5' : 'translate-x-0.5'
                    }`} />
                  </button>
                </div>
              )}
              {/* UNIFI-DOORS-SCOPE — per-location door allowlist
                  (mig 182). Operator ticks the doors this user can
                  remote-unlock from the iOS Studio Management screen.
                  Empty array = the user sees no doors. Distinct from
                  UnifiUserPicker (which controls physical card-tap
                  access via UniFi policy) — this only controls the
                  in-app unlock UI. Always visible at edit time
                  regardless of unifi_door_access toggle, because the
                  studio management screen permission is independent
                  from physical-door access. */}
              {isEdit && configured && (
                <DoorAllowlistPicker
                  locationId={a.location_id}
                  locationName={loc.name}
                  value={Array.isArray(a.unifi_door_ids) ? a.unifi_door_ids : []}
                  onChange={(unifi_door_ids) =>
                    updateAssignment(a.location_id, { unifi_door_ids })
                  }
                />
              )}
              {/* STUDIO-AC-DEVICES.3 / AC-ROLE.1 — per-location AC device
                  allowlist. Tri-state: null = inherit the role-template
                  (or code) default, [] = this user explicitly sees no
                  AC, [ids] = this user sees exactly those. */}
              {isEdit && configured && (
                <AcDeviceAllowlistPicker
                  locationId={a.location_id}
                  locationName={loc.name}
                  value={a.ac_device_ids === undefined ? null : a.ac_device_ids}
                  inheritLabel="Inherit from role default"
                  onChange={(ac_device_ids) =>
                    updateAssignment(a.location_id, { ac_device_ids })
                  }
                />
              )}
            </div>
          )
        })}

        {/* Read-only cards (owner caller looking at staff also assigned elsewhere) */}
        {readOnlyAssignments.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs text-un1t-subtle uppercase tracking-wider">Other studios (read-only)</div>
            {readOnlyAssignments.map(a => {
              const loc = locations.find(l => l.id === a.location_id)
              return (
                <div key={a.location_id} className="border border-un1t-border/40 bg-black/20 rounded-md px-3 py-2 flex items-center justify-between text-sm">
                  <div>
                    <span className="text-un1t-text">{loc?.name || a.location_id}</span>
                    <span className="text-un1t-subtle ml-2">— {ROLE_LABELS[a.role] || a.role}</span>
                  </div>
                  <span className="text-xs text-un1t-muted">
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
            <label className="block text-xs text-un1t-subtle mb-1">Add a studio</label>
            <div className="flex gap-2">
              <select
                value=""
                onChange={e => { if (e.target.value) addAssignment(e.target.value) }}
                className="flex-1 bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted"
              >
                <option value="">— Pick a studio —</option>
                {addableLocations.map(l => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
              <span className="inline-flex items-center text-un1t-muted">
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
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5 space-y-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">Employment Details</h3>

        <div>
          <label className="block text-sm text-un1t-subtle mb-2">Employment Type</label>
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
                    ? 'border-un1t-text/40 bg-un1t-border/30 text-un1t-text'
                    : 'border-un1t-border text-un1t-subtle hover:border-white/20'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {form.employment_type === 'fte' ? (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-un1t-subtle mb-1">Annual Salary (€)</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={form.annual_salary}
                  onChange={e => setForm(prev => ({ ...prev, annual_salary: e.target.value }))}
                  placeholder="e.g. 35000"
                  className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted"
                />
              </div>
              <div>
                <label className="block text-sm text-un1t-subtle mb-1">Contracted Hours / Week</label>
                <input
                  type="number"
                  step="0.5"
                  min="0"
                  max="80"
                  value={form.contracted_hours_per_week}
                  onChange={e => setForm(prev => ({ ...prev, contracted_hours_per_week: e.target.value }))}
                  className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted"
                />
              </div>
            </div>
            {form.annual_salary && form.contracted_hours_per_week > 0 && (
              <div className="text-xs text-un1t-subtle bg-black/30 rounded-md px-3 py-2">
                Effective hourly rate: <span className="text-un1t-text font-medium">€{(Number(form.annual_salary) / (Number(form.contracted_hours_per_week) * 52)).toFixed(2)}</span>/hr
              </div>
            )}
            <div>
              <label className="block text-sm text-un1t-subtle mb-1">Annual Leave Entitlement (days)</label>
              <input
                type="number"
                step="0.5"
                min="0"
                max="50"
                value={form.annual_leave_entitlement}
                onChange={e => setForm(prev => ({ ...prev, annual_leave_entitlement: e.target.value }))}
                className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted"
              />
            </div>
            <div>
              <label className="block text-sm text-un1t-subtle mb-1">
                Overtime Rate (€/hr) <span className="text-un1t-muted">— optional</span>
              </label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={form.overtime_rate}
                onChange={e => setForm(prev => ({ ...prev, overtime_rate: e.target.value }))}
                placeholder="e.g. 30.00"
                className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted"
              />
              <p className="text-xs text-un1t-subtle mt-1">
                Hours scheduled above contracted weekly hours pay at this rate. Leave blank to pay overtime at the regular rate (no premium).
              </p>
            </div>
          </>
        ) : (
          <div>
            <label className="block text-sm text-un1t-subtle mb-1">Hourly Rate (€)</label>
            <input
              type="number"
              step="0.01"
              min="0"
              value={form.hourly_rate}
              onChange={e => setForm(prev => ({ ...prev, hourly_rate: e.target.value }))}
              placeholder="e.g. 18.50"
              className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text focus:outline-none focus:border-un1t-muted"
            />
          </div>
        )}
      </div>

      {/* Per-location permissions tab strip (mig 058). Lets the
          admin pick WHICH assignment they're editing — permissions
          are per-location now, so there's one toggle list per
          location the user is assigned to. */}
      {form.assignments.length > 0 && (
        <div className="bg-un1t-surface border border-un1t-border rounded-lg overflow-hidden">
          <div className="px-5 pt-4 pb-2 border-b border-un1t-border">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">Feature Permissions</h3>
            <p className="text-xs text-un1t-subtle mt-1">
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
                      ? 'bg-un1t-text text-un1t-bg border-un1t-text font-medium'
                      : 'bg-un1t-bg text-un1t-subtle border-un1t-border hover:text-un1t-text'
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
              <h4 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">
                Web sidebar — {selectedLocationName || '(pick a location)'}
              </h4>
              <div className="flex gap-2">
                <button type="button" onClick={() => setAllPermissions(true)} className="text-xs text-blue-400 hover:text-blue-300">All on</button>
                <span className="text-un1t-muted">·</span>
                <button type="button" onClick={() => setAllPermissions(false)} className="text-xs text-blue-400 hover:text-blue-300">All off</button>
                <span className="text-un1t-muted">·</span>
                <button type="button" onClick={resetSelectedToRoleDefaults} className="text-xs text-blue-400 hover:text-blue-300" title="Clear every per-user override at this location — the person inherits their role's permissions (including future changes to them).">Reset to role defaults</button>
              </div>
            </div>
            <p className="text-[11px] text-un1t-subtle mb-2">
              An <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 align-middle" /> dot marks a per-user override — everything else follows the role&apos;s permissions automatically.
            </p>
            <div className="space-y-2">
              {webGrantItems.map(perm => {
                // Only flag the LOCATION gate at the currently
                // selected location — toggling a per-location
                // override has no effect if the location itself
                // disabled the feature.
                const selectedLoc = locations.find(l => l.id === selectedPermLocationId)
                const offHere = isFeatureGatedByLocation(perm.key) && selectedLoc?.features?.[perm.key] === false
                const overridden = (selectedPerms[perm.key] === true) !== (selectedRoleBase[perm.key] === true)
                return (
                  <label key={perm.key} className={`flex items-center justify-between py-1.5 cursor-pointer ${offHere ? 'opacity-60' : ''}`}>
                    <span className="text-sm">
                      {perm.label}
                      {overridden && (
                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 ml-1.5 align-middle" title="Per-user override — differs from this person's role permissions at this location" />
                      )}
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
                      className={`w-10 h-5 rounded-full transition-colors shrink-0 ${selectedPerms[perm.key] ? 'bg-green-500' : 'bg-un1t-border'} ${!selectedPermLocationId ? 'opacity-50 cursor-not-allowed' : ''}`}
                      title={offHere ? `Disabled at this location. Edit Location Features to enable.` : ''}
                    >
                      <div className={`w-4 h-4 rounded-full bg-white transition-transform ${selectedPerms[perm.key] ? 'translate-x-5' : 'translate-x-0.5'}`} />
                    </button>
                  </label>
                )
              })}
            </div>
            <div className="mt-3 mb-1 text-xs font-semibold uppercase tracking-wide text-un1t-subtle">Approvals</div>
            <div className="space-y-2">
              {approvalGrantItems.map(perm => {
                const selectedLoc = locations.find(l => l.id === selectedPermLocationId)
                const offHere = isFeatureGatedByLocation(perm.key) && selectedLoc?.features?.[perm.key] === false
                const overridden = (selectedPerms[perm.key] === true) !== (selectedRoleBase[perm.key] === true)
                return (
                  <label key={perm.key} className={`flex items-center justify-between py-1.5 cursor-pointer ${offHere ? 'opacity-60' : ''}`}>
                    <span className="text-sm">
                      {perm.label}
                      {overridden && (
                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 ml-1.5 align-middle" title="Per-user override — differs from this person's role permissions at this location" />
                      )}
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
                      className={`w-10 h-5 rounded-full transition-colors shrink-0 ${selectedPerms[perm.key] ? 'bg-green-500' : 'bg-un1t-border'} ${!selectedPermLocationId ? 'opacity-50 cursor-not-allowed' : ''}`}
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

      {/* Mobile Features + lead-time overrides (per-location, scoped
          to the currently selected tab above). */}
      {form.assignments.length > 0 && (
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">
              Mobile App Features — {selectedLocationName || '(pick a location)'}
            </h3>
            <p className="text-xs text-un1t-subtle mt-1">
              Controls what this person sees in the iOS app at the selected studio. Notification rows are silenced if Push Notifications is off.
            </p>
          </div>
          <div className="flex gap-2 shrink-0">
            <button type="button" onClick={() => setAllMobilePermissions(true)} className="text-xs text-blue-400 hover:text-blue-300">All on</button>
            <span className="text-un1t-muted">·</span>
            <button type="button" onClick={() => setAllMobilePermissions(false)} className="text-xs text-blue-400 hover:text-blue-300">All off</button>
          </div>
        </div>
        {/* NOTIF.6 — admin can fire a test push at this user to
            confirm their device tokens are alive without leaving the
            staff profile. Only shown when editing an existing staff
            member (no profile id yet on the create form). */}
        {isEdit && staff?.id && (
          <div className="flex items-center gap-3 mb-3 pb-3 border-b border-un1t-border">
            <span className="text-xs text-un1t-subtle">Verify delivery to this user&apos;s phone:</span>
            <TestPushButton recipientId={staff.id} recipientName={form.full_name || staff.email} />
          </div>
        )}
        {/* NOTIF.7 + NOTIF.10 — per-user lead-time overrides for
            tasks AND bookings. Stored under
            permissions.mobile.lead_time_overrides.<category>. Empty
            for either category = use the location's default. The
            cron resolves user → location → built-in default. */}
        {selectedPermLocationId && (
          <>
            <LeadTimeOverrideRow
              category="tasks"
              overrides={selectedMobilePerms.lead_time_overrides || {}}
              onChange={(next) => patchSelectedMobilePerms({ lead_time_overrides: next })}
            />
            <LeadTimeOverrideRow
              category="bookings"
              overrides={selectedMobilePerms.lead_time_overrides || {}}
              onChange={(next) => patchSelectedMobilePerms({ lead_time_overrides: next })}
            />
          </>
        )}

        <div className="space-y-2">
          {allMobilePermissions.map(perm => {
            const isNotifyRow = perm.key.startsWith('notify_')
            const dim = isNotifyRow && !selectedMobilePerms.push_notifications
            const selectedLoc = locations.find(l => l.id === selectedPermLocationId)
            const offHere = isFeatureGatedByLocation(perm.key) && selectedLoc?.features?.[perm.key] === false
            const overridden = (selectedMobilePerms[perm.key] === true) !== (selectedRoleBaseMobile[perm.key] === true)
            return (
              <label key={perm.key} className={`flex items-center justify-between py-1.5 cursor-pointer ${dim || offHere ? 'opacity-60' : ''}`}>
                <span className="text-sm">
                  {perm.label}
                  {overridden && (
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 ml-1.5 align-middle" title="Per-user override — differs from this person's role permissions at this location" />
                  )}
                  {perm.hint && (
                    <span className="block text-xs text-un1t-subtle">{perm.hint}</span>
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
                  className={`w-10 h-5 rounded-full transition-colors shrink-0 ${selectedMobilePerms[perm.key] ? 'bg-green-500' : 'bg-un1t-border'} ${!selectedPermLocationId ? 'opacity-50 cursor-not-allowed' : ''}`}
                  title={offHere ? `Disabled at this location. Edit Location Features to enable.` : ''}
                >
                  <div className={`w-4 h-4 rounded-full bg-white transition-transform ${selectedMobilePerms[perm.key] ? 'translate-x-5' : 'translate-x-0.5'}`} />
                </button>
              </label>
            )
          })}
        </div>

        {selectedPermLocationId && (
          <MobileBarPlanner
            role={selectedAssignment?.role || 'staff'}
            employmentType={form.employment_type}
            value={selectedMobilePerms.layout || null}
            onChange={(layout) => patchSelectedMobilePerms({ layout })}
          />
        )}
      </div>
      )}

      {/* STAFF-DEV.6 — which devices this person actually has, what
          version they run and whether background location is granted.
          Edit-only: a profile that doesn't exist yet has no devices. */}
      {isEdit && staff?.id && <StaffDevicesCard profileId={staff.id} />}

      <button
        type="submit"
        disabled={saving}
        className="w-full bg-un1t-text text-un1t-bg font-medium text-sm py-2.5 rounded-md hover:bg-un1t-accent transition-colors disabled:opacity-50"
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
        <p className="text-xs text-un1t-subtle mt-1">
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
      <div className="bg-un1t-bg/40 border border-un1t-border rounded-md p-3 space-y-2">
        <div className="text-xs text-un1t-subtle">
          Deactivate <span className="font-mono text-un1t-text">{staffName}</span>?
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
            className="text-xs text-un1t-subtle hover:text-un1t-text"
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
      className="text-xs bg-red-500/15 text-red-700 border border-red-500/30 hover:bg-red-500/25 px-3 py-2 rounded-md font-medium inline-flex items-center gap-1.5"
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
        className="text-xs bg-green-500/15 text-green-700 border border-green-500/30 hover:bg-green-500/25 px-3 py-2 rounded-md font-medium inline-flex items-center gap-1.5 disabled:opacity-50"
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
      // operator back to the staff list (which lives at /settings,
      // not /settings/staff — there's no index page in that subtree).
      // data.warning surfaces the auth-orphan case if it happened.
      if (data.warning) alert(data.warning)
      router.push('/settings')
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
          <label className="block text-xs text-un1t-subtle mb-1">
            Type <span className="font-mono text-un1t-text">{expectsConfirmText}</span> to confirm:
          </label>
          <input
            type="text"
            value={typedName}
            onChange={(e) => setTypedName(e.target.value)}
            disabled={state === 'working'}
            className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text focus:outline-none focus:border-red-500/50 disabled:opacity-50"
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
            className="text-xs text-un1t-subtle hover:text-un1t-text"
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
      className="text-xs bg-red-500/15 text-red-700 border border-red-500/40 hover:bg-red-500/25 px-3 py-2 rounded-md font-medium inline-flex items-center gap-1.5"
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
// SAAS-4 (mig 417) — Organisation Admin grants card. Master-only (the
// parent gates rendering on callerIsMaster). One checkbox per active
// organisation; Save PUTs the desired-state list to
// /api/staff/[id]/org-admin, which diffs grants/revokes server-side.
// Separate from the main form save on purpose: the grant is a
// tenant-shaping act like the master flag, and keeping it off the
// profile payload means an unrelated profile edit can never
// accidentally rewrite org grants.
function OrgAdminCard({ staffId, organizations, initialOrgIds }) {
  const [selected, setSelected] = useState(() => new Set(initialOrgIds))
  const [saved, setSaved] = useState(() => new Set(initialOrgIds))
  const [state, setState] = useState('idle')   // 'idle' | 'saving' | 'error'
  const [error, setError] = useState(null)

  const dirty = selected.size !== saved.size || [...selected].some(id => !saved.has(id))

  function toggle(orgId) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(orgId)) next.delete(orgId)
      else next.add(orgId)
      return next
    })
  }

  async function save() {
    setState('saving')
    setError(null)
    try {
      const res = await fetch(`/api/staff/${staffId}/org-admin`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organization_ids: [...selected] }),
      })
      const data = await res.json()
      if (!res.ok || data.success === false) {
        throw new Error(data.error || `Save failed (${res.status})`)
      }
      setSaved(new Set(selected))
      setState('idle')
    } catch (e) {
      setState('error')
      setError(e.message || 'Save failed')
    }
  }

  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5 space-y-3">
      <div>
        <div className="flex items-center gap-2">
          <Building2 size={14} className="text-un1t-subtle" />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle">Organisation Admin</h3>
        </div>
        <p className="text-xs text-un1t-subtle mt-1">
          Org-level admin: acts as owner at EVERY studio in the ticked organisations —
          including studios added later — without needing per-studio assignments below.
          Explicit studio assignments keep their own role. Master-only grant.
        </p>
      </div>

      <div className="space-y-1.5">
        {organizations.map(org => (
          <label key={org.id} className="flex items-center gap-2 text-sm text-un1t-text cursor-pointer">
            <input
              type="checkbox"
              checked={selected.has(org.id)}
              onChange={() => toggle(org.id)}
              className="rounded border-un1t-border"
            />
            <span>{org.name}</span>
            <span className="text-xs text-un1t-subtle">{org.slug}</span>
          </label>
        ))}
      </div>

      {error && (
        <div className="text-xs text-red-700 bg-red-500/10 border border-red-500/30 rounded-md p-2 inline-flex items-center gap-2">
          <AlertCircle size={12} />
          {error}
        </div>
      )}

      {dirty && (
        <button
          type="button"
          onClick={save}
          disabled={state === 'saving'}
          className="text-xs bg-un1t-text text-un1t-bg px-3 py-1.5 rounded-md hover:bg-un1t-accent font-medium inline-flex items-center gap-1.5 disabled:opacity-60"
        >
          {state === 'saving' && <Loader2 size={11} className="animate-spin" />}
          {state === 'saving' ? 'Saving…' : 'Save organisation grants'}
        </button>
      )}
    </div>
  )
}

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
      <div className="bg-un1t-bg/40 border border-un1t-border rounded-md p-3 space-y-2">
        <div className="text-xs text-un1t-subtle">
          Send a password reset email to <span className="font-mono text-un1t-text">{email}</span>?
          They&apos;ll receive a link to set a new password and any existing session won&apos;t change
          until they actually use it.
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={send}
            className="text-xs bg-un1t-text text-un1t-bg px-3 py-1.5 rounded-md hover:bg-un1t-accent font-medium inline-flex items-center gap-1.5"
          >
            <KeyRound size={11} /> Send
          </button>
          <button
            type="button"
            onClick={() => { setState('idle'); setError(null) }}
            className="text-xs text-un1t-subtle hover:text-un1t-text"
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
        className="text-xs text-un1t-subtle hover:text-un1t-text inline-flex items-center gap-1.5 disabled:opacity-40"
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

// AUTH.1 — "Override password" — direct admin reset. Master-only
// in the UI (the API allows master+owner; UI is the stricter of the
// two). Sits next to "Send password reset" as a more direct action
// for cases where the user is in front of you and can't access their
// email, or you need to lock them out immediately.
function OverridePasswordButton({ targetType, targetId, targetLabel }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs text-amber-300 hover:text-amber-200 inline-flex items-center gap-1.5"
      >
        <ShieldAlert size={11} />
        Override password
      </button>
      <PasswordOverrideModal
        open={open}
        onClose={() => setOpen(false)}
        targetType={targetType}
        targetId={targetId}
        targetLabel={targetLabel}
      />
    </>
  )
}

// ── UnifiUserPicker ─────────────────────────────────────────────────
//
// Per-location dropdown that lets the operator pick which UniFi Access
// user this CRM profile is linked to (mig 120 attendance). The link
// drives the staff_attendance webhook's actor → profile resolution:
// without it, real card taps land as match_outcome='unknown_user' and
// shifts never auto-stamp.
//
// Lazy-fetches /api/locations/[id]/unifi-users on first expand so the
// staff edit page stays snappy even with multiple locations attached.
// Caches the result on the component so reopening doesn't refetch.
function UnifiUserPicker({ locationId, locationName, value, onChange }) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [users, setUsers] = useState(null) // null = unfetched

  // The pretty label shown on the closed picker — pulls from the
  // fetched user list when available, falls back to the raw id.
  const currentLabel = (() => {
    if (!value) return 'Auto (link on first email match)'
    const found = users?.find((u) => u.id === value)
    if (found) {
      return found.full_name + (found.user_email ? ` · ${found.user_email}` : '')
    }
    return value.length > 12 ? `Linked: ${value.slice(0, 8)}…` : `Linked: ${value}`
  })()

  async function fetchUsers() {
    if (loading) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/locations/${locationId}/unifi-users`, { cache: 'no-store' })
      const json = await res.json()
      if (!json.success) throw new Error(json.message || json.error || 'Fetch failed')
      setUsers(json.users || [])
    } catch (e) {
      setError(e.message || 'Could not load UniFi users')
    } finally {
      setLoading(false)
    }
  }

  function handleToggle() {
    const next = !open
    setOpen(next)
    if (next && users === null) fetchUsers()
  }

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={handleToggle}
        className="w-full flex items-center justify-between text-left rounded-md border border-un1t-border bg-un1t-bg px-3 py-2 text-sm hover:border-un1t-muted"
      >
        <div className="min-w-0">
          <div className="text-xs text-un1t-subtle">UniFi Access user</div>
          <div className="truncate">{currentLabel}</div>
        </div>
        <span className="text-un1t-subtle text-xs ml-2">{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <div className="rounded-md border border-un1t-border bg-un1t-bg p-2 space-y-1">
          {loading && (
            <div className="text-xs text-un1t-subtle px-2 py-1.5">Loading users from {locationName}…</div>
          )}
          {error && (
            <div className="text-xs text-red-300 px-2 py-1.5">{error}</div>
          )}
          {!loading && !error && users && (
            <>
              <button
                type="button"
                onClick={() => { onChange(null); setOpen(false) }}
                className={`w-full text-left text-sm px-2 py-1.5 rounded hover:bg-un1t-border/40 ${!value ? 'text-blue-300' : ''}`}
              >
                Auto / clear link
                <div className="text-xs text-un1t-subtle">Let the system match by email when door access is enabled</div>
              </button>
              <div className="border-t border-un1t-border/50 my-1" />
              <div className="max-h-64 overflow-y-auto">
                {users.length === 0 && (
                  <div className="text-xs text-un1t-subtle px-2 py-1.5">No UniFi users registered at this controller.</div>
                )}
                {users.map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => { onChange(u.id); setOpen(false) }}
                    className={`w-full text-left text-sm px-2 py-1.5 rounded hover:bg-un1t-border/40 ${value === u.id ? 'text-blue-300' : ''}`}
                  >
                    <div>{u.full_name}</div>
                    <div className="text-xs text-un1t-subtle">
                      {u.user_email || 'no email'}
                      {u.nfc_count > 0 && ` · ${u.nfc_count} NFC card${u.nfc_count === 1 ? '' : 's'}`}
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {value && (
        <div className="text-[11px] text-un1t-subtle px-1">
          When this person taps a door at {locationName}, attendance auto-stamps their shift.
        </div>
      )}
    </div>
  )
}

// ── DoorAllowlistPicker ─────────────────────────────────────────────
//
// UNIFI-DOORS-SCOPE — per-location door allowlist for the iOS Studio
// Management remote-unlock screen (mig 182). Operator ticks the doors
// this user is allowed to remote-unlock. Persisted to
// profile_locations.unifi_door_ids on save.
//
// Distinct from UnifiUserPicker (which controls physical card-tap
// access via the user's UniFi policy assignment): this only affects
// the in-app UI. The unlock endpoint independently verifies the
// allowlist before forwarding to the controller.
//
// `value` is always an array (we never pass `null` from the form —
// `null` is reserved for the manager+ legacy fallback that was
// backfilled by mig 182 and isn't editable here).
//
// Lazy-fetches /api/locations/[id]/unifi-doors on first expand, same
// caching pattern as UnifiUserPicker.
function DoorAllowlistPicker({ locationId, locationName, value, onChange }) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [doors, setDoors] = useState(null) // null = unfetched

  const selected = Array.isArray(value) ? value : []
  const selectedSet = new Set(selected)

  const currentLabel = (() => {
    if (selected.length === 0) return 'No doors selected'
    if (!doors) {
      return `${selected.length} door${selected.length === 1 ? '' : 's'} selected`
    }
    const names = selected
      .map((id) => doors.find((d) => d.id === id)?.name || id)
      .slice(0, 3)
    const more = selected.length - names.length
    return more > 0 ? `${names.join(', ')} +${more} more` : names.join(', ')
  })()

  async function fetchDoors() {
    if (loading) return
    setLoading(true); setError(null)
    try {
      const res = await fetch(`/api/locations/${locationId}/unifi-doors`, { cache: 'no-store' })
      const json = await res.json()
      if (!json.success) throw new Error(json.message || json.error || 'Fetch failed')
      setDoors(json.doors || [])
    } catch (e) {
      setError(e.message || 'Could not load doors')
    } finally {
      setLoading(false)
    }
  }

  function handleToggle() {
    const next = !open
    setOpen(next)
    if (next && doors === null) fetchDoors()
  }

  function toggleDoor(doorId) {
    if (selectedSet.has(doorId)) {
      onChange(selected.filter((id) => id !== doorId))
    } else {
      onChange([...selected, doorId])
    }
  }

  function selectAll() {
    if (!doors) return
    onChange(doors.map((d) => d.id))
  }
  function selectNone() {
    onChange([])
  }

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={handleToggle}
        className="w-full flex items-center justify-between text-left rounded-md border border-un1t-border bg-un1t-bg px-3 py-2 text-sm hover:border-un1t-muted"
      >
        <div className="min-w-0">
          <div className="text-xs text-un1t-subtle">Studio Management doors</div>
          <div className="truncate">{currentLabel}</div>
        </div>
        <span className="text-un1t-subtle text-xs ml-2">{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <div className="rounded-md border border-un1t-border bg-un1t-bg p-2 space-y-1">
          {loading && (
            <div className="text-xs text-un1t-subtle px-2 py-1.5">Loading doors from {locationName}…</div>
          )}
          {error && (
            <div className="text-xs text-red-300 px-2 py-1.5">{error}</div>
          )}
          {!loading && !error && doors && (
            <>
              <div className="flex items-center justify-between px-2 py-1">
                <span className="text-[11px] text-un1t-subtle uppercase tracking-wider">
                  {selected.length} of {doors.length} selected
                </span>
                <div className="flex items-center gap-2 text-[11px]">
                  <button
                    type="button"
                    onClick={selectAll}
                    className="text-blue-300 hover:text-blue-200"
                  >
                    Select all
                  </button>
                  <span className="text-un1t-border">·</span>
                  <button
                    type="button"
                    onClick={selectNone}
                    className="text-blue-300 hover:text-blue-200"
                  >
                    Clear
                  </button>
                </div>
              </div>
              <div className="border-t border-un1t-border/50 my-1" />
              <div className="max-h-64 overflow-y-auto">
                {doors.length === 0 && (
                  <div className="text-xs text-un1t-subtle px-2 py-1.5">No doors registered at this controller.</div>
                )}
                {doors.map((d) => {
                  const isOn = selectedSet.has(d.id)
                  return (
                    <button
                      key={d.id}
                      type="button"
                      onClick={() => toggleDoor(d.id)}
                      className={`w-full text-left text-sm px-2 py-1.5 rounded hover:bg-un1t-border/40 flex items-center gap-2 ${isOn ? 'text-blue-300' : ''}`}
                    >
                      <span className={`inline-block w-3.5 h-3.5 rounded border ${isOn ? 'bg-blue-500 border-blue-500' : 'border-un1t-border'} flex items-center justify-center text-[10px] text-white`}>
                        {isOn ? '✓' : ''}
                      </span>
                      <span className="truncate">{d.name}</span>
                    </button>
                  )
                })}
              </div>
              {/* Render any selected IDs that aren't in the current
                  controller list — e.g. a door that was deleted in
                  UniFi after being assigned here. Operator can
                  untick to clean up. */}
              {doors && selected.filter((id) => !doors.find((d) => d.id === id)).length > 0 && (
                <>
                  <div className="border-t border-un1t-border/50 my-1" />
                  <div className="text-[11px] text-amber-300 px-2 py-1">
                    Unknown / removed doors still in this user's allowlist:
                  </div>
                  {selected.filter((id) => !doors.find((d) => d.id === id)).map((id) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => toggleDoor(id)}
                      className="w-full text-left text-sm px-2 py-1.5 rounded hover:bg-un1t-border/40 flex items-center gap-2 text-amber-300"
                    >
                      <span className="inline-block w-3.5 h-3.5 rounded border bg-amber-500 border-amber-500 flex items-center justify-center text-[10px] text-black">✓</span>
                      <span className="truncate font-mono text-xs">{id}</span>
                    </button>
                  ))}
                </>
              )}
            </>
          )}
        </div>
      )}

      <div className="text-[11px] text-un1t-subtle px-1">
        Doors this user can remote-unlock from the Studio Management screen at {locationName}.
        UniFi card-tap access is controlled separately by the user's policy.
      </div>
    </div>
  )
}

