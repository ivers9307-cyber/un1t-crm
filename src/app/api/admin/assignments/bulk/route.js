// POST /api/admin/assignments/bulk — Master-only bulk action route
// for the /admin/matrix v2 access editor's bulk-action bar.
//
// Apply the same role to N (profile_id, location_id) pairs in one
// request, OR delete them all. Used when an operator picks several
// users in the matrix and wants to give them all the same role at the
// same location(s) — typical case: onboarding a new tenant org with
// 20 users across 5 locations.
//
// Per-pair semantics: each pair is processed independently and its
// outcome reported back ('created' / 'updated' / 'deleted' / 'no_op'
// / 'failed' with reason). One pair's failure does NOT roll back the
// others — partial success is the expected mode for bulk ops, and
// the per-pair report lets the UI re-show only the failures.
//
// Audit: each successful per-pair mutation appends its own audit
// entry, just like the single-cell route. Bulk operations don't get
// a special audit row — the audit is per atomic change.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { uuidLike, locationRoleSchema } from '@/lib/schemas'
import {
  logAssignmentChange,
  canRemoveSelfFromLastOwnerLocation,
} from '@/lib/assignment-changes'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60 // bulk could take a moment on hundreds of pairs

const Body = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('upsert'),
    role: locationRoleSchema,
    pairs: z.array(z.object({
      profile_id: uuidLike,
      location_id: uuidLike,
    })).min(1).max(500),
  }),
  z.object({
    action: z.literal('delete'),
    pairs: z.array(z.object({
      profile_id: uuidLike,
      location_id: uuidLike,
    })).min(1).max(500),
  }),
])

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }
  if (user.profileRole !== 'master') {
    return NextResponse.json({ success: false, error: 'Master only' }, { status: 403 })
  }

  const validation = await validateBody(request, Body)
  if (!validation.ok) return validation.response
  const body = validation.data

  const db = createServerClient()
  const results = []

  for (const pair of body.pairs) {
    const pairKey = `${pair.profile_id}::${pair.location_id}`
    try {
      const { data: existing } = await db
        .from('profile_locations')
        .select('*')
        .eq('profile_id', pair.profile_id)
        .eq('location_id', pair.location_id)
        .maybeSingle()

      if (body.action === 'upsert') {
        if (!existing) {
          // Insert new
          const { data: created, error } = await db
            .from('profile_locations')
            .insert({
              profile_id: pair.profile_id,
              location_id: pair.location_id,
              role: body.role,
            })
            .select()
            .single()
          if (error) {
            results.push({ pair: pairKey, outcome: 'failed', reason: error.message })
            continue
          }
          await logAssignmentChange(db, {
            actorId: user.id,
            targetProfileId: pair.profile_id,
            locationId: pair.location_id,
            action: 'assignment_create',
            before: null,
            after: created,
          })
          results.push({ pair: pairKey, outcome: 'created' })
        } else if (existing.role === body.role) {
          // Already has this role — no change.
          results.push({ pair: pairKey, outcome: 'no_op' })
        } else {
          // Update role
          const { data: updated, error } = await db
            .from('profile_locations')
            .update({ role: body.role })
            .eq('profile_id', pair.profile_id)
            .eq('location_id', pair.location_id)
            .select()
            .single()
          if (error) {
            results.push({ pair: pairKey, outcome: 'failed', reason: error.message })
            continue
          }
          await logAssignmentChange(db, {
            actorId: user.id,
            targetProfileId: pair.profile_id,
            locationId: pair.location_id,
            action: 'assignment_update',
            before: existing,
            after: updated,
          })
          results.push({ pair: pairKey, outcome: 'updated' })
        }
        continue
      }

      // body.action === 'delete'
      if (!existing) {
        results.push({ pair: pairKey, outcome: 'no_op', reason: 'not_found' })
        continue
      }

      // Self-orphan guard for owner-removal of self.
      if (existing.role === 'owner') {
        try {
          const guard = await canRemoveSelfFromLastOwnerLocation(
            db,
            user.id,
            pair.profile_id,
            pair.location_id,
          )
          if (guard.wouldOrphan) {
            results.push({
              pair: pairKey,
              outcome: 'failed',
              reason: 'would_orphan_self_owner',
            })
            continue
          }
        } catch (e) {
          results.push({ pair: pairKey, outcome: 'failed', reason: 'guard_check_failed' })
          continue
        }
      }

      const { error: delErr } = await db
        .from('profile_locations')
        .delete()
        .eq('profile_id', pair.profile_id)
        .eq('location_id', pair.location_id)
      if (delErr) {
        results.push({ pair: pairKey, outcome: 'failed', reason: delErr.message })
        continue
      }
      await logAssignmentChange(db, {
        actorId: user.id,
        targetProfileId: pair.profile_id,
        locationId: pair.location_id,
        action: 'assignment_delete',
        before: existing,
        after: null,
      })
      results.push({ pair: pairKey, outcome: 'deleted' })
    } catch (e) {
      results.push({ pair: pairKey, outcome: 'failed', reason: e?.message || 'exception' })
    }
  }

  // Summary counts to make UI feedback easy.
  const summary = results.reduce((acc, r) => {
    acc[r.outcome] = (acc[r.outcome] || 0) + 1
    return acc
  }, {})

  return NextResponse.json({ success: true, results, summary })
}
