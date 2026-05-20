// INVOICES-QUEUE.1 PR 2 — bulk-action helpers.
//
// Centralises the auth + scoping checks that every bulk route runs.
// Each bulk route does N independent row operations and reports
// per-id outcomes — clients see exactly what landed and what didn't.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { uuidLike } from '@/lib/schemas'

export const MAX_BULK_IDS = 100

export const BulkIdsSchema = z.object({
  ids: z.array(uuidLike).min(1).max(MAX_BULK_IDS),
})

export const BulkRejectSchema = z.object({
  ids: z.array(uuidLike).min(1).max(MAX_BULK_IDS),
  reason: z.string().min(1).max(1000),
})

/**
 * Run bookkeeper-gated auth on a bulk route. Returns either
 * { user, db } if the caller is authorised, or { response }
 * containing the early NextResponse to return.
 */
export async function loadBookkeeper() {
  const user = await getCurrentUser()
  if (!user) {
    return { response: NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 }) }
  }
  if (!hasPermission(user, 'bookkeeper')) {
    return {
      response: NextResponse.json({
        success: false,
        error: 'Bookkeeper permission required — ask a master to grant the bookkeeper flag.',
      }, { status: 403 }),
    }
  }
  const db = createServerClient()
  return { user, db }
}

/**
 * Fetch the rows for a bulk operation, filtering out anything the
 * caller can't see (defence-in-depth — the inbox UI doesn't render
 * cross-location rows, but the API shouldn't trust the client).
 * Returns { rowsById, missingIds, forbiddenIds }.
 */
export async function loadAndScopeBulkRows({ db, user, ids, select }) {
  const isMaster = user.role === 'master' || user.profileRole === 'master'
  const ownerLocations = Object.entries(user.rolesByLocation || {})
    .filter(([, r]) => r === 'owner')
    .map(([loc]) => loc)

  const { data, error } = await db
    .from('invoices_queue')
    .select(select || 'id, location_id, status, source_type')
    .in('id', ids)
  if (error) throw new Error(`Bulk lookup failed: ${error.message}`)

  const rowsById = {}
  const forbiddenIds = []
  for (const row of (data || [])) {
    if (isMaster || ownerLocations.includes(row.location_id)) {
      rowsById[row.id] = row
    } else {
      forbiddenIds.push(row.id)
    }
  }
  const foundIds = new Set(Object.keys(rowsById).concat(forbiddenIds))
  const missingIds = ids.filter((id) => !foundIds.has(id))
  return { rowsById, missingIds, forbiddenIds }
}
