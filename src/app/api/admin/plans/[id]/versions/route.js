// POST /api/admin/plans/[id]/versions — master-only: create a NEW
// pricing version for a plan (INTEG-C1, mig 413).
//
// This is THE way plan numbers change. Versions are immutable once
// created — there is deliberately no PATCH/PUT/DELETE on versions, so
// a location pinned to a version keeps its exact grandfathered
// numbers forever. Superseding = insert a row with a later
// effective_from; the active version on any date is the latest
// effective_from <= date (src/lib/plans.js pickActiveVersion).
//
// Allowance / rate / feature KEYS are whitelisted from
// shared/plans.js (structure in code, numbers in DB) — unknown keys
// are rejected rather than silently stored.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody, uuidLike } from '@/lib/validate'
import { METERS, UNIT_RATE_KEYS, FEATURE_KEYS } from '@shared/plans'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const jsonbShape = (keys, valueSchema) =>
  z.object(Object.fromEntries(keys.map((k) => [k, valueSchema.optional()]))).strict()

const VersionBody = z.object({
  effective_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'effective_from must be YYYY-MM-DD'),
  price_cents: z.number().int().min(0).max(100_000_000),
  // EUR-only v1 (Ireland). The column CHECK enforces it too.
  currency: z.literal('EUR').optional(),
  allowances: jsonbShape(Object.keys(METERS), z.number().int().min(0).max(100_000_000)).optional(),
  unit_rates_cents: jsonbShape(Object.keys(UNIT_RATE_KEYS), z.number().int().min(0).max(1_000_000)).optional(),
  features: jsonbShape(Object.keys(FEATURE_KEYS), z.boolean()).optional(),
  notes: z.string().max(2000).optional().nullable(),
})

export async function POST(request, { params }) {
  const user = await getCurrentUser()
  if (!user || user.profileRole !== 'master') {
    return NextResponse.json({ success: false, error: 'Master only' }, { status: 403 })
  }

  const { id } = await params
  if (!uuidLike.safeParse(id).success) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  const validation = await validateBody(request, VersionBody)
  if (!validation.ok) return validation.response
  const body = validation.data

  const db = createServerClient()

  const { data: plan } = await db.from('plans').select('id, slug, kind').eq('id', id).single()
  if (!plan) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  const { data: created, error } = await db
    .from('plan_versions')
    .insert({
      plan_id: plan.id,
      effective_from: body.effective_from,
      price_cents: body.price_cents,
      currency: 'EUR',
      allowances: body.allowances || {},
      unit_rates_cents: body.unit_rates_cents || {},
      features: body.features || {},
      notes: body.notes || null,
      created_by: user.id,
    })
    .select()
    .single()

  if (error) {
    if (error.code === '23505' || /duplicate key|unique/i.test(error.message || '')) {
      return NextResponse.json({
        success: false,
        error: `A version of "${plan.slug}" effective ${body.effective_from} already exists. Pick a different effective date — versions are never edited in place.`,
        code: 'duplicate_effective_from',
      }, { status: 409 })
    }
    return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  return NextResponse.json({ success: true, data: created })
}
