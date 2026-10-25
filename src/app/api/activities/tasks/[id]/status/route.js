// POST /api/activities/tasks/[id]/status — move a task between the /activities
// columns (list toggle, board drag). C148 ACTWRITEGATEWEB.1: this was a
// browser-client update judged by RLS on the PHONE Tasks or Pipeline key; it
// is judged here on the WEB rule at the task's own studio
// (canWriteActivitiesAt; src/lib/activity-web-writes.js). The done/status
// trigger (sync_activity_done_status) keeps `done` and `completed_at` in step.
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { activitiesWriteForbiddenAnywhere, loadTaskForWebWrite } from '@/lib/activity-web-writes'

const StatusSchema = z.object({
  status: z.enum(['todo', 'in_progress', 'done', 'cancelled']),
})

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const coarse = activitiesWriteForbiddenAnywhere(user)
  if (coarse) return coarse

  const validation = await validateBody(request, StatusSchema)
  if (!validation.ok) return validation.response
  const { status } = validation.data

  const db = createServerClient()
  const { response, task } = await loadTaskForWebWrite(db, user, params.id)
  if (response) return response

  const { data, error } = await db.from('activities')
    .update({ status })
    .eq('id', task.id)
    .eq('kind', 'task')
    // Pinned to the studio the gate judged: a row moved between the read and
    // the write matches nothing (404) instead of being written unjudged.
    .eq('location_id', task.location_id)
    .select('id, status')
  if (error) {
    return NextResponse.json({ success: false, error: 'Could not change the task. Try again.' }, { status: 500 })
  }
  if (!data?.length) {
    return NextResponse.json({ success: false, error: 'This task no longer exists. Reload the page.' }, { status: 404 })
  }
  return NextResponse.json({ success: true, data: data[0] })
}
