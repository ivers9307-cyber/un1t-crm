// POST /api/contacts/export  (CONTACTEXPORT.1)
//
// A CSV of the selected contacts at the caller's ACTIVE studio, from the
// contacts list's bulk bar. Richard's decision (19 Nov 2026): owners and
// masters only, and every export recorded in the audit log.
//
// Body: { contact_ids: uuid[] (1..5000) }
//
// Gate: Contacts at the active studio (withAuth) and owner or master there
// (canExportContactsAt). Scope: only contacts the studio may act on
// (contactIdsLinkedToStudio, the bulk tag's helper); anything else is skipped
// and never named. Named columns only.
//
// The audit row is written BEFORE the file is handed over. If it cannot be
// written, nothing is exported (503): an unrecorded export of personal data
// is the one outcome this must never produce.
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/with-auth'
import { uuidLike } from '@/lib/schemas'
import { contactIdsLinkedToStudio } from '@/lib/contact-studio-link'
import { canExportContactsAt } from '@/lib/contact-export-gate'
import { logAuditEvent } from '@/lib/audit'
import { csvCell } from '@/lib/attendee-csv'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export const MAX_EXPORT = 5000
const READ_CHUNK = 200
const COLUMNS = 'id, first_name, last_name, email, phone, tags, pipeline_stage_slug, created_at'
const HEADER = ['First name', 'Last name', 'Email', 'Phone', 'Tags', 'Stage', 'Added']
const BOM = '﻿'

const Body = z.object({ contact_ids: z.array(uuidLike).min(1).max(MAX_EXPORT) })

export const POST = withAuth({ permission: 'contacts', location: true, schema: Body, allow: (user, locationId) => canExportContactsAt(user, locationId), forbiddenMessage: 'Only owners and masters can export contacts.' }, async ({ user, db, locationId, input, request }) => {
  const linked = await contactIdsLinkedToStudio(db, { locationId, contactIds: input.contact_ids })
  if (!linked.ok) {
    logError('contact-export', 'studio contacts unreadable', { locationId, reason: linked.reason })
    return NextResponse.json({ success: false, error: 'Could not read the contacts. Nothing was exported.' }, { status: 503 })
  }

  const rows = []
  for (let i = 0; i < linked.ids.length; i += READ_CHUNK) {
    const ids = linked.ids.slice(i, i + READ_CHUNK)
    const { data, error } = await db.from('contacts').select(COLUMNS).in('id', ids).order('id', { ascending: true })
    if (error) {
      logError('contact-export', 'contacts unreadable', { locationId, code: error.code ?? null })
      return NextResponse.json({ success: false, error: 'Could not read the contacts. Nothing was exported.' }, { status: 503 })
    }
    rows.push(...(data || []))
  }
  rows.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))

  const audit = await logAuditEvent({
    category: 'business',
    action: 'contacts_exported',
    actor: user,
    target: { resource: 'contacts', label: `${rows.length} contact${rows.length === 1 ? '' : 's'}` },
    locationId,
    details: { exported: rows.length, requested: input.contact_ids.length, skipped: input.contact_ids.length - rows.length },
    request,
  })
  if (!audit.logged) {
    logError('contact-export', 'export not recorded; refused', { locationId, err: audit.error })
    return NextResponse.json({ success: false, error: 'The export could not be recorded, so nothing was exported. Try again.' }, { status: 503 })
  }

  const lines = [HEADER]
  for (const c of rows) {
    lines.push([
      c.first_name || '', c.last_name || '', c.email || '', c.phone || '',
      Array.isArray(c.tags) ? c.tags.join('; ') : '', c.pipeline_stage_slug || '', c.created_at ? String(c.created_at).slice(0, 10) : '',
    ])
  }
  const csv = lines.map((l) => l.map(csvCell).join(',')).join('\r\n')
  return new Response(BOM + csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="contacts.csv"',
      'Cache-Control': 'no-store',
    },
  })
})
