// /activities — Tasks tab (TASKS.1 lightweight PM tool).
//
// Server component: pulls the current location's tasks + the
// profile list (for the assignee dropdown) + a seed of existing
// project tags, then hands off to TasksPage (client) for the
// interactive list/board + filters + create flow.
//
// History:
//   - Phase 1 (mig 073): tasks were contact-scoped, only created
//     from the contact-detail "Add activity" form. The page was
//     read-only and most operators didn't realise tasks existed
//     because there was no "New task" button up here.
//   - Phase 2 / TASKS.1 (mig 159): standalone tasks (contact_id
//     nullable was already true; just the UI lacked an entry
//     point), assignee + priority + status enum + project tags,
//     kanban board view.

import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { redirect } from 'next/navigation'
import TasksPage from '@/components/TasksPage'

export const dynamic = 'force-dynamic'

export default async function ActivitiesPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'activities')) redirect('/')

  const locationId = user.activeLocation?.id
  if (!locationId) redirect('/')

  const db = createServerClient()

  // 1. Tasks at this location, joined to the contact (if any) for
  //    the link in the card, and to the assignee profile for the
  //    "@ <name>" badge. The FK constraint name on assignee_id is
  //    activities_assignee_id_fkey (auto-generated).
  const { data: tasks } = await db
    .from('activities')
    .select(`
      *,
      contacts(id, name),
      profiles!activities_assignee_id_fkey(id, full_name)
    `)
    .eq('location_id', locationId)
    .eq('kind', 'task')
    .order('due_date', { ascending: true, nullsFirst: false })
    .limit(500)

  // 2. Staff at this location — used to populate the assignee
  //    dropdowns (filter + create form). profile_locations is
  //    the join table; pull each profile through it so we only
  //    see staff who actually belong to this location.
  const { data: assignableRows } = await db
    .from('profile_locations')
    .select('profile_id, profiles!inner(id, full_name, email)')
    .eq('location_id', locationId)

  const profiles = (assignableRows || [])
    .map(r => r.profiles)
    .filter(p => p?.full_name || p?.email)
    .sort((a, b) => (a.full_name || a.email).localeCompare(b.full_name || b.email))

  // 3. Project-tag seed — read-only union of values already
  //    present on tasks (the client recomputes this from the
  //    in-memory tasks list too, but seeding from here means the
  //    filter dropdown is populated on first render with no
  //    flicker).
  const projectsSeed = Array.from(new Set(
    (tasks || []).map(t => t.project).filter(Boolean)
  )).sort()

  return (
    <TasksPage
      initialTasks={tasks || []}
      locationId={locationId}
      profiles={profiles}
      projectsSeed={projectsSeed}
    />
  )
}
