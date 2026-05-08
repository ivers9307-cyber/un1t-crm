// GET  /api/admin/achievements        list all rules (active + inactive, master only)
// POST /api/admin/achievements        create a new rule
//
// Edit/delete/backfill/test live on dedicated sub-routes for clarity.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const VALID_RULE_TYPES = [
  'first_event', 'streak', 'aggregate_threshold',
  'session_property', 'class_type_count', 'location_visit',
]
const VALID_CATEGORIES = [
  'milestone', 'streak', 'volume', 'class_type', 'session_quality', 'exploration',
]

async function requireMaster() {
  const user = await getCurrentUser()
  if (!user || user.profileRole !== 'master') return null
  return user
}

export async function GET() {
  const user = await requireMaster()
  if (!user) return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 })

  const db = createServerClient()
  const [{ data: rules }, { data: counts }] = await Promise.all([
    db.from('achievement_rules')
      .select('*')
      .order('sort_order', { ascending: true })
      .order('name', { ascending: true }),
    db.from('contact_achievements')
      .select('rule_id'),
  ])

  // Tally earned-count per rule for the admin UI (helpful when
  // deciding whether to deactivate or change a rule).
  const earnedCounts = new Map()
  for (const r of counts || []) {
    earnedCounts.set(r.rule_id, (earnedCounts.get(r.rule_id) || 0) + 1)
  }
  const enriched = (rules || []).map((r) => ({
    ...r,
    earned_count: earnedCounts.get(r.id) || 0,
  }))

  return NextResponse.json({ ok: true, rules: enriched })
}

export async function POST(request) {
  const user = await requireMaster()
  if (!user) return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 })

  let body
  try { body = await request.json() }
  catch { return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400 }) }

  const validation = validateRulePayload(body, { isCreate: true })
  if (!validation.ok) {
    return NextResponse.json({ ok: false, error: validation.error }, { status: 400 })
  }

  const db = createServerClient()
  const { data, error } = await db
    .from('achievement_rules')
    .insert(validation.normalised)
    .select('*')
    .single()
  if (error) {
    if (/duplicate key.*slug/i.test(error.message)) {
      return NextResponse.json({ ok: false, error: 'Slug already exists' }, { status: 409 })
    }
    logWarn('admin-achievements', 'create failed', { err: error })
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, rule: data })
}

// ── shared validators (also used by [id]/route.js) ────────────

export function validateRulePayload(input, { isCreate }) {
  if (!input || typeof input !== 'object') return { ok: false, error: 'Body required' }

  const out = {}
  if (isCreate) {
    const slug = String(input.slug || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_')
    if (!slug) return { ok: false, error: 'Slug is required' }
    if (slug.length > 80) return { ok: false, error: 'Slug too long' }
    out.slug = slug
  } else if (input.slug != null) {
    return { ok: false, error: 'Slug cannot be changed (would orphan earned rows)' }
  }

  if (input.name != null) {
    const name = String(input.name).trim()
    if (!name) return { ok: false, error: 'Name is required' }
    if (name.length > 120) return { ok: false, error: 'Name too long' }
    out.name = name
  } else if (isCreate) {
    return { ok: false, error: 'Name is required' }
  }

  if (input.description != null) out.description = String(input.description).trim() || null
  if (input.icon != null) out.icon = String(input.icon).trim() || null
  if (input.family != null) out.family = String(input.family).trim() || null

  if (input.category != null) {
    const cat = String(input.category).trim()
    if (!VALID_CATEGORIES.includes(cat)) {
      return { ok: false, error: `Category must be one of: ${VALID_CATEGORIES.join(', ')}` }
    }
    out.category = cat
  } else if (isCreate) {
    return { ok: false, error: 'Category is required' }
  }

  if (input.tier != null) {
    const t = parseInt(input.tier, 10)
    if (!Number.isFinite(t) || t < 1 || t > 4) {
      return { ok: false, error: 'Tier must be 1-4' }
    }
    out.tier = t
  }

  if (input.rule_type != null) {
    const rt = String(input.rule_type)
    if (!VALID_RULE_TYPES.includes(rt)) {
      return { ok: false, error: `Rule type must be one of: ${VALID_RULE_TYPES.join(', ')}` }
    }
    out.rule_type = rt
  } else if (isCreate) {
    return { ok: false, error: 'Rule type is required' }
  }

  if (input.rule_config != null) {
    if (typeof input.rule_config !== 'object' || Array.isArray(input.rule_config)) {
      return { ok: false, error: 'rule_config must be an object' }
    }
    out.rule_config = input.rule_config
  }

  if (input.is_active != null) out.is_active = Boolean(input.is_active)
  if (input.sort_order != null) {
    const so = parseInt(input.sort_order, 10)
    if (!Number.isFinite(so)) return { ok: false, error: 'sort_order must be an integer' }
    out.sort_order = so
  }

  return { ok: true, normalised: out }
}
