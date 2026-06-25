// GET /api/contacts/imports/[id]/error-csv
//
// Returns just the rows that failed validation OR were skipped, in
// CSV form, with an extra `import_error` column appended so the
// operator can fix the rows and re-upload only the failures.

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { MANAGER_ROLES } from '@/lib/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function csvEscape(v) {
  if (v == null) return ''
  const s = String(v)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s
}

export async function GET(_request, props) {
  const params = await props.params;
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }

  const db = createServerClient()
  const { data: batch } = await db
    .from('contact_imports')
    .select('id, location_id, source_filename, created_at')
    .eq('id', params.id)
    .single()
  if (!batch) return NextResponse.json({ success: false, error: 'Import not found' }, { status: 404 })

  const guard = assertLocationAccessOr404(user, batch.location_id)
  if (guard) return guard

  const { data: failedRows } = await db
    .from('contact_import_rows')
    .select('row_number, action, raw_row, error_message')
    .eq('import_id', params.id)
    .in('action', ['errored', 'skipped'])
    .order('row_number', { ascending: true })

  if (!failedRows || failedRows.length === 0) {
    return NextResponse.json({ success: false, error: 'No failed rows in this batch.' }, { status: 404 })
  }

  // Reconstruct headers from the union of every raw_row's keys so
  // the output mirrors the original CSV shape, plus our extra
  // `import_error` column.
  const headerSet = new Set()
  for (const r of failedRows) {
    for (const k of Object.keys(r.raw_row || {})) headerSet.add(k)
  }
  const headers = [...headerSet]
  const lines = [
    [...headers, 'import_error'].map(csvEscape).join(','),
    ...failedRows.map(r => {
      const cells = headers.map(h => csvEscape(r.raw_row?.[h]))
      cells.push(csvEscape(r.error_message || r.action))
      return cells.join(',')
    }),
  ]
  const csv = lines.join('\n') + '\n'

  const filename = (batch.source_filename || 'import').replace(/\.csv$/i, '') + '-errors.csv'
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
}
