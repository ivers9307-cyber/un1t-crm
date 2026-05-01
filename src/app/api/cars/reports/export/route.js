// GET /api/cars/reports/export?type=completed-ytd|outstanding-vat
//
// Returns CSV downloads of the two most useful slices of the Cars
// Reports tab — completed cars year-to-date (revenue/profit/VAT
// columns) and the outstanding-VAT list (oldest first, with
// days-outstanding for HMRC chase commentary).
//
// Permissions mirror the Reports page itself — car_processing
// required, RLS limits rows to the caller's locations.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { profitBreakdown, splitIrishPrice } from '@/lib/cars'
import { getCachedGbpToEur } from '@/lib/fx'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Minimal CSV escaper — wraps fields containing commas, newlines,
// or double quotes. Numeric/null values stringified naturally.
function csvField(v) {
  if (v == null) return ''
  const s = String(v)
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

function rowsToCsv(headers, rows) {
  const lines = [headers.map(csvField).join(',')]
  for (const r of rows) lines.push(r.map(csvField).join(','))
  return lines.join('\r\n') + '\r\n'
}

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermission(user, 'car_processing')) {
    return NextResponse.json({ success: false, error: 'Not permitted' }, { status: 403 })
  }

  const url = new URL(request.url)
  const type = url.searchParams.get('type') || 'completed-ytd'
  const locationId = user.activeLocation?.id

  const db = createServerClient()
  const fx = await getCachedGbpToEur()
  const liveRate = fx?.rate ?? null

  let query = db.from('cars').select('*')
  if (locationId && user.role !== 'master') query = query.eq('location_id', locationId)
  const { data: cars, error } = await query
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  const startOfYear = new Date(new Date().getFullYear(), 0, 1).toISOString()
  const today = new Date().toISOString().slice(0, 10)

  let csv = ''
  let filename = ''

  if (type === 'completed-ytd') {
    const rows = (cars || [])
      .filter(c => c.status === 'completed' && c.completed_at && c.completed_at >= startOfYear)
      .sort((a, b) => (b.completed_at || '').localeCompare(a.completed_at || ''))
      .map(c => {
        const split = splitIrishPrice(c)
        const b = profitBreakdown(c, liveRate)
        return [
          c.completed_at?.slice(0, 10) || '',
          c.uk_reg || '',
          c.irish_reg || '',
          c.vin || '',
          [c.make, c.model].filter(Boolean).join(' '),
          c.vehicle_year || '',
          c.uk_purchase_price_ex_vat ?? '',
          c.uk_vat ?? '',
          c.uk_vat_refund_received ? 'Yes' : 'No',
          c.uk_vat_refund_received_at?.slice(0, 10) || '',
          split.exVat ?? '',
          split.salePrice ?? '',
          b ? b.fx.toFixed(4) : '',
          b ? b.profit : '',
          c.xero_invoice_number || '',
          c.buyer_name || '',
          c.buyer_email || '',
        ]
      })
    csv = rowsToCsv([
      'completed_at', 'uk_reg', 'irish_reg', 'vin', 'vehicle', 'year',
      'uk_ex_vat_gbp', 'uk_vat_gbp', 'uk_vat_refunded', 'uk_vat_refunded_at',
      'ie_ex_vat_eur', 'sale_price_eur', 'fx_rate_used', 'profit_eur',
      'xero_invoice_number', 'buyer_name', 'buyer_email',
    ], rows)
    filename = `cars-completed-ytd-${today}.csv`
  } else if (type === 'outstanding-vat') {
    const now = Date.now()
    const rows = (cars || [])
      .filter(c => !c.uk_vat_refund_received && Number(c.uk_vat || 0) > 0 && c.created_at)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map(c => {
        const ageDays = Math.floor((now - new Date(c.created_at).getTime()) / (1000 * 60 * 60 * 24))
        return [
          c.created_at.slice(0, 10),
          ageDays,
          c.uk_reg || '',
          c.irish_reg || '',
          c.vin || '',
          [c.make, c.model].filter(Boolean).join(' '),
          c.uk_vat,
          c.status,
          c.completed_at?.slice(0, 10) || '',
        ]
      })
    csv = rowsToCsv([
      'created_at', 'age_days', 'uk_reg', 'irish_reg', 'vin', 'vehicle',
      'uk_vat_gbp', 'car_status', 'completed_at',
    ], rows)
    filename = `outstanding-uk-vat-${today}.csv`
  } else {
    return NextResponse.json({
      success: false,
      error: `Unknown type "${type}". Use completed-ytd or outstanding-vat.`,
    }, { status: 400 })
  }

  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  })
}
