// GET /api/public/deposit/[token]   PUBLIC — no auth.
//
// Returns the data the public deposit page needs to render: car
// summary, deposit amount, T&Cs (current version), and current
// status. Used by the page on initial load and after a return-from-
// Revolut to show the latest state.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request, { params }) {
  const db = createServerClient()
  // The nested company_settings join lets the public page render
  // the per-location logo without a second round-trip. Buyer-facing
  // branding follows the car's location: a CCF Autos car shows CCF
  // Autos branding, a UN1T car shows UN1T's. Falls back to a plain
  // make/model header when no company_settings row exists.
  const { data: car } = await db
    .from('cars')
    .select(`
      id, make, model, vehicle_year, uk_reg, irish_reg,
      buyer_name,
      deposit_token, deposit_token_expires_at, deposit_amount, deposit_status,
      deposit_terms_accepted_at, deposit_paid_at, deposit_paid_amount,
      locations (
        id, name, car_deposit_terms, car_deposit_terms_version,
        company_settings ( logo_url, favicon_url, company_name )
      )
    `)
    .eq('deposit_token', params.token)
    .maybeSingle()

  if (!car) {
    return NextResponse.json({ success: false, error: 'Invalid deposit link' }, { status: 404 })
  }

  // Token expiry — paid deposits stay viewable indefinitely so the
  // buyer can come back to their receipt. Unpaid expired tokens
  // return 410 Gone with a specific code so the UI can show a
  // 'link expired, please ask for a new one' state.
  if (car.deposit_status !== 'paid' && car.deposit_token_expires_at) {
    if (new Date(car.deposit_token_expires_at).getTime() <= Date.now()) {
      return NextResponse.json({
        success: false,
        error: 'This payment link has expired. Please contact the dealer to reissue a new link.',
        code: 'TOKEN_EXPIRED',
      }, { status: 410 })
    }
  }

  const carLabel = [car.make, car.model, car.vehicle_year]
    .filter(Boolean).join(' ').trim() || 'Vehicle'
  // Buyer-facing — only show the Irish reg they'll actually drive
  // away with. UK reg is internal to our import workflow and would
  // confuse the buyer (or worse, look like a different car).
  const reg = car.irish_reg || null

  // company_settings is a 1-or-0 join — Postgres returns it as an
  // array because the FK direction (settings → location) is
  // many-side. Pluck the first row defensively.
  const settings = car.locations?.company_settings?.[0] || null

  return NextResponse.json({
    success: true,
    car: {
      id: car.id,
      label: carLabel,
      reg,
      buyer_name: car.buyer_name,
    },
    amount: Number(car.deposit_amount) || 500,
    currency: 'EUR',
    status: car.deposit_status,
    terms: {
      text: car.locations?.car_deposit_terms || null,
      version: car.locations?.car_deposit_terms_version || 1,
    },
    branding: settings
      ? {
          logo_url: settings.logo_url || null,
          company_name: settings.company_name || car.locations?.name || null,
        }
      : { logo_url: null, company_name: car.locations?.name || null },
    accepted_at: car.deposit_terms_accepted_at,
    paid_at: car.deposit_paid_at,
    paid_amount: car.deposit_paid_amount != null ? Number(car.deposit_paid_amount) : null,
  })
}
