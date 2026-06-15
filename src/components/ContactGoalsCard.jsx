'use client'
// ContactGoalsCard.jsx — CONSULTATIONS SP1
//
// Member goals on the contact profile's Consultations tab. Goals are
// shared into the member-facing champ app (SP3) via the customer-self
// RLS policy on coaching_goals, so the copy here stays member-appropriate
// (no internal jargon).
//
// Props:
//   contactId — string UUID of the contact the goals belong to
//   goals     — Array<coaching_goals row> (unsorted; we sortGoals() here)
//
// Mutations hit the goals API:
//   POST   /api/contacts/{id}/goals             → create
//   PUT    /api/contacts/{id}/goals/{gid}        → edit / achieve / drop
//   DELETE /api/contacts/{id}/goals/{gid}        → delete
// On success: router.refresh() to reload the server-rendered tab.
// On failure: inline error (doesn't crash the card).
//
// Every non-submit <button> is type="button" (CLAUDE.md convention —
// this card can render inside a form via the tab system).

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Target, AlertCircle } from 'lucide-react'
import { Card, Button, Field } from '@/components/ui'
import { sortGoals } from '@/lib/consultations-view'

const STATUS_META = {
  open:     { label: 'Open',     cls: 'bg-blue-500/10 text-blue-700' },
  achieved: { label: 'Achieved', cls: 'bg-emerald-500/10 text-emerald-700' },
  dropped:  { label: 'Dropped',  cls: 'bg-un1t-text/[0.06] text-un1t-subtle' },
}

function formatGoalDate(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return null
  return d.toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric' })
}

// ─── One goal row ────────────────────────────────────────────────────────────

function GoalRow({ goal, busyId, onMutate }) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(goal.title || '')
  const [detail, setDetail] = useState(goal.detail || '')
  const [targetValue, setTargetValue] = useState(goal.target_value || '')
  const [targetDate, setTargetDate] = useState(goal.target_date || '')

  const meta = STATUS_META[goal.status] || STATUS_META.open
  const isBusy = busyId === goal.id
  const isOpen = goal.status === 'open'

  async function saveEdit(e) {
    e.preventDefault()
    if (!title.trim()) return
    const ok = await onMutate(goal.id, 'PUT', {
      title: title.trim(),
      detail: detail.trim() || undefined,
      target_value: targetValue.trim() || undefined,
      target_date: targetDate || undefined,
    })
    if (ok) setEditing(false)
  }

  if (editing) {
    return (
      <form onSubmit={saveEdit} className="py-3 border-b border-un1t-border/50 last:border-b-0 space-y-2">
        <Field id={`goal-title-${goal.id}`} label="Goal" required>
          {(p) => (
            <input
              {...p}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full rounded-md border border-un1t-border bg-un1t-bg px-3 py-2 text-sm text-un1t-text"
            />
          )}
        </Field>
        <Field id={`goal-detail-${goal.id}`} label="Detail">
          {(p) => (
            <textarea
              {...p}
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
              rows={2}
              className="w-full rounded-md border border-un1t-border bg-un1t-bg px-3 py-2 text-sm text-un1t-text"
            />
          )}
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field id={`goal-target-${goal.id}`} label="Target">
            {(p) => (
              <input
                {...p}
                value={targetValue}
                onChange={(e) => setTargetValue(e.target.value)}
                placeholder="e.g. 75 kg"
                className="w-full rounded-md border border-un1t-border bg-un1t-bg px-3 py-2 text-sm text-un1t-text"
              />
            )}
          </Field>
          <Field id={`goal-date-${goal.id}`} label="Target date">
            {(p) => (
              <input
                {...p}
                type="date"
                value={targetDate}
                onChange={(e) => setTargetDate(e.target.value)}
                className="w-full rounded-md border border-un1t-border bg-un1t-bg px-3 py-2 text-sm text-un1t-text"
              />
            )}
          </Field>
        </div>
        <div className="flex items-center gap-2">
          <Button type="submit" size="sm" loading={isBusy} disabled={!title.trim()}>Save</Button>
          <Button type="button" variant="ghost" size="sm" disabled={isBusy} onClick={() => setEditing(false)}>Cancel</Button>
        </div>
      </form>
    )
  }

  const targetDateStr = formatGoalDate(goal.target_date)

  return (
    <div className="py-3 border-b border-un1t-border/50 last:border-b-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-sm font-medium ${goal.status === 'dropped' ? 'line-through text-un1t-muted' : 'text-un1t-text'}`}>
              {goal.title}
            </span>
            <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${meta.cls}`}>{meta.label}</span>
          </div>
          {goal.detail && <p className="text-xs text-un1t-subtle mt-1 whitespace-pre-wrap">{goal.detail}</p>}
          {(goal.target_value || targetDateStr) && (
            <p className="text-xs text-un1t-muted mt-1">
              {goal.target_value && <span>Target: {goal.target_value}</span>}
              {goal.target_value && targetDateStr && <span> · </span>}
              {targetDateStr && <span>by {targetDateStr}</span>}
            </p>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1 mt-2 flex-wrap">
        {isOpen && (
          <Button type="button" variant="ghost" size="sm" loading={isBusy} onClick={() => onMutate(goal.id, 'PUT', { status: 'achieved' })}>
            Achieve
          </Button>
        )}
        {isOpen && (
          <Button type="button" variant="ghost" size="sm" disabled={isBusy} onClick={() => onMutate(goal.id, 'PUT', { status: 'dropped' })}>
            Drop
          </Button>
        )}
        {!isOpen && (
          <Button type="button" variant="ghost" size="sm" disabled={isBusy} onClick={() => onMutate(goal.id, 'PUT', { status: 'open' })}>
            Reopen
          </Button>
        )}
        <Button type="button" variant="ghost" size="sm" disabled={isBusy} onClick={() => setEditing(true)}>Edit</Button>
        <Button type="button" variant="ghost" size="sm" disabled={isBusy} onClick={() => onMutate(goal.id, 'DELETE')}>Delete</Button>
      </div>
    </div>
  )
}

// ─── Card ────────────────────────────────────────────────────────────────────

export default function ContactGoalsCard({ contactId, goals }) {
  const router = useRouter()
  const sorted = sortGoals(goals)

  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const [detail, setDetail] = useState('')
  const [targetValue, setTargetValue] = useState('')
  const [targetDate, setTargetDate] = useState('')
  const [busyId, setBusyId] = useState(null) // goal id, or 'new' for the add form
  const [error, setError] = useState(null)

  // PUT/DELETE on an existing goal. Returns true on success.
  async function mutateGoal(gid, method, body) {
    if (method === 'DELETE' && !window.confirm('Delete this goal?')) return false
    setBusyId(gid)
    setError(null)
    try {
      const r = await fetch(`/api/contacts/${contactId}/goals/${gid}`, {
        method,
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j.success === false) {
        setError(j.error || `Failed (${r.status})`)
        return false
      }
      router.refresh()
      return true
    } catch (e) {
      setError(e?.message || 'Network error')
      return false
    } finally {
      setBusyId(null)
    }
  }

  async function addGoal(e) {
    e.preventDefault()
    if (!title.trim()) return
    setBusyId('new')
    setError(null)
    try {
      const r = await fetch(`/api/contacts/${contactId}/goals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          detail: detail.trim() || undefined,
          target_value: targetValue.trim() || undefined,
          target_date: targetDate || undefined,
        }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j.success === false) {
        setError(j.error || `Failed (${r.status})`)
        return
      }
      setTitle(''); setDetail(''); setTargetValue(''); setTargetDate('')
      setAdding(false)
      router.refresh()
    } catch (e) {
      setError(e?.message || 'Network error')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Card
      title="Goals"
      actions={
        !adding && (
          <Button type="button" variant="secondary" size="sm" icon={Target} onClick={() => setAdding(true)}>
            Add goal
          </Button>
        )
      }
    >
      {error && (
        <p className="text-xs text-red-700 mb-3 flex items-center gap-1">
          <AlertCircle size={12} className="shrink-0" />
          {error}
        </p>
      )}

      {adding && (
        <form onSubmit={addGoal} className="mb-4 space-y-2 rounded-md border border-un1t-border bg-un1t-bg/50 p-3">
          <Field id="new-goal-title" label="Goal" required>
            {(p) => (
              <input
                {...p}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Run 5k without stopping"
                className="w-full rounded-md border border-un1t-border bg-un1t-bg px-3 py-2 text-sm text-un1t-text"
              />
            )}
          </Field>
          <Field id="new-goal-detail" label="Detail">
            {(p) => (
              <textarea
                {...p}
                value={detail}
                onChange={(e) => setDetail(e.target.value)}
                rows={2}
                placeholder="Optional — extra context for this goal"
                className="w-full rounded-md border border-un1t-border bg-un1t-bg px-3 py-2 text-sm text-un1t-text"
              />
            )}
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field id="new-goal-target" label="Target">
              {(p) => (
                <input
                  {...p}
                  value={targetValue}
                  onChange={(e) => setTargetValue(e.target.value)}
                  placeholder="e.g. 75 kg"
                  className="w-full rounded-md border border-un1t-border bg-un1t-bg px-3 py-2 text-sm text-un1t-text"
                />
              )}
            </Field>
            <Field id="new-goal-date" label="Target date">
              {(p) => (
                <input
                  {...p}
                  type="date"
                  value={targetDate}
                  onChange={(e) => setTargetDate(e.target.value)}
                  className="w-full rounded-md border border-un1t-border bg-un1t-bg px-3 py-2 text-sm text-un1t-text"
                />
              )}
            </Field>
          </div>
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" loading={busyId === 'new'} disabled={!title.trim()}>Save goal</Button>
            <Button type="button" variant="ghost" size="sm" disabled={busyId === 'new'} onClick={() => { setAdding(false); setError(null) }}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {sorted.length === 0 && !adding && (
        <p className="text-sm text-un1t-subtle">No goals yet. Add one to track what this member is working towards.</p>
      )}

      {sorted.map((goal) => (
        <GoalRow
          key={goal.id}
          goal={goal}
          busyId={busyId}
          onMutate={mutateGoal}
        />
      ))}
    </Card>
  )
}
