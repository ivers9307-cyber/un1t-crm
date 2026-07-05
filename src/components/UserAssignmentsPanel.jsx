'use client'

// UserAssignmentsPanel — slide-in side panel that opens when a row in
// the AdminAccessMatrix is clicked. Edits one user's assignments in
// place: per-location role changes, removals, additions, and the
// master toggle.
//
// Save model: explicit Save button (this is destructive enough to want
// intent confirmation). Diffs the in-panel state against the snapshot
// loaded on open and dispatches the minimal set of API calls:
//   - per-cell role change      → POST /api/admin/assignments action=update
//   - per-cell removal          → POST /api/admin/assignments action=delete
//   - per-cell addition         → POST /api/admin/assignments action=create
//   - master toggle             → POST /api/admin/master-toggle
//
// Each API call lands sequentially so a failure mid-save halts the rest
// (avoids leaving a partial state when the cause is operational, e.g.
// the at-least-one-master guard tripping). The user sees the failed
// operation called out, and the matrix re-renders from server state on
// close so partial successes are visible.

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { X, Plus, Trash2, ShieldCheck, AlertCircle, Save, Loader2 } from 'lucide-react'

const ROLE_OPTIONS = [
  { value: 'owner', label: 'Owner' },
  { value: 'manager', label: 'Manager' },
  { value: 'head_coach', label: 'Head Coach' },
  { value: 'staff', label: 'Staff' },
  { value: 'reception', label: 'Reception' },
]

export default function UserAssignmentsPanel({
  user,                  // { id, full_name, email, role, profile_locations: [...] }
  organizations,
  locationsByOrg,
  currentMasterCount,    // for the master toggle UX (warn when demoting last master before the API does)
  onClose,
}) {
  const router = useRouter()

  // Snapshot of the ON-OPEN state, used to compute the save diff.
  const initialAssignments = useMemo(() => {
    const m = {}
    for (const link of (user.profile_locations || [])) {
      if (link?.location_id) {
        m[link.location_id] = link.role
      }
    }
    return m
  }, [user])
  const initialIsMaster = user.role === 'master'

  const [assignments, setAssignments] = useState(initialAssignments)
  const [isMaster, setIsMaster] = useState(initialIsMaster)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [savedSummary, setSavedSummary] = useState(null)

  // Close on Escape.
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  function setRoleAt(locationId, role) {
    setAssignments((prev) => ({ ...prev, [locationId]: role }))
  }
  function removeAt(locationId) {
    setAssignments((prev) => {
      const next = { ...prev }
      delete next[locationId]
      return next
    })
  }
  function addAt(locationId, role = 'staff') {
    setRoleAt(locationId, role)
  }

  // Build the diff against the initial snapshot.
  const diff = useMemo(() => {
    const ops = []
    // Removed: was in initial, not in current.
    for (const locId of Object.keys(initialAssignments)) {
      if (!(locId in assignments)) {
        ops.push({ kind: 'delete', location_id: locId })
      }
    }
    // Added: in current, not in initial.
    for (const locId of Object.keys(assignments)) {
      if (!(locId in initialAssignments)) {
        ops.push({ kind: 'create', location_id: locId, role: assignments[locId] })
      } else if (initialAssignments[locId] !== assignments[locId]) {
        ops.push({ kind: 'update', location_id: locId, role: assignments[locId] })
      }
    }
    const masterChanged = isMaster !== initialIsMaster
    return { assignments: ops, masterToggle: masterChanged ? (isMaster ? 'promote' : 'demote') : null }
  }, [assignments, initialAssignments, isMaster, initialIsMaster])

  const hasChanges = diff.assignments.length > 0 || diff.masterToggle !== null

  // Surface a heads-up before the user tries to demote the last master.
  // The API enforces this regardless; this is just a friendlier upfront
  // signal so they don't click Save and then bounce.
  const wouldDemoteLastMaster = (
    diff.masterToggle === 'demote' &&
    initialIsMaster &&
    currentMasterCount <= 1
  )

  async function handleSave() {
    if (!hasChanges) return
    if (wouldDemoteLastMaster) {
      setError('Cannot demote the last active master. Promote another user to master first.')
      return
    }

    setBusy(true)
    setError(null)
    setSavedSummary(null)

    const summary = { created: 0, updated: 0, deleted: 0, master: null }

    try {
      // Process master toggle FIRST when promoting (so subsequent assignment
      // operations on a now-master target are unrestricted), and LAST when
      // demoting (so the user remains master until their last assignment-
      // related operation completes — minimises the window where the matrix
      // looks half-edited if a guard trips mid-save).
      if (diff.masterToggle === 'promote') {
        const r = await fetch('/api/admin/master-toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'promote', profile_id: user.id }),
        })
        const body = await r.json()
        if (!r.ok || body.success === false) {
          throw new Error(body.error || `Promote failed (${r.status})`)
        }
        summary.master = 'promoted'
      }

      for (const op of diff.assignments) {
        const r = await fetch('/api/admin/assignments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: op.kind,
            profile_id: user.id,
            location_id: op.location_id,
            ...(op.role ? { role: op.role } : {}),
          }),
        })
        const body = await r.json()
        if (!r.ok || body.success === false) {
          throw new Error(body.error || `${op.kind} at ${op.location_id} failed (${r.status})`)
        }
        if (op.kind === 'create') summary.created++
        else if (op.kind === 'update') summary.updated++
        else if (op.kind === 'delete') summary.deleted++
      }

      if (diff.masterToggle === 'demote') {
        const r = await fetch('/api/admin/master-toggle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'demote', profile_id: user.id }),
        })
        const body = await r.json()
        if (!r.ok || body.success === false) {
          throw new Error(body.error || `Demote failed (${r.status})`)
        }
        summary.master = 'demoted'
      }

      setSavedSummary(summary)
      router.refresh()
      // Auto-close after a brief moment so the user sees the success state.
      setTimeout(onClose, 750)
    } catch (e) {
      setError(e.message || 'Save failed')
      // Don't close — let them retry or undo.
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/40 z-40"
        onClick={() => !busy && onClose()}
        aria-hidden="true"
      />
      {/* Panel */}
      <div
        role="dialog"
        aria-label={`Edit assignments for ${user.full_name}`}
        className="fixed top-0 right-0 bottom-0 w-full sm:w-[480px] bg-un1t-bg border-l border-un1t-border z-50 overflow-y-auto"
      >
        <header className="sticky top-0 bg-un1t-bg border-b border-un1t-border p-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-un1t-text truncate">{user.full_name}</h3>
            <p className="text-xs text-un1t-subtle truncate">{user.email}</p>
          </div>
          <button
            type="button"
            onClick={() => !busy && onClose()}
            disabled={busy}
            className="text-un1t-subtle hover:text-un1t-text disabled:opacity-40"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </header>

        <div className="p-4 space-y-6">
          {/* Master toggle */}
          <section>
            <h4 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-2">Platform role</h4>
            <label className="flex items-start gap-2 p-3 bg-un1t-surface border border-un1t-border rounded-md cursor-pointer hover:border-un1t-muted">
              <input
                type="checkbox"
                checked={isMaster}
                onChange={(e) => setIsMaster(e.target.checked)}
                className="mt-0.5"
                disabled={busy}
              />
              <span className="flex-1">
                <span className="block text-sm font-medium text-un1t-text inline-flex items-center gap-1.5">
                  <ShieldCheck size={12} className="text-amber-700" /> Master (platform admin)
                </span>
                <span className="block text-[11px] text-un1t-subtle mt-0.5">
                  Sees and modifies every organization&apos;s data. Per-location role assignments
                  below remain in effect even when master is on.
                </span>
                {wouldDemoteLastMaster && (
                  <span className="block mt-2 text-[11px] text-amber-700 inline-flex items-start gap-1.5">
                    <AlertCircle size={11} className="mt-0.5 shrink-0" />
                    There&apos;s only one active master. Promote another user to master before saving this change.
                  </span>
                )}
              </span>
            </label>
          </section>

          {/* Per-org assignments */}
          {organizations.map((org) => {
            const locs = locationsByOrg[org.id] || []
            if (locs.length === 0) return null
            return (
              <section key={org.id}>
                <h4 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-2">{org.name}</h4>
                <div className="space-y-1.5">
                  {locs.map((loc) => {
                    const currentRole = assignments[loc.id]
                    const hasRole = !!currentRole
                    return (
                      <div
                        key={loc.id}
                        className="flex items-center gap-2 p-2 bg-un1t-surface border border-un1t-border rounded-md"
                      >
                        <div className="flex-1 min-w-0 text-sm text-un1t-text truncate">{loc.name}</div>
                        {hasRole ? (
                          <>
                            <select
                              value={currentRole}
                              onChange={(e) => setRoleAt(loc.id, e.target.value)}
                              disabled={busy}
                              className="text-xs bg-un1t-bg border border-un1t-border rounded px-2 py-1 text-un1t-text disabled:opacity-40"
                            >
                              {ROLE_OPTIONS.map((o) => (
                                <option key={o.value} value={o.value}>{o.label}</option>
                              ))}
                            </select>
                            <button
                              type="button"
                              onClick={() => removeAt(loc.id)}
                              disabled={busy}
                              className="text-un1t-subtle hover:text-red-700 disabled:opacity-40 p-1"
                              title="Remove from this location"
                            >
                              <Trash2 size={14} />
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            onClick={() => addAt(loc.id)}
                            disabled={busy}
                            className="text-xs text-blue-700 hover:text-blue-800 disabled:opacity-40 inline-flex items-center gap-1"
                          >
                            <Plus size={12} /> Add as Staff
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
              </section>
            )
          })}

          {error && (
            <div className="text-xs text-red-700 bg-red-500/10 border border-red-500/30 rounded-md p-2 inline-flex items-start gap-2">
              <AlertCircle size={12} className="mt-0.5 shrink-0" /> {error}
            </div>
          )}
          {savedSummary && !error && (
            <div className="text-xs text-green-700 bg-green-500/10 border border-green-500/30 rounded-md p-2">
              Saved: {savedSummary.created} added, {savedSummary.updated} updated, {savedSummary.deleted} removed
              {savedSummary.master && `, master ${savedSummary.master}`}.
            </div>
          )}
        </div>

        <footer className="sticky bottom-0 bg-un1t-bg border-t border-un1t-border p-4 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => !busy && onClose()}
            disabled={busy}
            className="text-sm text-un1t-subtle hover:text-un1t-text disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={busy || !hasChanges || wouldDemoteLastMaster}
            className="inline-flex items-center gap-1.5 text-sm bg-un1t-text text-un1t-bg font-semibold px-4 py-2 rounded-md hover:bg-un1t-accent disabled:opacity-40"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {busy ? 'Saving…' : `Save${hasChanges ? ` (${diff.assignments.length + (diff.masterToggle ? 1 : 0)})` : ''}`}
          </button>
        </footer>
      </div>
    </>
  )
}
