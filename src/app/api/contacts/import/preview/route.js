// POST /api/contacts/import/preview
//
// Mig 095 + v2 (mig 096). Master-only dry-run for the contact
// import wizard. Now accepts:
//   - location_id (master picks the target studio)
//   - per-row Glofox-ID secondary match key
//   - returns per-row conflicts (existing-vs-incoming field diffs)
//
// Match priority for an existing contact at the target location:
//   1. glofox_member_id  (when both incoming + existing have one)
//   2. email (case-insensitive)
//
// Body: {
//   mapping:     { csv_header: contact_field, ... },
//   rows:        [{ csv_header: value, ... }, ...]
//   batch_tag:   optional CSV string
//   location_id: target location uuid (defaults to active)
// }
//
// Returns: { success, data: {
//   summary: { total, to_create, to_update, to_skip, to_error },
//   rows: [{ row_number, action, email, glofox_id?, contact_id?, error?,
//           conflicts?: [{ field, existing, incoming }] }, ...]
// }}
//
// `conflicts` is only present on `updated` rows where at least one
// field the import is about to write differs from the current
// value. The wizard uses it to render the per-row resolution UI on
// the Review step.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { validateRow, fieldsTouchedByMapping } from '@/lib/contact-import'
import { selectAllByKeys } from '@/lib/select-all'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_ROWS = 5000

const Body = z.object({
  mapping: z.record(z.string().nullable()),
  rows: z.array(z.record(z.unknown())).min(1).max(MAX_ROWS),
  batch_tag: z.string().max(200).optional(),
  location_id: uuidLike.optional(),
})

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!user.isMaster && user.role !== 'master') {
    return NextResponse.json({
      success: false,
      error: 'Only a master account can import contacts.',
    }, { status: 403 })
  }

  const validation = await validateBody(request, Body)
  if (!validation.ok) return validation.response
  const { mapping, rows, batch_tag, location_id } = validation.data

  // Master is the only role that can hit this route — but we still
  // make sure the location_id (when explicit) is real before we
  // try to look up contacts at it. Active location is the fallback.
  const targetLocationId = location_id || user.activeLocation?.id
  if (!targetLocationId) {
    return NextResponse.json({ success: false, error: 'No target location.' }, { status: 400 })
  }
  const db = createServerClient()
  const { data: targetLoc } = await db
    .from('locations').select('id').eq('id', targetLocationId).single()
  if (!targetLoc) {
    return NextResponse.json({ success: false, error: 'Target location not found.' }, { status: 404 })
  }

  const batchTags = (batch_tag || '').split(',').map(s => s.trim()).filter(Boolean)
  const touchedFields = fieldsTouchedByMapping(mapping)

  // First pass: validate every row + collect emails AND glofox ids
  // so we can do bulk lookups for both.
  const plan = []
  const emailsToLookup = new Set()
  const glofoxToLookup = new Set()
  const seenEmails = new Set()
  const seenGlofox = new Set()
  for (let i = 0; i < rows.length; i++) {
    const r = validateRow(rows[i], mapping, { batchTags })
    const rowNumber = i + 2
    if (!r.ok) {
      plan.push({ row_number: rowNumber, action: 'errored', email: null, error: r.error })
      continue
    }
    const email = r.payload.email
    const glofoxId = r.payload.glofox_member_id || null
    if (seenEmails.has(email)) {
      plan.push({
        row_number: rowNumber,
        action: 'skipped',
        email,
        glofox_id: glofoxId,
        error: 'Duplicate email earlier in this file — first occurrence wins.',
      })
      continue
    }
    if (glofoxId && seenGlofox.has(glofoxId)) {
      plan.push({
        row_number: rowNumber,
        action: 'skipped',
        email,
        glofox_id: glofoxId,
        error: `Duplicate Glofox ID '${glofoxId}' earlier in this file — first occurrence wins.`,
      })
      continue
    }
    seenEmails.add(email)
    if (glofoxId) seenGlofox.add(glofoxId)
    emailsToLookup.add(email)
    if (glofoxId) glofoxToLookup.add(glofoxId)
    plan.push({ row_number: rowNumber, action: 'pending', email, glofox_id: glofoxId, payload: r.payload })
  }

  // Bulk lookup. Pull all the touched fields so we can compute the
  // per-row diff for the conflict UI.
  const lookupCols = ['id', 'email', 'glofox_member_id', ...touchedFields].filter(Boolean)
  const colExpr = [...new Set(lookupCols)].join(', ')
  const existingByEmail = new Map()
  const existingByGlofox = new Map()
  if (emailsToLookup.size > 0 || glofoxToLookup.size > 0) {
    // Two lookups — one by email, one by glofox id. CHUNKED + PAGED: an
    // `.in(col, keys)` lookup caps both the match set (db-max-rows, 1000) AND
    // the key list (URL length). If the existing base past the cap isn't
    // returned, the preview shows a row as "created" when it's really an
    // "updated" — and committing then INSERTs a duplicate. selectAllByKeys
    // chunks the keys (~300/query) and pages each chunk.
    const [emailMatches, glofoxMatches] = await Promise.all([
      selectAllByKeys([...emailsToLookup], (keys, from, to) => db
        .from('contacts').select(colExpr)
        .eq('location_id', targetLocationId).in('email', keys)
        .order('id', { ascending: true }).range(from, to)),
      selectAllByKeys([...glofoxToLookup], (keys, from, to) => db
        .from('contacts').select(colExpr)
        .eq('location_id', targetLocationId).in('glofox_member_id', keys)
        .order('id', { ascending: true }).range(from, to)),
    ])
    for (const c of [...emailMatches, ...glofoxMatches]) {
      if (c.email) existingByEmail.set(String(c.email).toLowerCase(), c)
      if (c.glofox_member_id) existingByGlofox.set(c.glofox_member_id, c)
    }
  }

  // Second pass: classify pending rows as create vs update +
  // compute conflicts. Match priority: glofox first, email
  // fallback. The matched contact is whatever the lookup returned.
  for (const p of plan) {
    if (p.action !== 'pending') continue
    const matched = (p.glofox_id && existingByGlofox.get(p.glofox_id))
                 || existingByEmail.get(p.email)
    if (matched) {
      p.action = 'updated'
      p.contact_id = matched.id
      p.match_key = (p.glofox_id && existingByGlofox.get(p.glofox_id)) ? 'glofox_member_id' : 'email'

      // Conflict detection — for every touched field where the
      // existing value is non-empty AND differs from the incoming
      // value. Tags are special: an "incoming" tag list always
      // adds (we union on commit), so a non-empty existing tag set
      // isn't really a conflict — only flag if the operator's
      // mapping would set lead_source, label, etc.
      // to a different value than what's there.
      const conflicts = []
      for (const f of touchedFields) {
        if (f === 'tags') continue
        const existingVal = matched[f]
        const incomingVal = p.payload[f]
        if (incomingVal == null) continue
        if (existingVal == null || existingVal === '') continue
        if (String(existingVal) === String(incomingVal)) continue
        conflicts.push({
          field: f,
          existing: existingVal,
          incoming: incomingVal,
        })
      }
      if (conflicts.length > 0) p.conflicts = conflicts
    } else {
      p.action = 'created'
    }
    delete p.payload // drop bulky payload from response
  }

  const summary = {
    total: rows.length,
    to_create: plan.filter(p => p.action === 'created').length,
    to_update: plan.filter(p => p.action === 'updated').length,
    to_skip:   plan.filter(p => p.action === 'skipped').length,
    to_error:  plan.filter(p => p.action === 'errored').length,
    with_conflicts: plan.filter(p => p.conflicts?.length > 0).length,
  }

  return NextResponse.json({ success: true, data: { summary, rows: plan } })
}
