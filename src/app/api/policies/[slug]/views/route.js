// POST /api/policies/[slug]/views — start a view session.
// Inserts a policy_views row for the calling user against the
// CURRENT version of the policy and returns the view id so the
// client can later patch in ended_at + section_dwell.
//
// PATCH /api/policies/[slug]/views — end / progress a view session.
// Body: { view_id, total_duration_seconds, section_dwell }
// Updates the row in place. Idempotent — the client may PATCH twice
// (e.g. once via beforeunload, once via the page-leave handler) and
// the later call wins as long as total_duration_seconds increases.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'

export const runtime = 'nodejs'

function parseClientIp(req) {
  const xff = req.headers.get('x-forwarded-for') || ''
  return xff.split(',')[0]?.trim() || null
}
function classifyVia(userAgent) {
  if (!userAgent) return 'web'
  return /Expo|okhttp|UN1TCRM\/|CFStudio\/|Repset\//.test(userAgent) ? 'mobile' : 'web'
}

// ----- POST: start a view session ----------------------------------

export async function POST(request, { params }) {
  const { slug } = await params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data: policy } = await db
    .from('policies')
    .select(`id, active, policy_versions ( id, is_current )`)
    .eq('slug', slug)
    .maybeSingle()
  if (!policy || !policy.active) {
    return NextResponse.json({ success: false, error: 'Policy not found' }, { status: 404 })
  }
  const current = (policy.policy_versions || []).find((v) => v.is_current)
  if (!current) {
    return NextResponse.json({ success: false, error: 'Policy has no current version' }, { status: 409 })
  }

  const userAgent = request.headers.get('user-agent') || null
  const { data: inserted, error } = await db
    .from('policy_views')
    .insert({
      policy_version_id: current.id,
      profile_id: user.id,
      viewed_via: classifyVia(userAgent),
      ip_address: parseClientIp(request),
      user_agent: userAgent,
    })
    .select('id, policy_version_id, started_at')
    .single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, view: inserted })
}

// ----- PATCH: end / progress a view session ------------------------

const ViewEndSchema = z.object({
  view_id: uuidLike,
  // Max one hour in seconds — guards against runaway tab timers
  // sending nonsense. Anyone genuinely reading for >1h should re-
  // open the page; the new session counts independently.
  total_duration_seconds: z.number().int().min(0).max(60 * 60),
  // Open-ended map. Keys are section headings (free-form text),
  // values are seconds. Bounded above by a Zod refine to keep
  // pathological clients from sending megabytes.
  section_dwell: z.record(z.string().min(1).max(500), z.number().int().min(0).max(60 * 60))
    .refine((d) => Object.keys(d).length <= 200, { message: 'Too many sections' })
    .optional()
    .nullable(),
})

export async function PATCH(request, { params }) {
  const { slug } = await params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const validation = await validateBody(request, ViewEndSchema)
  if (!validation.ok) return validation.response
  const { view_id, total_duration_seconds, section_dwell } = validation.data

  const db = createServerClient()

  // Confirm the view row is the caller's and belongs to a current
  // version of the policy with the given slug. Defence in depth on
  // top of RLS — RLS already restricts UPDATE to profile_id =
  // auth.uid(), so a misaddressed view_id would fail silently.
  const { data: existing } = await db
    .from('policy_views')
    .select(`
      id, profile_id, total_duration_seconds,
      policy_version_id, policy_versions!policy_version_id ( policy_id,
        policies!policy_id ( slug ) )
    `)
    .eq('id', view_id)
    .maybeSingle()
  if (!existing) return NextResponse.json({ success: false, error: 'View not found' }, { status: 404 })
  if (existing.profile_id !== user.id) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  if (existing.policy_versions?.policies?.slug !== slug) {
    return NextResponse.json({ success: false, error: 'View / policy mismatch' }, { status: 400 })
  }

  // Idempotent rule: later PATCH only wins if its duration is >=
  // what's already stored. Lets the client safely fire on both
  // beforeunload (short) and visibility-hidden (longer) without
  // worrying about ordering — the longest reading wins.
  const prevDuration = existing.total_duration_seconds || 0
  const finalDuration = Math.max(prevDuration, total_duration_seconds)

  const { data: updated, error } = await db
    .from('policy_views')
    .update({
      ended_at: new Date().toISOString(),
      total_duration_seconds: finalDuration,
      section_dwell: section_dwell || null,
    })
    .eq('id', view_id)
    .select('id, ended_at, total_duration_seconds')
    .single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, view: updated })
}
