// PATCH  /api/admin/achievements/[id]   edit a rule (master only)
// DELETE /api/admin/achievements/[id]   remove a rule (cascades earned rows)

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { logWarn } from '@/lib/log'
import { validateBody } from '@/lib/validate'
import { validateRulePayload } from '../route'

// Permissive schema — real field validation is done by validateRulePayload
const AchievementPatchSchema = z.record(z.unknown())

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// withAuth only signs the caller in (signed out: its 401). The master check
// stays here, judged on profiles.role, with its old 403 body.
const notMaster = (user) => user.profileRole !== 'master'
const forbidden = () => NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 })

export const PATCH = withAuth({ permission: null, location: false }, async ({ user, db, request, params }) => {
  if (notMaster(user)) return forbidden()

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

  const { data, error } = await db
    .from('achievement_rules')
    .update(validation.normalised)
    .eq('id', id)
    .select('*')
    .single()
  if (error) {
    logWarn('admin-achievements', 'update failed', { id, err: error })
    return NextResponse.json({ ok: false, error: 'Could not save the rule just now.' }, { status: 500 })
  }

  return NextResponse.json({ ok: true, rule: data })
})

export const DELETE = withAuth({ permission: null, location: false }, async ({ user, db, params }) => {
  if (notMaster(user)) return forbidden()

  const id = params?.id
  if (!id) return NextResponse.json({ ok: false, error: 'Missing id' }, { status: 400 })

  const { error } = await db.from('achievement_rules').delete().eq('id', id)
  if (error) {
    logWarn('admin-achievements', 'delete failed', { id, err: error })
    return NextResponse.json({ ok: false, error: 'Could not delete the rule just now.' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
})
