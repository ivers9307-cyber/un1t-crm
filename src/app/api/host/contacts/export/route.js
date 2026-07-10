// GET /api/host/contacts/export
//
// CSV download of the host's OWN contact list (HOST-EMAIL.1). Same gate +
// data source as GET /api/host/contacts (getCurrentHost → fetchHostContactRows
// scoped to session.host.id); csvCell gives RFC-4180 quoting + the
// CSV-injection guard, and the UTF-8 BOM keeps accented names right in Excel
// (mirrors attendeeCsvResponse).

import { NextResponse } from 'next/server'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { fetchHostContactRows } from '@/lib/host-contact-list'
import { csvCell } from '@/lib/attendee-csv'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const BOM = '﻿'
const HEADER = ['Name', 'Email', 'Source', 'Joined', 'Emailable']
const SOURCE_LABEL = { event: 'Event', mailing_list: 'Mailing list' }

export async function GET() {
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  try {
    const rows = await fetchHostContactRows(db, session.host.id)
    const lines = [HEADER]
    for (const r of rows) {
      lines.push([
        r.name,
        r.email,
        SOURCE_LABEL[r.source] || r.source || '',
        r.created_at || '',
        r.emailable ? 'Yes' : 'No',
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
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 })
  }
}
