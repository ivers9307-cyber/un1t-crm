// GET /api/schedule/reports/wrc-pack
//
// WRCPACK.1 — the Workplace Relations Commission inspection pack for one
// organisation: every studio, everyone employed in the range (former staff
// and tombstones included), as two CSVs or one JSON body. The rules and the
// reads are src/lib/wrc-pack.js; this file checks the caller and the query.
//
// ACCESS. The pack carries pay rates, contracted hours, leave and contract
// status for the whole organisation, so it is the OWNER tier: a master, an
// org admin of the organisation, or an owner at one of its studios
// (canDownloadWrcPack, the one rule the Reporting tab's button also reads).
// A manager or head coach gets 403. The organisation is caller-supplied, so
// a foreign one is 403 (assertOrganizationAccess), never a probe-able 404.
//
// Query:
//   organization_id  uuid (default: the active studio's organisation)
//   from, to         YYYY-MM-DD (default: the 12 months ending today at the
//                    active studio, inclusive); real dates, to on or after
//                    from, at most 366 days (reportPeriodError)
//   format           json (default) | csv
//   file             staff (default) | shifts — which CSV, when format=csv
//
// A failed read is a logged 500, never an empty pack that reads as "nobody
// worked here".

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertOrganizationAccess } from '@/lib/auth'
import { uuidLike } from '@/lib/schemas'
import { reportPeriodError } from '@/lib/report-period'
import { todayStrIn, zoneOfLocation } from '@/lib/location-time'
import { logError } from '@/lib/log'
import { canDownloadWrcPack } from '@/lib/wrc-pack-access'
import { generateWrcPack, defaultWrcPeriod, wrcStaffCsv, wrcShiftCsv } from '@/lib/wrc-pack'

const forbidden = () => NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })

function qs(searchParams, key) {
  const v = searchParams.get(key)
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const requestedOrg = qs(searchParams, 'organization_id')
  if (requestedOrg && !uuidLike.safeParse(requestedOrg).success) {
    return NextResponse.json({ success: false, error: 'organization_id must be a uuid' }, { status: 400 })
  }
  const organizationId = requestedOrg || user.activeOrganization?.id || user.activeLocation?.organization_id || null
  if (!organizationId) return NextResponse.json({ success: false, error: 'No organisation to report on' }, { status: 400 })

  const guard = assertOrganizationAccess(user, organizationId)
  if (guard) return guard
  if (!canDownloadWrcPack(user, organizationId)) return forbidden()

  const format = qs(searchParams, 'format') || 'json'
  if (!['json', 'csv'].includes(format)) return NextResponse.json({ success: false, error: 'format must be json or csv' }, { status: 400 })
  const file = qs(searchParams, 'file') || 'staff'
  if (!['staff', 'shifts'].includes(file)) return NextResponse.json({ success: false, error: 'file must be staff or shifts' }, { status: 400 })

  const today = todayStrIn(zoneOfLocation(user.activeLocation))
  const defaults = defaultWrcPeriod(today)
  const to = qs(searchParams, 'to') || defaults.to
  const from = qs(searchParams, 'from') || (qs(searchParams, 'to') ? defaultWrcPeriod(to).from : defaults.from)
  const periodError = reportPeriodError(from, to, { startName: 'from', endName: 'to', what: 'The WRC pack' })
  if (periodError) return NextResponse.json({ success: false, error: periodError }, { status: 400 })
  const year = Number(to.slice(0, 4))

  const db = createServerClient()
  const { pack, locations, error } = await generateWrcPack(db, { organizationId, from, to, year })
  if (error) {
    logError('wrc-pack', 'pack read failed', { organizationId, from, to, err: error })
    return NextResponse.json({ success: false, error: 'Could not build the WRC pack just now.' }, { status: 500 })
  }

  if (format === 'csv') {
    const body = file === 'shifts' ? wrcShiftCsv(pack.shifts) : wrcStaffCsv(pack.staff)
    const name = `wrc-${file}-${from}-to-${to}.csv`
    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${name}"`,
        'Cache-Control': 'no-store',
      },
    })
  }

  return NextResponse.json({
    success: true,
    data: {
      organization_id: organizationId,
      period: { from, to },
      allowance_year: year,
      locations: locations.map((l) => ({ id: l.id, name: l.name })),
      staff: pack.staff,
      shifts: pack.shifts,
    },
  })
}
