// POST /api/admin/availability-move-notice  (AVAIL.3)
//
// The one-time "your unavailable days have moved" push to the people whose
// Unavailable time-off requests the mig 703 move carried into availability
// (src/lib/availability-move-notice.js has the rules). Run by the operator
// right AFTER supabase/operator-scripts/703_run_move_unavailable_time_off.sql,
// and only once Richard has seen the words.
//
// Master only. A PREVIEW unless the body says `send: true`: the preview
// answers how many people would be told and how many are inside quiet hours
// now, and sends nothing. `title` / `body` replace the default words for this
// call (checked: length, no em dash). `batch_id` limits it to one move batch.
// Counts only in the answer, never a name. Quiet hours (07:00-22:00 at the
// person's studio) gate the push; a deferred person is told on a later run.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { runAvailabilityMoveNotice, moveNoticeCopyProblem, AVAILABILITY_MOVE_NOTICE } from '@/lib/availability-move-notice'

const NoticeSchema = z.object({
  send: z.boolean().optional(),
  batch_id: uuidLike.optional(),
  title: z.string().optional(),
  body: z.string().optional(),
})

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (user.profileRole !== 'master') {
    return NextResponse.json({ success: false, error: 'Master only' }, { status: 403 })
  }

  const v = await validateBody(request, NoticeSchema, { allowEmpty: true })
  if (!v.ok) return v.response
  const body = v.data || {}
  const title = body.title ?? AVAILABILITY_MOVE_NOTICE.title
  const text = body.body ?? AVAILABILITY_MOVE_NOTICE.body
  const problem = moveNoticeCopyProblem({ title, body: text })
  if (problem) return NextResponse.json({ success: false, error: problem }, { status: 400 })

  const result = await runAvailabilityMoveNotice(createServerClient(), {
    send: body.send === true,
    batchId: body.batch_id ?? null,
    title,
    body: text,
  })
  if (!result.ok) return NextResponse.json({ success: false, error: result.error }, { status: 500 })
  return NextResponse.json({ success: true, data: result })
}
