// TASKS.1 — GET/PATCH/DELETE one task.
//
// Same auth as the collection endpoint (x-api-key: CRM_API_KEY).
// All writes go to activities WHERE kind='task' AND id=...; we
// explicitly guard so n8n can't accidentally mutate an
// auto-logged event row by passing its UUID.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { requireApiKey } from '@/lib/api-auth'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'

const UpdateTaskSchema = z.object({
  subject:     z.string().min(1).max(500).optional(),
  note:        z.string().max(5000).nullable().optional(),
  status:      z.enum(['todo', 'in_progress', 'done', 'cancelled']).optional(),
  priority:    z.enum(['low', 'medium', 'high', 'urgent']).nullable().optional(),
  project:     z.string().max(100).nullable().optional(),
  due_date:    z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  due_time:    z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).nullable().optional(),
  assignee_id: uuidLike.nullable().optional(),
  contact_id:  uuidLike.nullable().optional(),
})

export async function GET(request, props) {
  const params = await props.params;
  const authError = requireApiKey(request)
  if (authError) return authError

  const db = createServerClient()
  const { data, error } = await db.from('activities')
    .select('*')
    .eq('id', params.id)
    .eq('kind', 'task')
    .single()
  if (error || !data) {
    return NextResponse.json({ success: false, error: 'Task not found' }, { status: 404 })
  }
  return NextResponse.json({ success: true, data })
}

export async function PATCH(request, props) {
  const params = await props.params;
  const authError = requireApiKey(request)
  if (authError) return authError

  const validation = await validateBody(request, UpdateTaskSchema)
  if (!validation.ok) return validation.response

  const db = createServerClient()
  const { data, error } = await db.from('activities')
    .update(validation.data)
    .eq('id', params.id)
    .eq('kind', 'task')   // guard — can't mutate event rows through /api/tasks
    .select('*')
    .single()
  if (error || !data) {
    return NextResponse.json({ success: false, error: error?.message || 'Task not found' }, { status: 404 })
  }
  return NextResponse.json({ success: true, data })
}

export async function DELETE(request, props) {
  const params = await props.params;
  const authError = requireApiKey(request)
  if (authError) return authError

  const db = createServerClient()
  const { error } = await db.from('activities')
    .delete()
    .eq('id', params.id)
    .eq('kind', 'task')
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true })
}
