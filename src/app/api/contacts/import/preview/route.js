// POST /api/contacts/import/preview
//
// Mig 095. Master-only dry-run for the contact import wizard. The
// client parses the CSV locally (parseCsv is pure JS, no DOM deps)
// and POSTs the rows + the operator's chosen mapping. We validate
// every row, look up existing contacts by email in one bulk query,
// classify each row as create / update / skipped / errored, and
// return the plan. Nothing is written to the DB.
//
// The wizard's commit step then POSTs the same body to /commit
// which re-runs validation and applies the writes. Sending the
// rows twice is acceptable up to ~5k rows; for larger imports
// we'd shift to a Storage-backed flow (out of scope for v1).
//
// Body: {
//   mapping:   { csv_header: contact_field, ... },
//   rows:      [{ csv_header: value, ... }, ...]   // up to MAX_ROWS
//   batch_tag: optional CSV string (becomes one or more tags)
// }
//
// Returns: { success, data: {
//   summary: { total, to_create, to_update, to_skip, to_error },
//   rows: [{ row_number, action, email, error?, contact_id? }, ...]
// }}

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { validateRow } from '@/lib/contact-import'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_ROWS = 5000

const Body = z.object({
  mapping: z.record(z.string().nullable()),
  rows: z.array(z.record(z.unknown())).min(1).max(MAX_ROWS),
  batch_tag: z.string().max(200).optional(),
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
  const locationId = user.activeLocation?.id
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'No active location.' }, { status: 400 })
  }

  const validation = await validateBody(request, Body)
  if (!validation.ok) return validation.response
  const { mapping, rows, batch_tag } = validation.data

  const batchTags = (batch_tag || '').split(',').map(s => s.trim()).filter(Boolean)

  // First pass: validate every row + collect emails to look up.
  // Track within-file dupes so the second occurrence becomes a
  // skip (with a clear reason) instead of overwriting itself.
  const plan = []
  const emails = new Set()
  const seenInFile = new Set()
  for (let i = 0; i < rows.length; i++) {
    const r = validateRow(rows[i], mapping, { batchTags })
    const rowNumber = i + 2 // CSV row number (header is 1)
    if (!r.ok) {
      plan.push({ row_number: rowNumber, action: 'errored', email: null, error: r.error })
      continue
    }
    const email = r.payload.email
    if (seenInFile.has(email)) {
      plan.push({
        row_number: rowNumber,
        action: 'skipped',
        email,
        error: 'Duplicate email earlier in this file — first occurrence wins.',
      })
      continue
    }
    seenInFile.add(email)
    emails.add(email)
    plan.push({ row_number: rowNumber, action: 'pending', email, payload: r.payload })
  }

  // Bulk lookup of existing contacts at this location by email
  // (lower-cased — we lowercased on the way in).
  const db = createServerClient()
  const existingByEmail = new Map()
  if (emails.size > 0) {
    const { data } = await db
      .from('contacts')
      .select('id, email')
      .eq('location_id', locationId)
      .in('email', [...emails])
    for (const c of (data || [])) {
      if (c.email) existingByEmail.set(c.email.toLowerCase(), c.id)
    }
  }

  // Second pass: classify pending rows as create vs update.
  for (const p of plan) {
    if (p.action !== 'pending') continue
    const existingId = existingByEmail.get(p.email)
    if (existingId) {
      p.action = 'updated'
      p.contact_id = existingId
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
  }

  return NextResponse.json({ success: true, data: { summary, rows: plan } })
}
