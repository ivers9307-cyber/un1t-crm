// TASKS.1 — external integration surface.
//
// Lets n8n / Slack / Zapier / etc. push tasks into the CRM
// without having to know the activities schema. Marketed as
// /api/tasks but writes to public.activities with kind='task'.
//
// Authentication mirrors the other public n8n surfaces:
//   - x-api-key: <CRM_API_KEY> required.
//
// Endpoints:
//   GET  /api/tasks?location_id=&status=&assignee_id=&limit=
//     → list tasks with filters
//   POST /api/tasks
//     body: { location_id, subject, note?, due_date?, due_time?,
//             assignee_id?, priority?, project?, contact_id? }
//     → create one task. status defaults to 'todo' via the
//       trigger from mig 159.
//
// PATCH lives at /api/tasks/[id] (separate file) so existing
// REST clients can hit it with idiomatic URLs.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { authenticateApiKey, orgScopeLocationIds, assertCreateInOrg } from '@/lib/api-auth'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'

const PRIORITY = z.enum(['low', 'medium', 'high', 'urgent']).nullable().optional()
const STATUS = z.enum(['todo', 'in_progress', 'done', 'cancelled']).optional()

const CreateTaskSchema = z.object({
  location_id: uuidLike,
  subject:     z.string().min(1).max(500),
  note:        z.string().max(5000).nullable().optional(),
  due_date:    z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  due_time:    z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).nullable().optional(),
  assignee_id: uuidLike.nullable().optional(),
  priority:    PRIORITY,
  project:     z.string().max(100).nullable().optional(),
  contact_id:  uuidLike.nullable().optional(),
  status:      STATUS,
})

export async function GET(request) {
  const auth = await authenticateApiKey(request)
  if (!auth.ok) return auth.response

  const { searchParams } = new URL(request.url)
  const db = createServerClient()

  let query = db.from('activities')
    .select('id, subject, note, status, priority, project, due_date, due_time, assignee_id, contact_id, location_id, created_at, updated_at, completed_at')
    .eq('kind', 'task')

  // APIKEYS.3 — per-org key: restrict to the org's locations.
  const orgLocs = await orgScopeLocationIds(db, auth.orgId)
  if (orgLocs) query = query.in('location_id', orgLocs)

  const locationId = searchParams.get('location_id')
  if (locationId) query = query.eq('location_id', locationId)
  const status = searchParams.get('status')
  if (status) query = query.eq('status', status)
  const assigneeId = searchParams.get('assignee_id')
  if (assigneeId) query = query.eq('assignee_id', assigneeId)
  const project = searchParams.get('project')
  if (project) query = query.eq('project', project)

  const limit = Math.min(Math.max(1, parseInt(searchParams.get('limit') || '50', 10) || 50), 200)
  query = query.order('created_at', { ascending: false }).limit(limit)

  const { data, error } = await query
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data })
}

export async function POST(request) {
  const auth = await authenticateApiKey(request)
  if (!auth.ok) return auth.response

  const validation = await validateBody(request, CreateTaskSchema)
  if (!validation.ok) return validation.response

  const db = createServerClient()
  // APIKEYS.3 — per-org key may only create a task at a location in its org.
  const scopeErr = await assertCreateInOrg({ db, orgId: auth.orgId, locationId: validation.data.location_id, contactId: validation.data.contact_id })
  if (scopeErr) return scopeErr
  const insert = {
    ...validation.data,
    kind: 'task',
    source: 'api',
    type: 'task',
  }

  const { data, error } = await db.from('activities')
    .insert(insert)
    .select('*')
    .single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  return NextResponse.json({ success: true, data })
}
