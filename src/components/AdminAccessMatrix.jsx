'use client'

// Master-only access view: every staff member × every location.
// v2 (mig 080) makes this fully editable in three ways:
//
//   1. Click a user row → opens UserAssignmentsPanel for inline edits
//      (per-location role changes, removals, additions, master toggle).
//   2. Master column is single-click toggle with confirmation modal.
//      The at-least-one-master guard is enforced by the API and DB
//      trigger; the UI also calls it out upfront.
//   3. Multi-select row checkboxes + sticky bulk action bar at the
//      bottom: pick N users, choose target location and role (or
//      'remove'), apply in one API call.
//
// Read-only fallback signals: if `currentMasterCount === 1`, the
// master toggle for that single master shows a warning tooltip on hover.

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Building2, Search, ShieldCheck, Settings, AlertCircle, Loader2, X } from 'lucide-react'
import UserAssignmentsPanel from './UserAssignmentsPanel'

const ROLE_LABELS = {
  master: 'Master',
  owner: 'Owner',
  manager: 'Manager',
  head_coach: 'Head Coach',
  staff: 'Staff',
}

const ROLE_PILLS = {
  owner: 'bg-purple-500/15 text-purple-700',
  manager: 'bg-blue-500/15 text-blue-700',
  head_coach: 'bg-emerald-500/15 text-emerald-700',
  staff: 'bg-gray-500/15 text-gray-700',
}

const PERMISSION_ROLE_OPTIONS = [
  { value: 'owner', label: 'Owner' },
  { value: 'manager', label: 'Manager' },
  { value: 'head_coach', label: 'Head Coach' },
  { value: 'staff', label: 'Staff' },
]

// Heuristic: a permissions blob is "non-default" if it has any keys at
// all that aren't the role's defaults. We don't have direct access to
// defaultPermissionsByRole inside this client component without
// importing more weight, so a pragmatic proxy: any non-empty permissions
// blob signals "operator has tweaked this from the role default".
// False positives are harmless (worst case shows a ⚙ that says "no
// overrides found" on inspection); false negatives would hide overrides.
function hasPermissionOverrides(link) {
  const p = link?.permissions
  return p && typeof p === 'object' && Object.keys(p).length > 0
}

function RoleCell({ link }) {
  const role = link?.role
  if (!role) {
    return <span className="text-un1t-muted text-xs">—</span>
  }
  const overrides = hasPermissionOverrides(link)
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`text-[10px] px-1.5 py-0.5 rounded-full whitespace-nowrap ${ROLE_PILLS[role] || ROLE_PILLS.staff}`}>
        {ROLE_LABELS[role] || role}
      </span>
      {overrides && (
        <span
          title="This user has per-location permission overrides on this assignment. Open the user editor to inspect."
          className="text-amber-700 cursor-help"
        >
          <Settings size={10} />
        </span>
      )}
    </span>
  )
}

export default function AdminAccessMatrix({ organizations, locationsByOrg, staff }) {
  const router = useRouter()
  const [filter, setFilter] = useState('')
  const [openUserId, setOpenUserId] = useState(null)
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [masterToggleTarget, setMasterToggleTarget] = useState(null) // user object
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkError, setBulkError] = useState(null)

  // Bulk operation form state.
  const [bulkLocationId, setBulkLocationId] = useState('')
  const [bulkRole, setBulkRole] = useState('staff') // or 'remove'

  const visibleStaff = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return staff
    return staff.filter(s =>
      (s.full_name || '').toLowerCase().includes(q) ||
      (s.email || '').toLowerCase().includes(q)
    )
  }, [staff, filter])

  const rolesByStaffByLoc = useMemo(() => {
    const m = {}
    for (const s of staff) {
      m[s.id] = {}
      for (const link of (s.profile_locations || [])) {
        if (link?.location_id) m[s.id][link.location_id] = link
      }
    }
    return m
  }, [staff])

  const currentMasterCount = useMemo(
    () => staff.filter(s => s.role === 'master' && s.active).length,
    [staff]
  )

  function toggleSelected(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  function clearSelection() {
    setSelectedIds(new Set())
  }
  function selectAllVisible() {
    setSelectedIds(new Set(visibleStaff.map((s) => s.id)))
  }

  const openUser = staff.find((s) => s.id === openUserId) || null

  // Master toggle handler — triggers a confirmation modal first.
  async function confirmMasterToggle() {
    const target = masterToggleTarget
    if (!target) return
    const action = target.role === 'master' ? 'demote' : 'promote'
    setBulkBusy(true)
    setBulkError(null)
    try {
      const r = await fetch('/api/admin/master-toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, profile_id: target.id }),
      })
      const body = await r.json()
      if (!r.ok || body.success === false) {
        throw new Error(body.error || `${action} failed (${r.status})`)
      }
      setMasterToggleTarget(null)
      router.refresh()
    } catch (e) {
      setBulkError(e.message || 'Master toggle failed')
    } finally {
      setBulkBusy(false)
    }
  }

  // Bulk operation handler.
  async function applyBulk() {
    if (selectedIds.size === 0 || !bulkLocationId) {
      setBulkError('Pick a location and at least one user.')
      return
    }
    setBulkBusy(true)
    setBulkError(null)
    try {
      const pairs = Array.from(selectedIds).map((profile_id) => ({
        profile_id,
        location_id: bulkLocationId,
      }))
      const reqBody = bulkRole === 'remove'
        ? { action: 'delete', pairs }
        : { action: 'upsert', role: bulkRole, pairs }
      const r = await fetch('/api/admin/assignments/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
      })
      const body = await r.json()
      if (!r.ok || body.success === false) {
        throw new Error(body.error || `Bulk failed (${r.status})`)
      }
      // Show summary briefly, then clear.
      const failed = (body.results || []).filter((x) => x.outcome === 'failed')
      if (failed.length > 0) {
        setBulkError(`${failed.length} of ${pairs.length} pairs failed: ${failed.slice(0, 3).map((f) => f.reason).join('; ')}${failed.length > 3 ? '…' : ''}`)
      } else {
        clearSelection()
      }
      router.refresh()
    } catch (e) {
      setBulkError(e.message || 'Bulk apply failed')
    } finally {
      setBulkBusy(false)
    }
  }

  return (
    <>
      <div className="bg-un1t-surface border border-un1t-border rounded-lg p-5">
        {/* Filter + bulk select controls */}
        <div className="mb-4 flex items-center gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-un1t-muted pointer-events-none" />
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by name or email…"
              className="w-full pl-8 pr-3 py-1.5 text-sm bg-un1t-bg border border-un1t-border rounded-md text-un1t-text placeholder:text-un1t-muted focus:outline-none focus:border-un1t-muted"
            />
          </div>
          {selectedIds.size > 0 ? (
            <button
              type="button"
              onClick={clearSelection}
              className="text-xs text-un1t-subtle hover:text-un1t-text"
            >
              Clear ({selectedIds.size})
            </button>
          ) : (
            <button
              type="button"
              onClick={selectAllVisible}
              className="text-xs text-un1t-subtle hover:text-un1t-text"
            >
              Select all visible
            </button>
          )}
        </div>

        <div className="overflow-x-auto -mx-1 px-1">
          <table className="text-xs border-collapse w-full">
            <thead>
              <tr>
                <th className="sticky left-0 z-10 bg-un1t-surface p-2 w-8"></th>
                <th className="sticky left-8 z-10 bg-un1t-surface text-left p-2 font-medium text-un1t-subtle min-w-[200px]">
                  User
                </th>
                {organizations.map(org => {
                  const locs = locationsByOrg[org.id] || []
                  if (locs.length === 0) return null
                  return (
                    <th
                      key={`org-h-${org.id}`}
                      colSpan={locs.length}
                      className="px-2 py-1 text-center font-semibold text-un1t-subtle bg-un1t-border/30 text-[11px] uppercase tracking-wider border-l border-un1t-border"
                    >
                      <div className="inline-flex items-center gap-1.5">
                        <Building2 size={11} /> {org.name}
                      </div>
                    </th>
                  )
                })}
                <th className="px-2 py-1 text-center font-medium text-un1t-subtle w-[80px] border-l border-un1t-border">
                  Master
                </th>
              </tr>
              <tr>
                <th className="sticky left-0 z-10 bg-un1t-surface p-2"></th>
                <th className="sticky left-8 z-10 bg-un1t-surface p-2"></th>
                {organizations.map(org => (
                  (locationsByOrg[org.id] || []).map(loc => (
                    <th
                      key={loc.id}
                      className="px-2 py-1.5 text-left font-medium text-un1t-subtle whitespace-nowrap text-[11px]"
                    >
                      {loc.name}
                    </th>
                  ))
                ))}
                <th className="px-2 py-1.5"></th>
              </tr>
            </thead>
            <tbody>
              {visibleStaff.length === 0 && (
                <tr>
                  <td colSpan={99} className="p-6 text-center text-un1t-subtle text-sm">
                    No users match &ldquo;{filter}&rdquo;.
                  </td>
                </tr>
              )}
              {visibleStaff.map(s => (
                <tr key={s.id} className="hover:bg-un1t-border/10 group">
                  <td className="sticky left-0 z-10 bg-un1t-surface px-2 py-1.5 text-center">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(s.id)}
                      onChange={() => toggleSelected(s.id)}
                      className="cursor-pointer"
                      aria-label={`Select ${s.full_name}`}
                    />
                  </td>
                  <td className="sticky left-8 z-10 bg-un1t-surface px-2 py-1.5">
                    <button
                      type="button"
                      onClick={() => setOpenUserId(s.id)}
                      className="block text-left hover:text-blue-700 transition-colors"
                    >
                      <div className="font-medium text-un1t-text whitespace-nowrap">{s.full_name}</div>
                      <div className="text-[10px] text-un1t-subtle truncate max-w-[220px]">{s.email}</div>
                    </button>
                  </td>
                  {organizations.map(org => (
                    (locationsByOrg[org.id] || []).map(loc => (
                      <td key={loc.id} className="px-2 py-1.5">
                        <RoleCell link={rolesByStaffByLoc[s.id]?.[loc.id]} />
                      </td>
                    ))
                  ))}
                  <td className="px-2 py-1.5 text-center border-l border-un1t-border/40">
                    <button
                      type="button"
                      onClick={() => setMasterToggleTarget(s)}
                      className={`inline-flex items-center gap-1 transition-colors ${s.role === 'master' ? 'text-amber-700 hover:text-amber-800' : 'text-un1t-muted hover:text-un1t-subtle'}`}
                      title={s.role === 'master'
                        ? `Currently master. ${currentMasterCount === 1 ? 'CANNOT demote — last active master.' : 'Click to demote.'}`
                        : 'Click to promote to master'}
                    >
                      <ShieldCheck size={12} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="mt-4 text-[11px] text-un1t-subtle">
          Click a user to edit their assignments. Click the master shield to promote / demote.
          {' '}Multi-select with the checkboxes to apply a role at one location to many users at once.
          The platform must always have at least one active master — demoting the last one is blocked
          server-side.
        </p>
      </div>

      {/* Side panel for editing one user */}
      {openUser && (
        <UserAssignmentsPanel
          user={openUser}
          organizations={organizations}
          locationsByOrg={locationsByOrg}
          currentMasterCount={currentMasterCount}
          onClose={() => setOpenUserId(null)}
        />
      )}

      {/* Master toggle confirmation modal */}
      {masterToggleTarget && (
        <MasterToggleConfirm
          target={masterToggleTarget}
          currentMasterCount={currentMasterCount}
          busy={bulkBusy}
          error={bulkError}
          onCancel={() => { setMasterToggleTarget(null); setBulkError(null) }}
          onConfirm={confirmMasterToggle}
        />
      )}

      {/* Sticky bulk action bar */}
      {selectedIds.size > 0 && (
        <BulkActionBar
          selectedCount={selectedIds.size}
          organizations={organizations}
          locationsByOrg={locationsByOrg}
          locationId={bulkLocationId}
          role={bulkRole}
          busy={bulkBusy}
          error={bulkError}
          onLocationChange={setBulkLocationId}
          onRoleChange={setBulkRole}
          onApply={applyBulk}
          onClear={clearSelection}
        />
      )}
    </>
  )
}

function MasterToggleConfirm({ target, currentMasterCount, busy, error, onCancel, onConfirm }) {
  const isPromote = target.role !== 'master'
  const wouldOrphan = !isPromote && currentMasterCount <= 1

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-50" onClick={() => !busy && onCancel()} aria-hidden="true" />
      <div role="dialog" className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 bg-un1t-bg border border-un1t-border rounded-lg p-6 w-[420px] max-w-[90vw] shadow-2xl">
        <div className="flex items-start justify-between gap-3 mb-4">
          <h3 className="text-base font-semibold text-un1t-text inline-flex items-center gap-2">
            <ShieldCheck size={16} className="text-amber-700" />
            {isPromote ? 'Promote to master?' : 'Demote master?'}
          </h3>
          <button type="button" onClick={() => !busy && onCancel()} disabled={busy} className="text-un1t-subtle hover:text-un1t-text disabled:opacity-40">
            <X size={16} />
          </button>
        </div>

        <p className="text-sm text-un1t-subtle mb-2">
          <span className="text-un1t-text font-medium">{target.full_name}</span> ({target.email})
        </p>
        <p className="text-xs text-un1t-subtle mb-4">
          {isPromote
            ? 'Master users see and modify every organization\'s data. They can also promote / demote other masters. Their existing per-location assignments remain in effect.'
            : 'Demoting will remove platform-wide access. Their per-location assignments stay in place; they\'ll be visible to whatever the fallback role allows.'}
        </p>

        {wouldOrphan && (
          <div className="text-xs text-amber-700 bg-amber-500/10 border border-amber-500/30 rounded-md p-2 mb-3 inline-flex items-start gap-2">
            <AlertCircle size={12} className="mt-0.5 shrink-0" />
            This is the last active master. Promote another user to master before demoting this one.
          </div>
        )}
        {error && (
          <div className="text-xs text-red-700 bg-red-500/10 border border-red-500/30 rounded-md p-2 mb-3 inline-flex items-start gap-2">
            <AlertCircle size={12} className="mt-0.5 shrink-0" /> {error}
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={() => !busy && onCancel()} disabled={busy} className="text-sm text-un1t-subtle hover:text-un1t-text disabled:opacity-40">
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy || wouldOrphan}
            className={`inline-flex items-center gap-1.5 text-sm font-semibold px-4 py-2 rounded-md disabled:opacity-40 ${isPromote ? 'bg-un1t-text text-un1t-bg hover:bg-un1t-accent' : 'bg-red-500 text-white hover:bg-red-600'}`}
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
            {busy ? 'Working…' : (isPromote ? 'Promote' : 'Demote')}
          </button>
        </div>
      </div>
    </>
  )
}

function BulkActionBar({
  selectedCount, organizations, locationsByOrg,
  locationId, role, busy, error,
  onLocationChange, onRoleChange, onApply, onClear,
}) {
  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 bg-un1t-bg border border-un1t-border rounded-lg shadow-2xl p-4 flex items-center gap-3 max-w-[95vw]">
      <div className="text-sm font-medium text-un1t-text whitespace-nowrap">
        {selectedCount} selected
      </div>

      <select
        value={locationId}
        onChange={(e) => onLocationChange(e.target.value)}
        disabled={busy}
        className="text-sm bg-un1t-surface border border-un1t-border rounded px-2 py-1.5 text-un1t-text disabled:opacity-40"
      >
        <option value="">Pick a location…</option>
        {organizations.map((org) => {
          const locs = locationsByOrg[org.id] || []
          if (locs.length === 0) return null
          return (
            <optgroup key={org.id} label={org.name}>
              {locs.map((loc) => (
                <option key={loc.id} value={loc.id}>{loc.name}</option>
              ))}
            </optgroup>
          )
        })}
      </select>

      <select
        value={role}
        onChange={(e) => onRoleChange(e.target.value)}
        disabled={busy}
        className="text-sm bg-un1t-surface border border-un1t-border rounded px-2 py-1.5 text-un1t-text disabled:opacity-40"
      >
        {PERMISSION_ROLE_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>Set as {o.label}</option>
        ))}
        <option value="remove">Remove from location</option>
      </select>

      <button
        type="button"
        onClick={onApply}
        disabled={busy || !locationId}
        className="inline-flex items-center gap-1.5 text-sm bg-un1t-text text-un1t-bg font-semibold px-4 py-2 rounded-md hover:bg-un1t-accent disabled:opacity-40"
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : null}
        {busy ? 'Applying…' : 'Apply'}
      </button>

      <button
        type="button"
        onClick={onClear}
        disabled={busy}
        className="text-un1t-subtle hover:text-un1t-text disabled:opacity-40 p-1"
        title="Clear selection"
      >
        <X size={14} />
      </button>

      {error && (
        <div className="absolute -top-12 left-0 right-0 text-xs text-red-700 bg-red-500/10 border border-red-500/30 rounded-md p-2 inline-flex items-start gap-2">
          <AlertCircle size={12} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}
    </div>
  )
}
