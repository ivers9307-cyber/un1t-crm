// PATCH  /api/admin/achievements/[id]   edit a rule (master only)
// DELETE /api/admin/achievements/[id]   remove a rule (cascades earned rows)

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { logWarn } from '@/lib/log'
import { validateBody } from '@/lib/validate'
import { validateRulePayload } from '../route'

// Permissive schema — real field validation is done by validateRulePayload
const AchievementPatchSchema = z.record(z.unknown())

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function requireMaster() {
  const user = await getCurrentUser()
  if (!user || user.profileRole !== 'master') return null
  return user
}

export async function PATCH(request, props) {
  const params = await props.params;
  const user = await requireMaster()
  if (!user) return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 })

  const id = params?.id
  if (!id) return NextResponse.json({ ok: false, error: 'Missing id' }, { status: 400 })

  const v = await validateBody(request, AchievementPatchSchema)
  if (!v.ok) return v.response
  const body = v.data

  const validation = validateRulePayload(body, { isCreate: false })
  if (!validation.ok) {
    return NextResponse.json({ ok: false, error: validation.error }, { status: 400 })
  }
  if (Object.keys(validation.normalised).length === 0) {
    return NextResponse.json({ ok: false, error: 'No valid fields to update' }, { status: 400 })
  }

  const db = createServerClient()
  const { data, error } = await db
    .from('achievement_rules')
    .update(validation.normalised)
    .eq('id', id)
    .select('*')
    .single()
  if (error) {
    logWarn('admin-achievements', 'update failed', { id, err: error })
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, rule: data })
}

export async function DELETE(request, props) {
  const params = await props.params;
  const user = await requireMaster()
  if (!user) return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 })

  const id = params?.id
  if (!id) return NextResponse.json({ ok: false, error: 'Missing id' }, { status: 400 })

  const db = createServerClient()
  const { error } = await db.from('achievement_rules').delete().eq('id', id)
  if (error) {
    logWarn('admin-achievements', 'delete failed', { id, err: error })
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
