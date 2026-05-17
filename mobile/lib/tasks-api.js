// NOTIF.2 — mobile data helpers for Tasks.
//
// Mobile is a *read + complete* surface for tasks. Creation, deletion,
// reassignment all stay on the web (where the operator has a keyboard
// and a contact-detail context). Mobile shows:
//
//   - the list of tasks assigned to the signed-in user
//     at the active location (open + in-progress only by default)
//   - a detail view with status toggle (todo ↔ in_progress ↔ done)
//
// Direct Supabase calls (RLS handles scoping — same trust model as
// pipeline-api.js). The activities table is location-scoped via RLS
// (mig 014), so adding location_id filter is belt-and-braces.

import { supabase } from './supabase'

const TASK_SELECT = `
  id, subject, note, status, priority, project,
  due_date, due_time, assignee_id, contact_id, location_id,
  created_at, updated_at, completed_at,
  assignee:profiles!activities_assignee_id_fkey(id, full_name),
  contact:contacts(id, first_name, last_name, phone, email)
`

/**
 * Tasks assigned to a user at a location.
 *
 * Status filter defaults to ['todo','in_progress'] — "what's on my
 * plate". Pass { includeDone: true } to surface completed history.
 */
export async function listMyTasks({ locationId, profileId, includeDone = false }) {
  if (!locationId || !profileId) {
    return { success: false, error: 'locationId + profileId required' }
  }
  let q = supabase.from('activities')
    .select(TASK_SELECT)
    .eq('kind', 'task')
    .eq('location_id', locationId)
    .eq('assignee_id', profileId)
  if (!includeDone) {
    q = q.in('status', ['todo', 'in_progress'])
  }
  // Earliest due first, then by priority (urgent → low) so the
  // operator sees what's overdue first. SQL doesn't do enum-ordering
  // for free, so sort priority client-side after fetch.
  const { data, error } = await q.order('due_date', { ascending: true, nullsFirst: false })
  if (error) return { success: false, error: error.message }
  return { success: true, data: sortTasks(data || []) }
}

/**
 * Single task by id. Used by the detail screen — push notifications
 * carry the task_id and deep-link into here.
 */
export async function getTask(id) {
  if (!id) return { success: false, error: 'id required' }
  const { data, error } = await supabase.from('activities')
    .select(TASK_SELECT)
    .eq('id', id)
    .eq('kind', 'task')
    .maybeSingle()
  if (error) return { success: false, error: error.message }
  if (!data) return { success: false, error: 'Task not found' }
  return { success: true, data }
}

/**
 * Update status. The trigger from mig 159 keeps the legacy
 * `done` flag and `completed_at` in sync — we only have to write
 * `status`.
 */
export async function setTaskStatus(id, status) {
  if (!id) return { success: false, error: 'id required' }
  if (!['todo', 'in_progress', 'done', 'cancelled'].includes(status)) {
    return { success: false, error: `invalid status: ${status}` }
  }
  const { data, error } = await supabase.from('activities')
    .update({ status })
    .eq('id', id)
    .eq('kind', 'task')
    .select(TASK_SELECT)
    .single()
  if (error) return { success: false, error: error.message }
  return { success: true, data }
}

// ─── helpers ───

const PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, low: 3 }

function sortTasks(rows) {
  // Stable sort: due_date asc (nulls last), then priority asc.
  return [...rows].sort((a, b) => {
    const da = a.due_date || '9999-12-31'
    const db = b.due_date || '9999-12-31'
    if (da !== db) return da < db ? -1 : 1
    const pa = PRIORITY_RANK[a.priority] ?? 99
    const pb = PRIORITY_RANK[b.priority] ?? 99
    if (pa !== pb) return pa - pb
    return (a.created_at || '').localeCompare(b.created_at || '')
  })
}

export function statusLabel(status) {
  switch (status) {
    case 'todo':         return 'To do'
    case 'in_progress':  return 'In progress'
    case 'done':         return 'Done'
    case 'cancelled':    return 'Cancelled'
    default:             return status || '—'
  }
}

export function nextStatus(status) {
  // Cycle: todo → in_progress → done → todo (skip cancelled —
  // operator can drop into cancelled from the detail screen if needed).
  switch (status) {
    case 'todo':         return 'in_progress'
    case 'in_progress':  return 'done'
    case 'done':         return 'todo'
    default:             return 'todo'
  }
}
