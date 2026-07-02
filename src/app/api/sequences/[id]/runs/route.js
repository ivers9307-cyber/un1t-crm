// GET /api/sequences/[id]/runs — last 50 enrolments (per-contact run log)
// for the automation Performance view's "Recent activity". Manager+ at the
// sequence's location. Mirrors the /stats route's guards.
import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { MANAGER_ROLES } from '@/lib/schemas'
import { summariseEnrolmentRun } from '@/lib/sequences/run-history'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }

  const db = createServerClient()
  const { data: seq, error: seqErr } = await db
    .from('email_sequences')
    .select('id, location_id')
    .eq('id', params.id)
    .single()
  if (seqErr || !seq) {
    return NextResponse.json({ success: false, error: 'Sequence not found' }, { status: 404 })
  }
  const guard = assertLocationAccessOr404(user, seq.location_id)
  if (guard) return guard

  // Total step count for the "Step X of N" label.
  const { count: stepCount } = await db
    .from('sequence_steps')
    .select('id', { count: 'exact', head: true })
    .eq('sequence_id', params.id)

  // sequence_enrollments has a single FK to contacts → bare embed is safe.
  // NB the enrolment timestamp column is enrolled_at — this originally
  // selected/ordered created_at (which doesn't exist on this table), so the
  // whole query errored and the UI said "no runs yet" while the /stats
  // counters showed enrolments. Same lesson as the dormant-column invariant:
  // mocked tests + next build can't catch a bad column name.
  const { data: rows, error } = await db
    .from('sequence_enrollments')
    .select('id, contact_id, status, current_step_order, exit_reason, last_error, source_type, enrolled_at, next_step_at, last_processed_at, contacts(first_name, last_name, email)')
    .eq('sequence_id', params.id)
    .order('enrolled_at', { ascending: false })
    .limit(50)
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  const runs = (rows || []).map((r) => {
    const c = r.contacts || {}
    const name = [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || c.email || 'Unknown contact'
    return {
      id: r.id,
      contact_id: r.contact_id,
      contact_name: name,
      contact_email: c.email || null,
      source_type: r.source_type || null,
      enrolled_at: r.enrolled_at,
      next_step_at: r.next_step_at,
      last_processed_at: r.last_processed_at,
      ...summariseEnrolmentRun(r, stepCount || 0),
    }
  })

  return NextResponse.json({ success: true, data: { runs, step_count: stepCount || 0 } })
}
