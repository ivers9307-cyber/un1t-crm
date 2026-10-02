// POST /api/activities/tasks — create a task from the web (cookie session).
// C148 ACTWRITEGATEWEB.1: the /activities New task form, the contact page's
// Activity form and the contact / pipeline kebab's Task item used to insert
// into `activities` through the browser client, judged by RLS on the PHONE
// Tasks or Pipeline key. They post here, judged on the WEB rule at the task's
// studio (canWriteActivitiesAt: web `activities` AND Contacts, web or phone;
// src/lib/activity-web-writes.js). The external API-key surface is
// /api/tasks and /api/activities, unchanged.
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, isoDate, timeOfDay, activityTypeSchema } from '@/lib/schemas'
import { activitiesWriteForbiddenAnywhere, taskWriteRefusalAt, taskLinksRefusal } from '@/lib/activity-web-writes'

// kind, status, source and deal_id are not the client's to choose (unknown
// keys are dropped by zod).
const CreateTaskSchema = z.object({
  location_id: uuidLike,
  subject:     z.string().trim().min(1).max(500),
  type:        activityTypeSchema.optional(),
  note:        z.string().max(20_000).nullable().optional(),
  due_date:    isoDate.nullable().optional(),
  due_time:    timeOfDay.nullable().optional(),
  assignee_id: uuidLike.nullable().optional(),
  priority:    z.enum(['low', 'medium', 'high', 'urgent']).nullable().optional(),
  project:     z.string().max(100).nullable().optional(),
  contact_id:  uuidLike.nullable().optional(),
})

// TasksPage renders the new card from this shape (contact link, assignee).
const TASK_ROW = '*, contacts(id, name), profiles!activities_assignee_id_fkey(id, full_name)'

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const coarse = activitiesWriteForbiddenAnywhere(user)
  if (coarse) return coarse

  const validation = await validateBody(request, CreateTaskSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  // Membership of the body's studio (403, the body-location shape), then the
  // rule there.
  const notMember = assertLocationAccess(user, body.location_id)
  if (notMember) return notMember
  const refused = taskWriteRefusalAt(user, body.location_id)
  if (refused) return refused

  const db = createServerClient()
  const linkRefusal = await taskLinksRefusal(db, {
    locationId: body.location_id, contactId: body.contact_id, assigneeId: body.assignee_id,
  })
  if (linkRefusal) return linkRefusal

  const { data, error } = await db.from('activities')
    .insert({ ...body, kind: 'task', status: 'todo', source: 'manual' })
    .select(TASK_ROW)
    .single()
  if (error || !data) {
    return NextResponse.json({ success: false, error: 'Could not save the task. Try again.' }, { status: 500 })
  }
  return NextResponse.json({ success: true, data })
}
