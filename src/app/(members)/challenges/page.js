'use client'

// /challenges — operator index of engagement challenges at the active location.
// Manager-gated: requires the 'challenges' permission (manager+ by default).
// Lists challenges grouped by phase (upcoming / active / past).
// "New challenge" button + per-row Edit/Delete actions backed by ChallengeForm.

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Trophy, Pencil, Trash2, Loader2 } from 'lucide-react'
import ChallengeForm from '@/components/ChallengeForm'
import { challengePhase } from '@/lib/challenges'

// Human-readable labels for the stored enum values.
const MODE_LABEL = {
  individual: 'Individual ranked',
  collective: 'Collective goal',
}

const METRIC_LABEL = {
  points:         'UN1T Points',
  classes:        'Classes',
  z4plus_minutes: 'Z4+ minutes',
}

const PHASE_ORDER  = ['active', 'upcoming', 'ended']
const PHASE_LABEL  = { active: 'Active', upcoming: 'Upcoming', ended: 'Past' }
const PHASE_TONE   = {
  active:   'bg-emerald-500/15 text-emerald-700',
  upcoming: 'bg-sky-500/15 text-sky-700',
  ended:    'bg-gray-500/15 text-gray-500',
}

export default function ChallengesPage() {
  const router = useRouter()

  const [challenges,  setChallenges]  = useState(null)  // null = loading
  const [loadError,   setLoadError]   = useState(null)
  const [modal,       setModal]       = useState(null)  // null | 'new' | { editing: challenge }
  const [deleting,    setDeleting]    = useState(null)  // id being deleted
  const [deleteError, setDeleteError] = useState(null)

  // --- fetch ---
  const load = useCallback(async () => {
    setLoadError(null)
    try {
      const res  = await fetch('/api/challenges')
      const json = await res.json()
      if (!res.ok || json.success === false) {
        if (res.status === 401 || res.status === 403) {
          router.replace('/')
          return
        }
        setLoadError(json.error || `Failed to load (${res.status})`)
        return
      }
      setChallenges(json.data || [])
    } catch (e) {
      setLoadError(e.message || 'Network error')
    }
  }, [router])

  useEffect(() => { load() }, [load])

  // --- delete ---
  async function handleDelete(c) {
    if (!window.confirm(`Delete "${c.name}"? This cannot be undone.`)) return
    setDeleteError(null)
    setDeleting(c.id)
    try {
      const res  = await fetch(`/api/challenges/${c.id}`, { method: 'DELETE' })
      const json = await res.json()
      if (!res.ok || json.success === false) {
        setDeleteError(json.error || `Delete failed (${res.status})`)
        return
      }
      setChallenges((prev) => prev.filter((x) => x.id !== c.id))
    } catch (e) {
      setDeleteError(e.message || 'Network error')
    } finally {
      setDeleting(null)
    }
  }

  // --- group by phase ---
  const grouped = challenges
    ? PHASE_ORDER.reduce((acc, phase) => {
        acc[phase] = challenges.filter((c) => challengePhase(c) === phase)
        return acc
      }, {})
    : {}

  const locationId =
    typeof window !== 'undefined'
      ? (() => {
          try {
            // Read from the un1t_active_location cookie (best-effort; falls
            // back to undefined so the API resolves it server-side anyway).
            const m = document.cookie.match(/un1t_active_location=([^;]+)/)
            return m ? decodeURIComponent(m[1]) : undefined
          } catch { return undefined }
        })()
      : undefined

  // --- modal helpers ---
  function openNew()          { setModal('new') }
  function openEdit(c)        { setModal({ editing: c }) }
  function closeModal()       { setModal(null) }
  function onSaved()          { closeModal(); load() }

  // --- render ---
  if (challenges === null && !loadError) {
    return (
      <div className="p-8 flex items-center gap-2 text-un1t-subtle text-sm">
        <Loader2 size={14} className="animate-spin" /> Loading challenges…
      </div>
    )
  }

  if (loadError) {
    return (
      <div className="p-8 text-sm text-red-700">
        {loadError}
      </div>
    )
  }

  const isEditing = modal && modal !== 'new'

  return (
    <div className="p-8 max-w-4xl">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 mb-2">
        <h2 className="text-2xl font-bold">Challenges</h2>
        <button
          type="button"
          onClick={openNew}
          className="inline-flex items-center gap-1.5 text-xs bg-un1t-text text-un1t-bg px-3 py-1.5 rounded-md hover:bg-un1t-accent font-medium"
        >
          <Plus size={12} /> New challenge
        </button>
      </div>
      <p className="text-sm text-un1t-subtle mb-6">
        Member engagement challenges at this location — leaderboards and collective goals tracked against HR session data.
      </p>

      {deleteError && (
        <div className="mb-4 bg-red-500/10 border border-red-500/30 text-red-700 text-sm rounded-lg p-3">
          {deleteError}
        </div>
      )}

      {/* Modal (inline) */}
      {modal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40"
          onClick={(e) => { if (e.target === e.currentTarget) closeModal() }}
        >
          <div className="bg-un1t-bg border border-un1t-border rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-un1t-text">
                {isEditing ? `Edit "${modal.editing.name}"` : 'New challenge'}
              </h3>
              <button
                type="button"
                onClick={closeModal}
                className="text-xs text-un1t-subtle hover:text-un1t-text px-2 py-1 rounded"
              >
                Cancel
              </button>
            </div>
            <ChallengeForm
              challenge={isEditing ? modal.editing : undefined}
              locationId={locationId}
              onSaved={onSaved}
            />
          </div>
        </div>
      )}

      {/* Empty state */}
      {challenges.length === 0 && (
        <div className="bg-un1t-surface border border-un1t-border rounded-lg p-8 text-center">
          <Trophy size={28} className="mx-auto text-un1t-subtle mb-3" />
          <p className="text-sm text-un1t-subtle mb-4">
            No challenges yet. Create one to get started.
          </p>
          <button
            type="button"
            onClick={openNew}
            className="inline-flex items-center gap-1.5 text-xs bg-un1t-text text-un1t-bg px-3 py-1.5 rounded-md hover:bg-un1t-accent font-medium"
          >
            <Plus size={12} /> Create the first one
          </button>
        </div>
      )}

      {/* Phase sections */}
      {PHASE_ORDER.map((phase) => {
        const rows = grouped[phase] || []
        if (rows.length === 0) return null
        return (
          <section key={phase} className="mb-8">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-un1t-subtle mb-3">
              {PHASE_LABEL[phase]}
            </h3>
            <div className="bg-un1t-surface border border-un1t-border rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-un1t-border text-un1t-subtle text-[11px] uppercase tracking-wider">
                    <th className="text-left p-3">Name</th>
                    <th className="text-left p-3">Mode</th>
                    <th className="text-left p-3">Metric</th>
                    <th className="text-left p-3">Dates</th>
                    <th className="text-right p-3">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-un1t-border">
                  {rows.map((c) => (
                    <tr key={c.id} className="hover:bg-un1t-border/20">
                      {/* Name + phase chip */}
                      <td className="p-3">
                        <div className="font-medium text-un1t-text">{c.name}</div>
                        <span className={`inline-block mt-0.5 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full ${PHASE_TONE[phase]}`}>
                          {PHASE_LABEL[phase]}
                        </span>
                      </td>
                      {/* Mode */}
                      <td className="p-3 text-un1t-subtle text-xs">
                        {MODE_LABEL[c.mode] || c.mode}
                        {c.mode === 'collective' && c.target != null && (
                          <span className="ml-1 text-un1t-muted">
                            (target: {c.target.toLocaleString()})
                          </span>
                        )}
                      </td>
                      {/* Metric */}
                      <td className="p-3 text-un1t-subtle text-xs">
                        {METRIC_LABEL[c.metric] || c.metric}
                      </td>
                      {/* Dates */}
                      <td className="p-3 text-un1t-subtle text-xs whitespace-nowrap">
                        {c.starts_on} → {c.ends_on}
                      </td>
                      {/* Actions */}
                      <td className="p-3 text-right">
                        <div className="inline-flex items-center gap-3">
                          <button
                            type="button"
                            onClick={() => openEdit(c)}
                            className="inline-flex items-center gap-1 text-[11px] text-un1t-subtle hover:text-un1t-text"
                          >
                            <Pencil size={11} /> Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDelete(c)}
                            disabled={deleting === c.id}
                            className="inline-flex items-center gap-1 text-[11px] text-un1t-subtle hover:text-red-700 disabled:opacity-40"
                          >
                            {deleting === c.id
                              ? <Loader2 size={11} className="animate-spin" />
                              : <Trash2 size={11} />}
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )
      })}
    </div>
  )
}
