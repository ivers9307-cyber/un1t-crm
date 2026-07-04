// src/app/api/accounting/coverage/import-statement/route.js
//
// RCOV CSV bridge — the operator exports statement lines from Xero's
// UI (per bank account) and uploads them here. This is the ONLY way
// unactioned imported statement lines reach the board: the API can't
// serve them (Bank Statement report scope RETIRED, Finance API
// ENTITLEMENT-GATED — see statement-lines.js). Lines land in the csv:
// key namespace; the API pull never touches that namespace.
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { hasPermission } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { parseStatementCsv, csvLineRows, csvReconciledKeys } from '@/lib/recon/statement-csv'
import { importStatementLines } from '@/lib/recon/import-statement'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  bankAccountId: z.string().min(8).max(64),
  bankAccountName: z.string().min(1).max(120),
  csvText: z.string().min(1).max(2_000_000), // exports are tens of KB; 2MB is a generous ceiling
})

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!hasPermission(user, 'accounting_hub')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const locationId = user.activeLocation?.id
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })
  }

  const validation = await validateBody(request, bodySchema)
  if (!validation.ok) return validation.response
  const { bankAccountId, bankAccountName, csvText } = validation.data

  let parsed
  try {
    parsed = parseStatementCsv(csvText)
  } catch (e) {
    // Parser errors are operator-facing by design (they name the
    // headers found) — a bad export shape is a 422, not a 500.
    return NextResponse.json({ success: false, error: String(e?.message || e) }, { status: 422 })
  }

  const db = createServerClient()
  const stats = await importStatementLines(db, {
    locationId,
    bankAccountId,
    bankAccountName,
    lines: csvLineRows(bankAccountId, parsed.rows),
    reconciledKeys: csvReconciledKeys(bankAccountId, parsed.rows),
  })

  return NextResponse.json({
    success: true,
    data: { ...stats, parsedRows: parsed.rows.length, warnings: parsed.warnings },
  })
}
